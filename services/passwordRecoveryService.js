import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const MESSAGE = { message: 'If this account has a verified recovery email, a password reset link will be sent. Check your inbox and spam folder.' };
const normalizeEmail = value => String(value || '').trim().toLowerCase();
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const error = (message = 'This link is invalid or expired. Request a new link.', statusCode = 400) => Object.assign(new Error(message), { statusCode });
const tableFor = role => { if (role === 'user') return 'users'; if (role === 'technician') return 'technicians'; throw error('Invalid account type.'); };
const realEmail = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !email.endsWith('@resqnow.invalid') && email.length <= 255;
const eligible = account => account?.password_hash && realEmail(normalizeEmail(account.email));
const verified = account => eligible(account) && account.recovery_email_verified_at && normalizeEmail(account.recovery_email) === normalizeEmail(account.email);

export function validateRecoveryPassword(password) {
  if (typeof password !== 'string' || password.trim().length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    throw error('Use at least 12 nonblank characters and no more than 72 UTF-8 bytes.');
  }
}

export function recoveryLink(role, purpose, token, frontendUrl) {
  tableFor(role);
  const url = new URL(frontendUrl);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Password recovery requires a trusted HTTPS frontend origin.');
  }
  if (!['password_reset', 'verify_email'].includes(purpose) || !/^[a-f0-9]{64}$/.test(token)) throw error();
  url.pathname = `${role === 'technician' ? '/technician' : ''}/${purpose === 'password_reset' ? 'reset-password' : 'verify-recovery-email'}`;
  url.hash = `token=${token}`;
  return url.toString();
}

export function createPasswordRecoveryService({ getPool, frontendUrl, sendMail, revokeSessions = async () => {}, onDeliveryError = () => {} }) {
  async function transaction(action) {
    const conn = await (await getPool()).getConnection();
    try { await conn.beginTransaction(); const result = await action(conn); await conn.commit(); return result; }
    catch (failure) { await conn.rollback(); throw failure; }
    finally { conn.release(); }
  }
  // Durable limits commit independently, including on invalid credentials/tokens.
  async function takeLimit(scope, key, max, windowSeconds, cooldown = 0) {
    return transaction(async conn => {
      const bucket = digest(`${scope}:${key}`);
      await conn.execute('INSERT INTO recovery_rate_limits (bucket_key, request_count, window_started_at) VALUES (?, 0, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE bucket_key = bucket_key', [bucket]);
      const [[row]] = await conn.query('SELECT *, TIMESTAMPDIFF(SECOND, window_started_at, UTC_TIMESTAMP(3)) AS age_seconds, TIMESTAMPDIFF(SECOND, last_request_at, UTC_TIMESTAMP(3)) AS since_last_seconds FROM recovery_rate_limits WHERE bucket_key = ? FOR UPDATE', [bucket]);
      const reset = Number(row.age_seconds) >= windowSeconds;
      if (!reset && (Number(row.request_count) >= max || (row.last_request_at != null && Number(row.since_last_seconds) < cooldown))) return false;
      await conn.execute('UPDATE recovery_rate_limits SET request_count = ?, window_started_at = IF(?, UTC_TIMESTAMP(3), window_started_at), last_request_at = UTC_TIMESTAMP(3) WHERE bucket_key = ?', [reset ? 1 : Number(row.request_count) + 1, reset, bucket]);
      return true;
    });
  }
  async function limitIp(ip, confirm = false) {
    if (!await takeLimit(confirm ? 'confirm-ip' : 'request-ip', String(ip || 'unknown'), confirm ? 30 : 10, 900)) throw error('Too many attempts. Please try again later.', 429);
  }
  function deliver(mail) {
    // No tokens, email bodies, or delivery errors containing provider request data in logs.
    void Promise.resolve().then(() => sendMail(mail)).catch(() => onDeliveryError());
  }
  async function account(conn, role, id, lock = false) {
    const [[row]] = await conn.query(`SELECT * FROM ${tableFor(role)} WHERE id = ?${role === 'user' ? " AND COALESCE(role, 'user') = 'user'" : ''}${lock ? ' FOR UPDATE' : ''}`, [id]);
    return row;
  }
  async function issue(conn, role, row, purpose) {
    const token = crypto.randomBytes(32).toString('hex');
    const link = recoveryLink(role, purpose, token, frontendUrl);
    await conn.execute('UPDATE password_recovery_tokens SET consumed_at = UTC_TIMESTAMP(3) WHERE account_id = ? AND account_role = ? AND purpose = ? AND consumed_at IS NULL', [row.id, role, purpose]);
    await conn.execute('INSERT INTO password_recovery_tokens (account_id, account_role, purpose, token_hash, email, auth_version, expires_at) VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 15 MINUTE))', [row.id, role, purpose, digest(token), normalizeEmail(row.email), Number(row.auth_version || 0)]);
    return { kind: purpose, to: normalizeEmail(row.email), role, link };
  }
  async function resolveChallenge(conn, role, token, purpose) {
    tableFor(role);
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw error();
    const args = [digest(token), role, purpose];
    const [[candidate]] = await conn.query('SELECT * FROM password_recovery_tokens WHERE token_hash = ? AND account_role = ? AND purpose = ?', args);
    if (!candidate) throw error();
    // Consistent lock ordering with resends and simultaneous reset/verification.
    const row = await account(conn, role, candidate.account_id, true);
    const [[challenge]] = await conn.query('SELECT *, expires_at > UTC_TIMESTAMP(3) AS unexpired FROM password_recovery_tokens WHERE token_hash = ? AND account_role = ? AND purpose = ? FOR UPDATE', args);
    if (!eligible(row) || !challenge || !challenge.unexpired || challenge.consumed_at != null ||
        normalizeEmail(row.email) !== challenge.email || Number(row.auth_version || 0) !== Number(challenge.auth_version)) throw error();
    return { row, challenge };
  }
  return {
    async request({ role, email, ip }) {
      tableFor(role); await limitIp(ip);
      email = normalizeEmail(email);
      if (!await takeLimit(`request-${role}`, email.slice(0, 256), 3, 3600, 60)) return { ...MESSAGE };
      if (!realEmail(email)) return { ...MESSAGE };
      const mail = await transaction(async conn => {
        const [[candidate]] = await conn.query(`SELECT id FROM ${tableFor(role)} WHERE LOWER(TRIM(email)) = ?${role === 'user' ? " AND COALESCE(role, 'user') = 'user'" : ''}`, [email]);
        // Lock only the account's primary key; a normalization scan with FOR
        // UPDATE could otherwise lock unrelated accounts or an email range.
        const row = candidate ? await account(conn, role, candidate.id, true) : null;
        return verified(row) && normalizeEmail(row.email) === email ? issue(conn, role, row, 'password_reset') : null;
      });
      if (mail) deliver(mail);
      return { ...MESSAGE };
    },
    async confirm({ role, token, password, ip }) {
      tableFor(role); await limitIp(ip, true); validateRecoveryPassword(password);
      const row = await transaction(async conn => {
        const { row } = await resolveChallenge(conn, role, token, 'password_reset');
        if (!verified(row)) throw error();
        const passwordHash = await bcrypt.hash(password, 12);
        const [result] = await conn.execute(`UPDATE ${tableFor(role)} SET password_hash = ?, auth_version = auth_version + 1 WHERE id = ? AND auth_version = ?`, [passwordHash, row.id, Number(row.auth_version || 0)]);
        if (result.affectedRows !== 1) throw error();
        await conn.execute('UPDATE password_recovery_tokens SET consumed_at = UTC_TIMESTAMP(3) WHERE account_id = ? AND account_role = ? AND consumed_at IS NULL', [row.id, role]);
        await conn.execute('DELETE FROM device_tokens WHERE user_id = ? AND user_type = ?', [row.id, role]);
        return row;
      });
      // Persisted session versions remain authoritative if cross-node delivery fails.
      try { await revokeSessions(role, row.id); } catch { onDeliveryError(); }
      deliver({ kind: 'password_changed', to: normalizeEmail(row.email), role });
      return { message: 'Password updated. Sign in with your new password. Other sessions have been signed out.' };
    },
    async status({ role, accountId }) {
      return transaction(async conn => {
        const row = await account(conn, role, accountId);
        if (!row) throw error('Please sign in again.', 401);
        return { email: realEmail(normalizeEmail(row.email)) ? row.email : null, hasPassword: Boolean(row.password_hash), verified: Boolean(verified(row)) };
      });
    },
    async verificationRequest({ role, accountId, currentPassword, ip }) {
      tableFor(role); await limitIp(ip);
      if (!await takeLimit(`enroll-${role}`, String(accountId), 3, 3600, 60)) throw error('Please wait before requesting another verification email.', 429);
      const mail = await transaction(async conn => {
        const row = await account(conn, role, accountId, true);
        if (!eligible(row) || typeof currentPassword !== 'string' || Buffer.byteLength(currentPassword) > 72 || !await bcrypt.compare(currentPassword, row.password_hash)) throw error('Check your current password and account email.');
        return issue(conn, role, row, 'verify_email');
      });
      deliver(mail);
      return { message: 'Check your email to verify your recovery address. The link expires in 15 minutes.' };
    },
    async verifyEmail({ role, token, ip }) {
      tableFor(role); await limitIp(ip, true);
      await transaction(async conn => {
        const { row } = await resolveChallenge(conn, role, token, 'verify_email');
        await conn.execute(`UPDATE ${tableFor(role)} SET recovery_email = ?, recovery_email_verified_at = UTC_TIMESTAMP(3) WHERE id = ?`, [normalizeEmail(row.email), row.id]);
        await conn.execute('UPDATE password_recovery_tokens SET consumed_at = UTC_TIMESTAMP(3) WHERE account_id = ? AND account_role = ? AND purpose = ? AND consumed_at IS NULL', [row.id, role, 'verify_email']);
      });
      return { message: 'Your recovery email is verified. You can now use password recovery.' };
    },
  };
}
