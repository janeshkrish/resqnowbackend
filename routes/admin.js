import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import * as db from "../db.js";
import * as mail from "../mail.js";
import { addClient } from "../sse.js";
import { getAdminCredentials, signAdminToken, verifyAdmin } from "../middleware/auth.js";
import { canonicalizeServiceDomain, canonicalizeVehicleFamily } from "../services/serviceNormalization.js";
import { runDispatchMatrixAudit } from "../services/dispatchMatrixAudit.js";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "your-super-secret-key";

router.post("/login", (req, res) => {
  const { email, password } = req.body;
  const { email: adminEmail, password: adminPassword } = getAdminCredentials();
  if (!adminEmail || !adminPassword) {
    return res.status(503).json({ error: "Admin login is not configured." });
  }
  if ((email || "").trim().toLowerCase() !== adminEmail.trim().toLowerCase() || password !== adminPassword) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  const token = signAdminToken(adminEmail);
  return res.json({
    token,
    admin: { email: adminEmail, name: "Admin", role: "admin", id: "admin" },
  });
});

// --- Notifications ---

// 1. Get notifications stream (SSE)
router.get("/notifications/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  addClient(res);

  req.on("close", () => {
    // Client handling is done in sse.js, but we can log here if needed
  });
});

// 2. Get notification count (unread)
router.get("/notifications/count", verifyAdmin, async (req, res) => {
  try {
    const pool = await db.getPool();
    // Count unread notifications
    const [rows] = await pool.query("SELECT COUNT(*) as count FROM notifications WHERE is_read = 0");
    const unreadCount = rows[0]?.count || 0;

    // Also count pending technicians (legacy requirements)
    const [pendingRows] = await pool.query("SELECT COUNT(*) as count FROM technicians WHERE status = 'pending'");
    const pendingApplications = pendingRows[0]?.count || 0;

    // Return both for flexibility, but frontend mainly uses unreadCount for bell now
    return res.json({ count: unreadCount, pendingApplications });
  } catch (err) {
    console.error("[Admin notifications count]", err);
    return res.status(500).json({ error: "Failed to fetch notification count." });
  }
});

// 3. Get list of notifications (pagination)
router.get("/notifications", verifyAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const offset = parseInt(req.query.offset) || 0;

    const pool = await db.getPool();
    const [rows] = await pool.query(
      "SELECT * FROM notifications ORDER BY created_at DESC LIMIT ? OFFSET ?",
      [limit, offset]
    );

    return res.json(rows);
  } catch (err) {
    console.error("[Admin notifications list]", err);
    return res.status(500).json({ error: "Failed to fetch notifications." });
  }
});

// 4. Mark as read
router.post("/notifications/:id/read", verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const pool = await db.getPool();
    await pool.execute("UPDATE notifications SET is_read = 1 WHERE id = ?", [id]);
    return res.json({ success: true });
  } catch (err) {
    console.error("[Admin notification read]", err);
    return res.status(500).json({ error: "Failed to mark notification as read." });
  }
});

// --- Analytics ---
router.get("/analytics", verifyAdmin, async (req, res) => {
  try {
    const pool = await db.getPool();

    // 1. Totals
    const [techRows] = await pool.query("SELECT COUNT(*) AS totalTechnicians FROM technicians");
    const totalTechnicians = techRows[0]?.totalTechnicians || 0;

    const [userRows] = await pool.query("SELECT COUNT(*) AS totalUsers FROM users");
    const totalUsers = userRows[0]?.totalUsers || 0;

    const [reqRows] = await pool.query("SELECT COUNT(*) AS totalServiceRequests FROM service_requests");
    const totalServiceRequests = reqRows[0]?.totalServiceRequests || 0;

    const [revRows] = await pool.query("SELECT IFNULL(SUM(amount), 0) AS totalRevenue FROM service_requests WHERE status = 'completed'");
    const totalRevenue = parseFloat(revRows[0]?.totalRevenue || 0);

    console.log("[Analytics Debug] Fetched:", { totalTechnicians, totalUsers, totalServiceRequests, totalRevenue });

    // 2. Service Distribution
    const [distributionRows] = await pool.query("SELECT service_type as name, COUNT(*) as value FROM service_requests GROUP BY service_type");
    const serviceColors = {
      "Towing": "#ef4444",
      "Tire Fix": "#3b82f6",
      "Battery": "#22c55e",
      "Fuel": "#f59e0b",
      "Other": "#8b5cf6"
    };
    const serviceDistribution = distributionRows.map(row => ({
      name: row.name,
      value: row.value,
      color: serviceColors[row.name] || "#888888"
    }));

    // 3. Monthly Data (Last 6 months)
    const [techMonthly] = await pool.query(`
      SELECT DATE_FORMAT(created_at, '%b') as month, COUNT(*) as count 
      FROM technicians 
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
      GROUP BY DATE_FORMAT(created_at, '%Y-%m'), DATE_FORMAT(created_at, '%b')
      ORDER BY DATE_FORMAT(created_at, '%Y-%m')
    `);

    const [reqMonthly] = await pool.query(`
      SELECT DATE_FORMAT(created_at, '%b') as month, COUNT(*) as count 
      FROM service_requests 
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
      GROUP BY DATE_FORMAT(created_at, '%Y-%m'), DATE_FORMAT(created_at, '%b')
      ORDER BY DATE_FORMAT(created_at, '%Y-%m')
    `);

    // Merge monthly data
    // Create a map of last 6 months to ensure continuity if needed, or just merge existing
    const monthMap = new Map();
    // Initialize with data we have
    techMonthly.forEach(r => {
      if (!monthMap.has(r.month)) monthMap.set(r.month, { name: r.month, technicians: 0, requests: 0 });
      monthMap.get(r.month).technicians = r.count;
    });
    reqMonthly.forEach(r => {
      if (!monthMap.has(r.month)) monthMap.set(r.month, { name: r.month, technicians: 0, requests: 0 });
      monthMap.get(r.month).requests = r.count;
    });

    // Sort logic if needed, but the query ORDER BY should handle it mostly if we trust the order. 
    // Ideally we generate the specific months in order. For now, let's just use what returned.
    const monthlyData = Array.from(monthMap.values());

    // Fallback if empty
    if (monthlyData.length === 0) {
      const mos = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];
      const currentMonth = new Date().getMonth();
      for (let i = 5; i >= 0; i--) {
        const m = mos[(currentMonth - i + 12) % 12];
        monthlyData.push({ name: m, technicians: 0, requests: 0 });
      }
    }

    return res.json({
      totalTechnicians,
      totalUsers,
      totalServiceRequests,
      totalRevenue,
      monthlyData,
      serviceDistribution
    });

  } catch (err) {
    console.error("[Admin analytics]", err);
    return res.status(500).json({ error: "Failed to fetch analytics." });
  }
});

router.get("/dispatch-audit/:requestId", verifyAdmin, async (req, res) => {
  try {
    const requestId = Number(req.params.requestId);
    if (!Number.isFinite(requestId)) {
      return res.status(400).json({ error: "Invalid request id." });
    }

    const pool = await db.getPool();
    const [reqRows] = await pool.query("SELECT * FROM service_requests WHERE id = ? LIMIT 1", [requestId]);
    const requestRow = reqRows?.[0];
    if (!requestRow) {
      return res.status(404).json({ error: "Service request not found." });
    }

    const [technicianRows] = await pool.query("SELECT * FROM technicians");
    const [offerRows] = await pool.query(
      "SELECT technician_id, status, sent_at, expires_at FROM dispatch_offers WHERE service_request_id = ?",
      [requestId]
    );
    const offerMap = new Map((offerRows || []).map((o) => [String(o.technician_id), o]));

    const { jobDispatchService } = await import("../services/jobDispatchService.js");
    const { criteria, analysis, reasonCounts } = jobDispatchService.analyzeTechnicians(
      {
        id: requestRow.id,
        location_lat: requestRow.location_lat,
        location_lng: requestRow.location_lng,
        service_type: requestRow.service_type,
        vehicle_type: requestRow.vehicle_type,
        address: requestRow.address
      },
      technicianRows,
      null
    );

    const enriched = analysis
      .map((row) => {
        const offer = offerMap.get(String(row.technicianId));
        return {
          technician_id: row.technicianId,
          name: row.name,
          status: row.status,
          is_active: row.is_active,
          is_available: row.is_available,
          service_type: row.service_type,
          vehicle_types: row.vehicle_types,
          service_area_range: row.service_area_range,
          distance_km: Number.isFinite(Number(row.distanceKm)) ? Number(Number(row.distanceKm).toFixed(2)) : null,
          eligible: row.eligible,
          reject_reasons: row.reasons,
          matched_domain: row.matchedDomain,
          matched_vehicle: row.matchedVehicle,
          technician_domains: row.technicianDomains,
          technician_vehicles: row.technicianVehicles,
          dispatch_offer_status: offer?.status || null,
          dispatch_offer_sent_at: offer?.sent_at || null,
          dispatch_offer_expires_at: offer?.expires_at || null
        };
      })
      .sort((a, b) => {
        if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
        const da = Number.isFinite(Number(a.distance_km)) ? Number(a.distance_km) : Number.POSITIVE_INFINITY;
        const dbv = Number.isFinite(Number(b.distance_km)) ? Number(b.distance_km) : Number.POSITIVE_INFINITY;
        return da - dbv;
      });

    const summary = {
      total_technicians: enriched.length,
      eligible_count: enriched.filter((r) => r.eligible).length,
      rejected_count: enriched.filter((r) => !r.eligible).length,
      rejection_reason_counts: reasonCounts
    };

    return res.json({
      request: {
        id: requestRow.id,
        status: requestRow.status,
        service_type: requestRow.service_type,
        vehicle_type: requestRow.vehicle_type,
        canonical_service_domain: canonicalizeServiceDomain(String(requestRow.service_type || "").replace(/^(car|bike|ev|commercial)-/i, "")),
        canonical_vehicle_type: canonicalizeVehicleFamily(requestRow.vehicle_type || String(requestRow.service_type || "").split("-")[0]),
        address: requestRow.address,
        location_lat: requestRow.location_lat,
        location_lng: requestRow.location_lng,
        created_at: requestRow.created_at
      },
      criteria,
      summary,
      technicians: enriched
    });
  } catch (err) {
    console.error("[Admin dispatch audit]", err);
    return res.status(500).json({ error: "Failed to generate dispatch audit." });
  }
});

router.get("/dispatch-matrix-audit", verifyAdmin, async (req, res) => {
  try {
    const parseList = (value) =>
      String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

    const parseBool = (value, fallback = false) => {
      if (value == null || value === "") return fallback;
      const normalized = String(value).trim().toLowerCase();
      return normalized === "1" || normalized === "true" || normalized === "yes";
    };

    const serviceDomains = parseList(req.query.service_domains);
    const vehicleTypes = parseList(req.query.vehicle_types);
    const simulateReady = parseBool(req.query.simulate_ready, false);
    const includePassing = parseBool(req.query.include_passing, true);

    const report = await runDispatchMatrixAudit({
      serviceDomains: serviceDomains.length > 0 ? serviceDomains : undefined,
      vehicleTypes: vehicleTypes.length > 0 ? vehicleTypes : undefined,
      simulateReady,
    });

    if (!includePassing) {
      return res.json({
        ...report,
        matrix: report.missing_coverage,
      });
    }

    return res.json(report);
  } catch (err) {
    console.error("[Admin dispatch matrix audit]", err);
    return res.status(500).json({ error: "Failed to generate dispatch matrix audit." });
  }
});

router.post("/dispatch-retry/:requestId", verifyAdmin, async (req, res) => {
  try {
    const requestId = Number(req.params.requestId);
    if (!Number.isFinite(requestId)) {
      return res.status(400).json({ error: "Invalid request id." });
    }

    const pool = await db.getPool();
    const [reqRows] = await pool.query("SELECT * FROM service_requests WHERE id = ? LIMIT 1", [requestId]);
    const requestRow = reqRows?.[0];
    if (!requestRow) {
      return res.status(404).json({ error: "Service request not found." });
    }

    if (requestRow.technician_id) {
      return res.status(400).json({ error: "Request already assigned to a technician." });
    }
    if (String(requestRow.status || "").toLowerCase() !== "pending") {
      return res.status(400).json({ error: "Only pending requests can be re-dispatched." });
    }

    const [beforeOffers] = await pool.query(
      "SELECT id, technician_id, status, sent_at FROM dispatch_offers WHERE service_request_id = ?",
      [requestId]
    );
    const beforeOfferIds = new Set((beforeOffers || []).map((o) => Number(o.id)));

    const { jobDispatchService } = await import("../services/jobDispatchService.js");
    const candidates = await jobDispatchService.findTopTechnicians(requestRow, null);
    await jobDispatchService.dispatchJob(requestRow, candidates);

    const [afterOffers] = await pool.query(
      "SELECT id, technician_id, status, sent_at FROM dispatch_offers WHERE service_request_id = ? ORDER BY id DESC",
      [requestId]
    );
    const newlyCreatedOffers = (afterOffers || []).filter((o) => !beforeOfferIds.has(Number(o.id)));

    return res.json({
      success: true,
      request: {
        id: requestRow.id,
        status: requestRow.status,
        service_type: requestRow.service_type,
        vehicle_type: requestRow.vehicle_type,
      },
      candidates_found: candidates.length,
      offers_before: (beforeOffers || []).length,
      offers_after: (afterOffers || []).length,
      new_offers_created: newlyCreatedOffers.length,
      new_offers: newlyCreatedOffers.map((o) => ({
        id: o.id,
        technician_id: o.technician_id,
        status: o.status,
        sent_at: o.sent_at,
      })),
    });
  } catch (err) {
    console.error("[Admin dispatch retry]", err);
    return res.status(500).json({ error: "Failed to retry dispatch." });
  }
});

// --- Technician management (admin only) ---

router.get("/technicians", verifyAdmin, async (req, res) => {
  try {
    const status = (req.query.status || "").toLowerCase();
    let rows;
    if (status === "pending" || status === "approved" || status === "rejected") {
      rows = await db.query("SELECT * FROM technicians WHERE status = ? ORDER BY created_at DESC", [status]);
    } else {
      rows = await db.query("SELECT * FROM technicians ORDER BY created_at DESC");
    }
    // Using simple mapping here to avoid dependency on rowToTechnician from technicians.js
    // Or we could duplicate the mapper or move it to a shared util.
    // For now, let's just return raw rows or minimal map, frontend expects specific fields.
    // Actually, let's replicate the mapper roughly or select specific fields.
    return res.json(rows);
  } catch (err) {
    console.error("[Admin technicians list]", err);
    return res.status(500).json({ error: "Failed to fetch technicians." });
  }
});

router.put("/technicians/:id", verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { name, email, phone, service_type, status } = req.body;
    const trimmedName = (name || "").trim();
    const normalizedEmail = (email || "").trim().toLowerCase();

    if (!trimmedName || !normalizedEmail) {
      return res.status(400).json({ error: "Name and email are required." });
    }

    const pool = await db.getPool();

    // Check if technician exists
    const [existing] = await pool.query("SELECT id FROM technicians WHERE id = ?", [id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: "Technician not found." });
    }

    // Check unique email if changed
    const [emailCheck] = await pool.query("SELECT id FROM technicians WHERE email = ? AND id != ?", [normalizedEmail, id]);
    if (emailCheck.length > 0) {
      return res.status(409).json({ error: "Email already in use by another technician." });
    }

    await pool.execute(
      "UPDATE technicians SET name = ?, email = ?, phone = ?, service_type = ?, status = ? WHERE id = ?",
      [trimmedName, normalizedEmail, phone, service_type, status, id]
    );

    return res.json({ message: "Technician updated successfully.", id });
  } catch (err) {
    console.error("[Admin update technician]", err);
    return res.status(500).json({ error: "Failed to update technician." });
  }
});

router.delete("/technicians/:id", verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const pool = await db.getPool();
    const [result] = await pool.execute("DELETE FROM technicians WHERE id = ?", [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Technician not found." });
    }
    return res.json({ message: "Technician deleted successfully." });
  } catch (err) {
    console.error("[Admin delete technician]", err);
    return res.status(500).json({ error: "Failed to delete technician." });
  }
});

// --- User management (admin only) ---

router.get("/users", verifyAdmin, async (req, res) => {
  try {
    const rows = await db.query(
      "SELECT id, full_name, email, email_confirmed, created_at FROM users ORDER BY created_at DESC"
    );
    return res.json(rows.map((r) => ({
      id: r.id,
      full_name: r.full_name,
      email: r.email,
      email_confirmed: Boolean(r.email_confirmed),
      created_at: r.created_at,
    })));
  } catch (err) {
    console.error("[Admin users list]", err);
    return res.status(500).json({ error: "Failed to fetch users." });
  }
});

router.post("/users", verifyAdmin, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const normalizedEmail = (email || "").trim().toLowerCase();
    const trimmedName = (name || "").trim();
    if (!trimmedName || !normalizedEmail || !password) {
      return res.status(400).json({ error: "Name, email and password are required." });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }
    const existing = await db.query("SELECT id FROM users WHERE email = ? LIMIT 1", [normalizedEmail]);
    if (existing.length > 0) {
      return res.status(409).json({ error: "A user with this email already exists." });
    }
    const password_hash = await bcrypt.hash(password, 10);
    const pool = await db.getPool();
    const [insertResult] = await pool.execute(
      "INSERT INTO users (full_name, email, password_hash, status) VALUES (?, ?, ?, 'approved')",
      [trimmedName, normalizedEmail, password_hash]
    );
    const insertId = insertResult.insertId;
    if (insertId != null) {
      const confirmationToken = jwt.sign({ userId: insertId, email: normalizedEmail }, JWT_SECRET, { expiresIn: "1d" });
      const confirmationUrl = `${process.env.FRONTEND_URL || "http://172.20.10.3:8080"}/confirm-email?token=${encodeURIComponent(confirmationToken)}`;
      try {
        await mail.sendMail({
          to: normalizedEmail,
          subject: "Confirm Your Email for ResQNow",
          html: `Hello ${trimmedName},<br><br>An admin created an account for you. Please click the link below to confirm your email:<br><br><a href="${confirmationUrl}">Confirm Email</a><br><br>This link expires in 24 hours.<br><br>Regards,<br>ResQNow Team`,
        });
      } catch (mailErr) {
        console.error("[Admin add user confirmation email failed]", mailErr?.message || mailErr);
      }
    }
    return res.status(201).json({
      id: insertId,
      full_name: trimmedName,
      email: normalizedEmail,
      message: "User created. A confirmation email has been sent.",
    });
  } catch (err) {
    console.error("[Admin add user]", err);
    return res.status(500).json({ error: "Failed to create user." });
  }
});

router.put("/users/:id", verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { name, password } = req.body;
    const trimmedName = (name || "").trim();

    if (!trimmedName) {
      return res.status(400).json({ error: "Name is required." });
    }

    const pool = await db.getPool();
    const [existing] = await pool.query("SELECT id FROM users WHERE id = ?", [id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    if (password && password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    if (password) {
      const password_hash = await bcrypt.hash(password, 10);
      await pool.execute(
        "UPDATE users SET full_name = ?, password_hash = ? WHERE id = ?",
        [trimmedName, password_hash, id]
      );
    } else {
      await pool.execute(
        "UPDATE users SET full_name = ? WHERE id = ?",
        [trimmedName, id]
      );
    }

    return res.json({ message: "User updated successfully.", id, full_name: trimmedName });
  } catch (err) {
    console.error("[Admin update user]", err);
    return res.status(500).json({ error: "Failed to update user." });
  }
});

router.delete("/users/:id", verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const pool = await db.getPool();
    const [result] = await pool.execute("DELETE FROM users WHERE id = ?", [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "User not found." });
    }
    return res.status(200).json({ message: "User deleted." });
  } catch (err) {
    console.error("[Admin delete user]", err);
    return res.status(500).json({ error: "Failed to delete user." });
  }
});

export default router;
