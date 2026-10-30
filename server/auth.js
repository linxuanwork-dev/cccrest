const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set');
}

const COOKIE_NAME = 'crest_session';
// A session lasts one hour of inactivity: every request made after the first five minutes hands out a fresh cookie,
// so an idle browser (or a closed tab) is signed out an hour after its last request.
const IDLE_MINUTES = 60;
const TOKEN_TTL = IDLE_MINUTES + 'm';
const REFRESH_AFTER_SECONDS = 300;

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, staffId: user.staff_id, companyId: user.company_id, tv: user.token_version || 0 },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function setSessionCookie(res, user) {
  const token = signToken(user);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Secure whenever the request really came in over HTTPS (Railway's proxy says so), not only when NODE_ENV is set
    secure: process.env.NODE_ENV === 'production' || !!(res.req && res.req.secure),
    maxAge: IDLE_MINUTES * 60 * 1000
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

async function verifyLogin(loginId, password) {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE login_id = $1 AND active = true',
    [loginId.trim().toLowerCase()]
  );
  const user = rows[0];
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  return ok ? user : null;
}

// Whether the account is still switched on, which "session generation" it is on, and whether it must change its
// password. Looked up for every request (cached for a few seconds) so a password change or a switched-off account
// takes effect at once instead of when the 12-hour token runs out.
const stateCache = new Map();
async function userState(id) {
  const hit = stateCache.get(id);
  if (hit && Date.now() - hit.at < 5000) return hit.row;
  const { rows } = await pool.query('SELECT active, token_version, must_change_password FROM users WHERE id = $1', [id]);
  const row = rows[0] || null;
  stateCache.set(id, { at: Date.now(), row });
  if (stateCache.size > 500) stateCache.clear();
  return row;
}
function forgetUserState(id) { stateCache.delete(id); }

// Attaches req.user if a valid, current session cookie is present; does not reject otherwise.
async function attachUser(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return next();
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const state = await userState(payload.sub);
    if (state && state.active && (payload.tv || 0) === state.token_version) {
      req.user = payload;
      req.user.mustChangePassword = !!state.must_change_password;
      if (payload.iat && Date.now() / 1000 - payload.iat > REFRESH_AFTER_SECONDS) {
        setSessionCookie(res, { id: payload.sub, role: payload.role, staff_id: payload.staffId, company_id: payload.companyId, token_version: payload.tv });
      }
    }
  } catch (err) {
    // expired/invalid token — treat as logged out
  }
  next();
}

// A signed-in user who has to change their password can do nothing else until they have.
const PASSWORD_CHANGE_ALLOWED = new Set(['/me', '/me/password', '/logout', '/login']);
function enforcePasswordChange(req, res, next) {
  if (req.user && req.user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(req.path)) {
    return res.status(403).json({ error: '请先修改密码。 Please change your password first.', code: 'PASSWORD_CHANGE_REQUIRED' });
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' });
    next();
  };
}

// For routes shaped /companies/:companyId/..., enforces that a client only
// reaches their own company and staff only reach companies they're assigned to.
// Admin passes through unrestricted. This is the real (server-side) fix for
// "client can't see other company data" — the frontend hiding is just UX.
async function scopeToCompany(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  const companyId = Number(req.params.companyId);
  if (!companyId) return res.status(400).json({ error: 'Invalid company id' });

  if (req.user.role === 'admin') return next();

  if (req.user.role === 'client') {
    if (req.user.companyId !== companyId) return res.status(403).json({ error: 'Not allowed' });
    return next();
  }

  if (req.user.role === 'staff') {
    const { rows } = await pool.query(
      'SELECT 1 FROM company_staff WHERE company_id = $1 AND staff_id = $2',
      [companyId, req.user.staffId]
    );
    if (rows.length === 0) return res.status(403).json({ error: 'Not allowed' });
    return next();
  }

  if (req.user.role === 'manager') {
    const { rows } = await pool.query(
      `SELECT 1 FROM company_staff cs
       JOIN manager_staff ms ON ms.staff_id = cs.staff_id
       WHERE cs.company_id = $1 AND ms.manager_user_id = $2`,
      [companyId, req.user.sub]
    );
    if (rows.length === 0) return res.status(403).json({ error: 'Not allowed' });
    return next();
  }

  return res.status(403).json({ error: 'Not allowed' });
}

// True if the given staffId is on this manager's team.
async function staffInManagerTeam(managerUserId, staffId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM manager_staff WHERE manager_user_id = $1 AND staff_id = $2',
    [managerUserId, staffId]
  );
  return rows.length > 0;
}

module.exports = {
  COOKIE_NAME,
  setSessionCookie,
  clearSessionCookie,
  verifyLogin,
  attachUser,
  enforcePasswordChange,
  forgetUserState,
  requireAuth,
  requireRole,
  scopeToCompany,
  staffInManagerTeam
};
