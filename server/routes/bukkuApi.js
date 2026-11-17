const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requireRole, scopeToCompany } = require('../auth');
const { logActivity } = require('../lib/activity');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers - same wrapper as dailySales.js.
['get', 'post', 'put', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

// Bukku API (https://developers.bukku.my): Bearer access token + Company-Subdomain header, 600 requests / minute.
const BUKKU_API = 'https://api.bukku.my';

// The access token is a password to the company's books: stored encrypted, never returned to the browser.
// (If JWT_SECRET is ever changed the stored tokens cannot be read any more - the Owner just types them again.)
const KEY = crypto.createHash('sha256').update('bukku-token:' + (process.env.JWT_SECRET || '')).digest();
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('hex'), c.getAuthTag().toString('hex'), ct.toString('hex')].join(':');
}
function decrypt(blob) {
  const p = String(blob || '').split(':');
  if (p.length !== 4 || p[0] !== 'v1') throw new Error('The saved token cannot be read - please type it again.');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(p[1], 'hex'));
    d.setAuthTag(Buffer.from(p[2], 'hex'));
    return Buffer.concat([d.update(Buffer.from(p[3], 'hex')), d.final()]).toString('utf8');
  } catch (e) {
    throw new Error('The saved token cannot be read - please type it again.');
  }
}

const bad = (res, msg) => res.status(400).json({ error: msg });

// "wealthycc", "wealthycc.bukku.my" or "https://wealthycc.bukku.my/..." all become "wealthycc"
function cleanSubdomain(v) {
  let s = String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  s = s.replace(/\.(staging\.bukku\.dev|bukku\.my|bukku\.dev)$/, '');
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(s) ? s : '';
}

async function bukkuGet(conn, path, query) {
  const url = new URL(BUKKU_API + path);
  Object.entries(query || {}).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  let r;
  try {
    r = await fetch(url, {
      headers: { Authorization: 'Bearer ' + decrypt(conn.token_enc), 'Company-Subdomain': conn.subdomain, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000)
    });
  } catch (e) {
    if (/cannot be read/.test(e.message)) throw e;
    throw new Error('Cannot reach Bukku (' + (e.name === 'TimeoutError' ? 'timed out' : 'network error') + ').');
  }
  let body = null;
  try { body = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok) {
    const why = r.status === 401 ? 'Bukku refused the access token (wrong, or API Access was switched off).'
      : r.status === 403 ? 'This access token is not allowed to read this (403).'
        : r.status === 404 ? 'Bukku company not found - check the subdomain.'
          : r.status === 429 ? 'Too many requests to Bukku - wait a minute and try again.'
            : 'Bukku returned an error (' + r.status + ')' + (body && (body.message || body.error) ? ': ' + String(body.message || body.error).slice(0, 200) : '.');
    throw new Error(why);
  }
  return body;
}

function flattenAccounts(list, out) {
  (list || []).forEach((a) => {
    if (a && a.id != null) out.push({ id: a.id, code: String(a.code == null ? '' : a.code), name: String(a.name || ''), type: a.type || null, parentId: a.parent_id == null ? null : a.parent_id });
    if (a && Array.isArray(a.children)) flattenAccounts(a.children, out);
  });
  return out;
}

// ============ CONTROL PANEL (Owner): the connection of each company ============

router.get('/bukku/connections', requireAuth, requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, b.subdomain, b.last_sync_at, b.last_error,
       (b.company_id IS NOT NULL) AS connected,
       (SELECT COUNT(*) FROM bukku_accounts a WHERE a.company_id = c.id)::int AS accounts
     FROM companies c LEFT JOIN bukku_connections b ON b.company_id = c.id
     ORDER BY (b.company_id IS NOT NULL) DESC, c.name`
  );
  res.json(rows.map((r) => ({ id: r.id, name: r.name, connected: r.connected, subdomain: r.subdomain || '', lastSyncAt: r.last_sync_at, lastError: r.last_error || '', accounts: r.accounts })));
});

router.put('/bukku/connections/:companyId', requireAuth, requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const sub = cleanSubdomain(b.subdomain);
  if (!sub) return bad(res, 'Type the Bukku subdomain (the first part of your Bukku web address, e.g. mycompany).');
  const token = typeof b.token === 'string' ? b.token.trim().replace(/^Bearer\s+/i, '') : '';
  const { rows: co } = await pool.query('SELECT id, name FROM companies WHERE id = $1', [req.params.companyId]);
  if (!co[0]) return res.status(404).json({ error: 'Not found' });
  const { rows: old } = await pool.query('SELECT 1 FROM bukku_connections WHERE company_id = $1', [co[0].id]);
  if (!old[0] && !token) return bad(res, 'Paste the Bukku Access Token.');
  if (token && (token.length < 20 || /\s/.test(token))) return bad(res, 'That does not look like a Bukku Access Token.');
  if (old[0]) {
    if (token) await pool.query('UPDATE bukku_connections SET subdomain = $1, token_enc = $2, last_error = NULL, updated_by = $3, updated_at = now() WHERE company_id = $4', [sub, encrypt(token), req.user.sub, co[0].id]);
    else await pool.query('UPDATE bukku_connections SET subdomain = $1, updated_by = $2, updated_at = now() WHERE company_id = $3', [sub, req.user.sub, co[0].id]);
  } else {
    await pool.query('INSERT INTO bukku_connections (company_id, subdomain, token_enc, updated_by) VALUES ($1, $2, $3, $4)', [co[0].id, sub, encrypt(token), req.user.sub]);
  }
  await logActivity(req.user.sub, 'Saved Bukku API connection', co[0].name, token ? 'token replaced' : null);
  res.json({ ok: true, subdomain: sub });
});

router.delete('/bukku/connections/:companyId', requireAuth, requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query('DELETE FROM bukku_connections WHERE company_id = $1 RETURNING company_id', [req.params.companyId]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await pool.query('DELETE FROM bukku_accounts WHERE company_id = $1', [req.params.companyId]);
  const { rows: co } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  await logActivity(req.user.sub, 'Removed Bukku API connection', co[0] ? co[0].name : String(req.params.companyId), null);
  res.json({ ok: true });
});

// Read the company's chart of accounts from Bukku (read only - nothing is written to Bukku) and keep a copy here.
router.post('/bukku/connections/:companyId/sync-accounts', requireAuth, requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    'SELECT b.*, c.name FROM bukku_connections b JOIN companies c ON c.id = b.company_id WHERE b.company_id = $1', [req.params.companyId]
  );
  const conn = rows[0];
  if (!conn) return bad(res, 'Save the Bukku subdomain and Access Token first.');
  let list;
  try {
    const body = await bukkuGet(conn, '/accounts', { is_archived: 'false' });
    list = flattenAccounts(body && body.accounts, []);
    if (!list.length) throw new Error('Bukku returned no accounts.');
  } catch (e) {
    await pool.query('UPDATE bukku_connections SET last_error = $1 WHERE company_id = $2', [e.message.slice(0, 300), conn.company_id]);
    return bad(res, e.message);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM bukku_accounts WHERE company_id = $1', [conn.company_id]);
    for (const a of list) {
      await client.query(
        'INSERT INTO bukku_accounts (company_id, bukku_id, code, name, type, parent_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (company_id, bukku_id) DO NOTHING',
        [conn.company_id, a.id, a.code.slice(0, 40), a.name.slice(0, 200), a.type, a.parentId]
      );
    }
    await client.query('UPDATE bukku_connections SET last_sync_at = now(), last_error = NULL WHERE company_id = $1', [conn.company_id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await logActivity(req.user.sub, 'Synced Bukku chart of accounts', conn.name, list.length + ' accounts');
  res.json({ ok: true, accounts: list.length });
});

// ============ anyone who can open the company: the accounts to pick from ============

router.get('/companies/:companyId/bukku/accounts', requireAuth, scopeToCompany, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT code, name, type, synced_at FROM bukku_accounts WHERE company_id = $1 ORDER BY code, name', [req.params.companyId]
  );
  res.json({
    syncedAt: rows[0] ? rows[0].synced_at : null,
    accounts: rows.map((r) => ({ code: r.code, name: r.name, type: r.type, label: (r.code ? r.code + ' ' : '') + r.name }))
  });
});

module.exports = router;
