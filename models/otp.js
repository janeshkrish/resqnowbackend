const OTP_MAX_REQUESTS_PER_HOUR = 3;
const OTP_COOLDOWN_SECONDS = 60;
const OTP_HOUR_WINDOW_SECONDS = 60 * 60;

function toEpochMs(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isNaN(ms) ? null : ms;
}

export async function enforceOtpRateLimit(pool, normalizedEmail, now = new Date()) {
  const nowMs = now.getTime();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // Ensure a row exists for this email before locking it.
    await connection.execute(
      `INSERT INTO otp_requests (email, otp_request_count, otp_last_request_time, otp_window_start_time)
       VALUES (?, 0, NULL, NULL)
       ON DUPLICATE KEY UPDATE email = VALUES(email)`,
      [normalizedEmail]
    );

    const [rows] = await connection.query(
      `SELECT id, otp_request_count, otp_last_request_time, otp_window_start_time
       FROM otp_requests
       WHERE email = ?
       LIMIT 1
       FOR UPDATE`,
      [normalizedEmail]
    );

    const row = rows[0] || {};
    let count = Number(row.otp_request_count || 0);
    const lastRequestMs = toEpochMs(row.otp_last_request_time);
    let windowStartMs = toEpochMs(row.otp_window_start_time);

    if (windowStartMs == null) {
      windowStartMs = lastRequestMs ?? nowMs;
    }

    if (lastRequestMs != null) {
      const secondsSinceLastRequest = Math.floor((nowMs - lastRequestMs) / 1000);
      if (secondsSinceLastRequest < OTP_COOLDOWN_SECONDS) {
        const retryAfterSeconds = OTP_COOLDOWN_SECONDS - secondsSinceLastRequest;
        await connection.rollback();
        return {
          allowed: false,
          retryAfterSeconds,
          error: `Please wait ${retryAfterSeconds} seconds before requesting another OTP.`,
        };
      }
    }

    const windowElapsedSeconds = Math.floor((nowMs - windowStartMs) / 1000);
    if (windowElapsedSeconds >= OTP_HOUR_WINDOW_SECONDS) {
      count = 0;
      windowStartMs = nowMs;
    }

    if (count >= OTP_MAX_REQUESTS_PER_HOUR) {
      const retryAfterSeconds = Math.max(1, OTP_HOUR_WINDOW_SECONDS - windowElapsedSeconds);
      await connection.rollback();
      return {
        allowed: false,
        retryAfterSeconds,
        error: "Too many OTP requests. Please try again later.",
      };
    }

    const nextCount = count + 1;
    await connection.execute(
      `UPDATE otp_requests
       SET otp_request_count = ?, otp_last_request_time = ?, otp_window_start_time = ?
       WHERE email = ?`,
      [nextCount, now, new Date(windowStartMs), normalizedEmail]
    );

    await connection.commit();
    return {
      allowed: true,
      otpRequestId: row.id,
      requestCount: nextCount,
      lastRequestTime: now,
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // ignore rollback errors; original error is more important.
    }
    throw error;
  } finally {
    connection.release();
  }
}

