const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set');
}

const COOKIE_NAME = 'crest_session';
const TOKEN_TTL = '12h';

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, staffId: user.staff_id, companyId: user.company_id },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function setSessionCookie(res, user) {
  const token = signToken(user);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 12 * 60 * 60 * 1000
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

// Attaches req.user if a valid session cookie is present; does not reject otherwise.
function attachUser(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return next();
  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    // expired/invalid token — treat as logged out
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
  requireAuth,
  requireRole,
  scopeToCompany,
  staffInManagerTeam
};
