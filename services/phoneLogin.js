import admin from "firebase-admin";

// Customers log in with their mobile number: Firebase sends the SMS code and checks it on
// the phone, then the app hands us Firebase's ID token. We check that token here, find or
// create the customer by the verified number, and answer with our own login token, exactly
// as the email and Google logins do.

const NAME_MAX_LENGTH = 80;

export class PhoneLoginError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The verified number as Firebase gives it (+919876543210), or "" when it is not one. */
export function normalizeE164(value) {
  const text = String(value || "").trim();
  return /^\+[1-9]\d{6,14}$/.test(text) ? text : "";
}

/** The name a new customer typed, tidied; "" when there is none. */
export function cleanName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isDuplicateEntry(error) {
  return error?.code === "ER_DUP_ENTRY" || error?.errno === 1062;
}

/** Checks a Firebase ID token with the Admin SDK that also sends push notifications. */
export async function verifyFirebaseIdToken(idToken) {
  // Firebase Admin is set up once, by the notification service, from the same settings.
  await import("./notificationService.js");
  if (admin.apps.length === 0) {
    throw new PhoneLoginError(503, "Phone login is not available right now. Please use Google or email.");
  }
  return admin.auth().verifyIdToken(idToken);
}

async function findCustomer(pool, uid, phone) {
  const [rows] = await pool.query(
    `SELECT id, full_name, email, phone, phone_e164, firebase_uid
     FROM users
     WHERE firebase_uid = ? OR phone_e164 = ?
     ORDER BY (firebase_uid = ?) DESC
     LIMIT 1`,
    [uid, phone, uid]
  );
  return rows[0] || null;
}

/**
 * POST /api/users/phone-login  { idToken, name? }
 * A known number logs straight in. A new number gets { needsName: true } until the app sends
 * the name with the same token; only then is the account made.
 */
export async function handlePhoneLogin(req, res, deps = {}) {
  const verifyIdToken = deps.verifyIdToken || verifyFirebaseIdToken;
  const getPool = deps.getPool;
  const signToken = deps.signToken;

  try {
    const idToken = String(req.body?.idToken || "").trim();
    if (!idToken) {
      return res.status(400).json({ error: "Missing sign-in token." });
    }

    let decoded;
    try {
      decoded = await verifyIdToken(idToken);
    } catch (error) {
      if (error instanceof PhoneLoginError) throw error;
      console.warn("[AUTH PHONE] Token check failed:", error?.code || error?.message || error);
      return res.status(401).json({ error: "We could not confirm your number. Please try again." });
    }

    const phone = normalizeE164(decoded?.phone_number);
    const uid = String(decoded?.uid || "").trim();
    if (!phone || !uid || decoded?.firebase?.sign_in_provider !== "phone") {
      return res.status(401).json({ error: "We could not confirm your number. Please try again." });
    }

    const pool = await getPool();
    let customer = await findCustomer(pool, uid, phone);
    let isNew = false;

    if (customer) {
      if (customer.firebase_uid !== uid || customer.phone_e164 !== phone) {
        await pool.execute(
          "UPDATE users SET firebase_uid = ?, phone_e164 = ?, is_verified = 1 WHERE id = ?",
          [uid, phone, customer.id]
        );
      }
    } else {
      const name = cleanName(req.body?.name);
      if (!name) {
        return res.json({ needsName: true, phone });
      }
      if (name.length > NAME_MAX_LENGTH) {
        return res.status(400).json({ error: `Please keep your name under ${NAME_MAX_LENGTH} letters.` });
      }
      try {
        const [result] = await pool.execute(
          `INSERT INTO users (full_name, email, phone, phone_e164, firebase_uid, role, is_verified, status)
           VALUES (?, NULL, ?, ?, ?, 'user', 1, 'approved')`,
          [name, phone, phone, uid]
        );
        customer = { id: result.insertId, full_name: name, email: null, phone };
        isNew = true;
      } catch (error) {
        // Two taps at once: the other one made the account, so use it.
        if (!isDuplicateEntry(error)) throw error;
        customer = await findCustomer(pool, uid, phone);
        if (!customer) throw error;
      }
    }

    const token = signToken(customer.id, customer.email || null);
    console.log(`[AUTH PHONE] ✅ ${isNew ? "New customer" : "Login"} #${customer.id}`);

    return res.status(isNew ? 201 : 200).json({
      token,
      role: "user",
      isNew,
      user: {
        id: customer.id,
        name: customer.full_name,
        email: customer.email || "",
        phone: customer.phone || phone,
        isVerified: true,
        role: "user",
      },
    });
  } catch (error) {
    if (error instanceof PhoneLoginError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error("[AUTH PHONE] Error:", error);
    return res.status(500).json({ error: "Login failed. Please try again." });
  }
}
