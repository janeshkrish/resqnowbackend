import { Router } from "express";
import { verifyTechnician } from "../middleware/auth.js";
import { jobDispatchService } from "../services/jobDispatchService.js";
import * as db from "../db.js";
import { socketService } from "../services/socket.js";

const router = Router();

/**
 * POST /api/jobs/accept
 * Accept a job offer using body payload: { jobId } or { requestId }.
 */
router.post("/accept", verifyTechnician, async (req, res) => {
    try {
        const technicianId = req.technicianId;
        const requestId = String(
            req.body?.jobId || req.body?.requestId || req.body?.id || ""
        ).trim();

        if (!requestId) {
            return res.status(400).json({ error: "jobId or requestId is required." });
        }

        const result = await jobDispatchService.acceptJob(technicianId, requestId);
        if (!result.success) {
            if (result.code === "not_found") {
                return res.status(404).json({ error: result.reason || "Job not found." });
            }
            if (result.code === "technician_not_found") {
                return res.status(404).json({ error: result.reason || "Technician not found." });
            }
            return res.status(409).json({ error: result.reason || "Job already taken." });
        }

        return res.json({
            success: true,
            idempotent: !!result.idempotent,
            request: result.job,
            job: result.job,
        });
    } catch (error) {
        console.error("[Jobs Accept] Error:", error);
        return res.status(500).json({ error: "Failed to accept job." });
    }
});

/**
 * POST /api/jobs/complete
 * Complete a technician job and mark payment as paid.
 * Body payload: { jobId } or { requestId }.
 */
router.post("/complete", verifyTechnician, async (req, res) => {
    const technicianId = Number(req.technicianId);
    const requestId = Number(
        req.body?.jobId || req.body?.requestId || req.body?.id || 0
    );

    if (!Number.isInteger(technicianId) || technicianId <= 0) {
        return res.status(401).json({ error: "Unauthorized technician." });
    }
    if (!Number.isInteger(requestId) || requestId <= 0) {
        return res.status(400).json({ error: "jobId or requestId is required." });
    }

    const pool = await db.getPool();
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [requestRows] = await conn.query(
            "SELECT * FROM service_requests WHERE id = ? FOR UPDATE",
            [requestId]
        );
        if (!Array.isArray(requestRows) || requestRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ error: "Job not found." });
        }

        const request = requestRows[0];
        if (Number(request.technician_id) !== technicianId) {
            await conn.rollback();
            return res.status(403).json({ error: "This job is not assigned to you." });
        }

        const currentStatus = String(request.status || "").trim().toLowerCase();
        if (["cancelled", "rejected"].includes(currentStatus)) {
            await conn.rollback();
            return res.status(409).json({ error: `Job is already ${currentStatus}.` });
        }

        const baseAmountRaw = Number(request.amount ?? request.service_charge ?? 0);
        const baseAmount = Number.isFinite(baseAmountRaw) && baseAmountRaw > 0 ? baseAmountRaw : 0;

        await conn.query(
            `UPDATE service_requests
             SET status = 'completed',
                 payment_status = 'paid',
                 completed_at = COALESCE(completed_at, NOW()),
                 updated_at = NOW()
             WHERE id = ?`,
            [requestId]
        );

        const [paymentRows] = await conn.query(
            "SELECT id FROM payments WHERE service_request_id = ? ORDER BY id DESC LIMIT 1 FOR UPDATE",
            [requestId]
        );
        if (Array.isArray(paymentRows) && paymentRows.length > 0) {
            await conn.query(
                `UPDATE payments
                 SET status = 'completed',
                     payment_method = COALESCE(NULLIF(payment_method, ''), 'cash'),
                     amount = ?,
                     platform_fee = COALESCE(platform_fee, 0),
                     technician_amount = ?,
                     is_settled = TRUE
                 WHERE id = ?`,
                [baseAmount, baseAmount, paymentRows[0].id]
            );
        } else {
            await conn.query(
                `INSERT INTO payments
                 (user_id, service_request_id, payment_method, status, amount, platform_fee, technician_amount, is_settled)
                 VALUES (?, ?, 'cash', 'completed', ?, 0, ?, TRUE)`,
                [request.user_id, requestId, baseAmount, baseAmount]
            );
        }

        await conn.query(
            `UPDATE technicians
             SET current_job_id = NULL,
                 jobs_completed = jobs_completed + 1,
                 total_earnings = total_earnings + ?,
                 is_available = CASE WHEN is_active = TRUE THEN TRUE ELSE FALSE END
             WHERE id = ?`,
            [baseAmount, technicianId]
        );

        await conn.commit();

        socketService.notifyTechnician(technicianId, "job:status_update", {
            requestId,
            status: "completed"
        });
        socketService.notifyTechnician(technicianId, "job:list_update", {
            requestId,
            action: "updated"
        });
        if (request.user_id) {
            socketService.notifyUser(request.user_id, "job:status_update", {
                requestId,
                status: "completed"
            });
        }

        return res.json({
            success: true,
            message: "Job completed successfully.",
            request: {
                id: requestId,
                status: "completed",
                payment_status: "paid",
                amount: baseAmount
            }
        });
    } catch (error) {
        await conn.rollback();
        console.error("[Jobs Complete] Error:", error);
        return res.status(500).json({ error: "Failed to complete job." });
    } finally {
        conn.release();
    }
});

export default router;

