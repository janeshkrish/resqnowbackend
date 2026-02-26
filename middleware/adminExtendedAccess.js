import { verifyAdmin } from "./auth.js";

function adminExtendedParseAllowedEmails() {
  return String(process.env.ADMIN_EXTENDED_ALLOWED_EMAILS || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function adminExtendedResolveAdminEmail(req) {
  return String(req.adminEmail || req.admin?.email || "").trim().toLowerCase();
}

function adminExtendedResolveAdminId(req) {
  const email = adminExtendedResolveAdminEmail(req);
  return String(req.admin?.id || email || "admin");
}

export function requireAdminExtendedAccess(req, res, next) {
  return verifyAdmin(req, res, () => {
    const allowedEmails = adminExtendedParseAllowedEmails();
    const adminEmail = adminExtendedResolveAdminEmail(req);

    if (allowedEmails.length > 0 && !allowedEmails.includes(adminEmail)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    req.adminExtended = {
      adminId: adminExtendedResolveAdminId(req),
      adminEmail,
    };

    return next();
  });
}

