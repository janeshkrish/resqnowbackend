import jwt from "jsonwebtoken";

function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || "").trim();
  if (!secret) {
    throw new Error("JWT_SECRET is not configured.");
  }
  return secret;
}

export function verifyTechnician(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    console.log("[Auth] No token provided");
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const payload = jwt.verify(auth.slice(7), getJwtSecret());
    // console.log("[Auth] Payload:", payload);
    if (payload.type !== "technician") {
      console.log(`[Auth] Forbidden: Expected technician, got ${payload.type}`);
      return res.status(403).json({ error: "Forbidden" });
    }
    req.technicianId = payload.id;
    req.technicianEmail = payload.email;
    next();
  } catch (err) {
    console.log("[Auth] Token verification failed:", err.message);
    if (err.message === "JWT_SECRET is not configured.") {
      return res.status(500).json({ error: "Server auth is not configured." });
    }
    return res.status(401).json({ error: "Unauthorized" });
  }
}

export function verifyUser(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const payload = jwt.verify(auth.slice(7), getJwtSecret());
    if (payload.type !== "user") {
      // Optional: STRICT check for type='user'
      // return res.status(403).json({ error: "Forbidden" });
    }
    req.user = payload;
    next();
  } catch (err) {
    if (err.message === "JWT_SECRET is not configured.") {
      return res.status(500).json({ error: "Server auth is not configured." });
    }
    return res.status(401).json({ error: "Unauthorized" });
  }
}

export function verifyAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const payload = jwt.verify(auth.slice(7), getJwtSecret());
    if (payload.type !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }
    req.adminEmail = payload.email;
    next();
  } catch (err) {
    if (err.message === "JWT_SECRET is not configured.") {
      return res.status(500).json({ error: "Server auth is not configured." });
    }
    return res.status(401).json({ error: "Unauthorized" });
  }
}

export function getAdminCredentials() {
  return {
    email: process.env.ADMIN_EMAIL || "",
    password: process.env.ADMIN_PASSWORD || "",
  };
}

export function signTechnicianToken(id, email) {
  return jwt.sign({ id, email, type: "technician" }, getJwtSecret(), { expiresIn: "7d" });
}

export function signAdminToken(email) {
  return jwt.sign({ email, type: "admin" }, getJwtSecret(), { expiresIn: "1d" });
}
