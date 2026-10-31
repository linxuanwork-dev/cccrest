require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { migrate } = require('./migrate');
const { attachUser, enforcePasswordChange } = require('./auth');
const { pool } = require('./db');
const { flagDefaultPasswords } = require('./lib/password');

const ROOT = path.join(__dirname, '..');
const app = express();

// Behind Railway's proxy: take the real client address from the proxy header (used by the login limits)
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Security headers: no framing by other sites, no content-type guessing, HTTPS only, tight referrer / permissions.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production' || req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});
// Data from the API is personal: browsers and proxies must not keep a copy (the big program files are cacheable)
app.use('/api', (req, res, next) => {
  if (!req.path.startsWith('/kwsp/assets/') && req.path !== '/kwsp/app') res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(attachUser);
app.use('/api', enforcePasswordChange);

app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/companies'));
app.use('/api', require('./routes/staff'));
app.use('/api', require('./routes/assignments'));
app.use('/api', require('./routes/activity'));
app.use('/api', require('./routes/reports'));
app.use('/api', require('./routes/reconciliation'));
app.use('/api', require('./routes/workflow'));
app.use('/api', require('./routes/employees'));
app.use('/api', require('./routes/payroll'));
app.use('/api', require('./routes/dmInvoice'));
app.use('/api', require('./routes/olTngReport'));
app.use('/api', require('./routes/dailySales'));
app.use('/api', require('./routes/companyUsers'));
app.use('/api', require('./routes/accounts'));
app.use('/api', require('./routes/purchaseBukku'));
app.use('/api', require('./routes/kwsp'));
app.use('/api', require('./routes/docs'));

// Everything else is the single-page app.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(ROOT, 'index.html'));
});

const PORT = process.env.PORT || 3000;

migrate()
  .then(async () => {
    const n = await flagDefaultPasswords(pool);
    if (n) console.log('Accounts that must change a default password:', n);
    app.listen(PORT, () => {
      console.log(`CREST server listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to run migrations, not starting server:', err);
    process.exit(1);
  });
