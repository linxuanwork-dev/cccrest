const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requireRole, scopeToCompany } = require('../auth');
const { requirePage, requireAnyPage } = require('../lib/access');
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

async function bukkuGet(conn, path, query, jsonBody) {
  const url = new URL(BUKKU_API + path);
  Object.entries(query || {}).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  let r;
  try {
    r = await fetch(url, {
      method: jsonBody === undefined ? 'GET' : 'POST',
      headers: Object.assign({ Authorization: 'Bearer ' + decrypt(conn.token_enc), 'Company-Subdomain': conn.subdomain, Accept: 'application/json' }, jsonBody === undefined ? {} : { 'Content-Type': 'application/json' }),
      body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody),
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
            : 'Bukku returned an error (' + r.status + ')' + (body && (body.message || body.error || body.errors) ? ': ' + (typeof (body.message || body.error) === 'string' ? String(body.message || body.error) : JSON.stringify(body.message || body.error || body.errors)).slice(0, 400) : '.');
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
       (SELECT COUNT(*) FROM bukku_accounts a WHERE a.company_id = c.id)::int AS accounts,
       (SELECT COUNT(*) FROM bukku_contacts k WHERE k.company_id = c.id)::int AS contacts,
       COALESCE(b.send_enabled, false) AS send_enabled, COALESCE(b.send_status, 'draft') AS send_status, COALESCE(b.pay_auto, false) AS pay_auto, b.pay_account_id,
       (SELECT COUNT(*) FROM bukku_tags g WHERE g.company_id = c.id)::int AS tags
     FROM companies c LEFT JOIN bukku_connections b ON b.company_id = c.id
     ORDER BY (b.company_id IS NOT NULL) DESC, c.name`
  );
  res.json(rows.map((r) => ({ id: r.id, name: r.name, connected: r.connected, subdomain: r.subdomain || '', lastSyncAt: r.last_sync_at, lastError: r.last_error || '', accounts: r.accounts, contacts: r.contacts, tags: r.tags, sendEnabled: r.send_enabled, sendStatus: r.send_status, payAuto: r.pay_auto, payAccountId: r.pay_account_id == null ? '' : String(r.pay_account_id) })));
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
  await pool.query('DELETE FROM bukku_contacts WHERE company_id = $1', [req.params.companyId]);
  await pool.query('DELETE FROM bukku_tags WHERE company_id = $1', [req.params.companyId]);
  const { rows: co } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  await logActivity(req.user.sub, 'Removed Bukku API connection', co[0] ? co[0].name : String(req.params.companyId), null);
  res.json({ ok: true });
});

// All the contacts of the company (paged: 100 per request).
async function fetchContacts(conn) {
  const out = [];
  for (let page = 1; page <= 200; page++) {
    const body = await bukkuGet(conn, '/contacts', { page, page_size: 100, status: 'ACTIVE' });
    const raw = body && body.contacts;
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    out.push(...list);
    const total = body && body.paging && Number(body.paging.total);
    if (!list.length || (total && out.length >= total) || list.length < 100) break;
  }
  return out;
}

// Replace the saved copy of one kind of Bukku data (all or nothing).
async function replaceCopy(companyId, deleteSql, rows, insertSql, toParams) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(deleteSql, [companyId]);
    for (const r of rows) await client.query(insertSql, toParams(r));
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Read the company's chart of accounts and contacts from Bukku (read only - nothing is written to Bukku) and keep a copy here.
router.post(['/bukku/connections/:companyId/sync', '/bukku/connections/:companyId/sync-accounts'], requireAuth, requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    'SELECT b.*, c.name FROM bukku_connections b JOIN companies c ON c.id = b.company_id WHERE b.company_id = $1', [req.params.companyId]
  );
  const conn = rows[0];
  if (!conn) return bad(res, 'Save the Bukku subdomain and Access Token first.');
  const errors = [];
  let accounts = null, contacts = null;

  try {
    const body = await bukkuGet(conn, '/accounts', { is_archived: 'false' });
    const list = flattenAccounts(body && body.accounts, []);
    if (!list.length) throw new Error('Bukku returned no accounts.');
    await replaceCopy(conn.company_id, 'DELETE FROM bukku_accounts WHERE company_id = $1', list,
      'INSERT INTO bukku_accounts (company_id, bukku_id, code, name, type, parent_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (company_id, bukku_id) DO NOTHING',
      (a) => [conn.company_id, a.id, a.code.slice(0, 40), a.name.slice(0, 200), a.type, a.parentId]);
    accounts = list.length;
  } catch (e) { errors.push('Chart of accounts: ' + e.message); }

  try {
    const list = await fetchContacts(conn);
    await replaceCopy(conn.company_id, 'DELETE FROM bukku_contacts WHERE company_id = $1', list,
      `INSERT INTO bukku_contacts (company_id, bukku_key, legal_name, other_name, contact_code, reg_no, types, email, phone_no, is_archived)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (company_id, bukku_key) DO NOTHING`,
      (c) => [conn.company_id, String(c.id != null ? c.id : (c.contact_code || c.legal_name || '')).slice(0, 120), String(c.legal_name || '').slice(0, 200),
        c.other_name || null, String(c.contact_code || '').slice(0, 60), c.reg_no || null, Array.isArray(c.types) ? c.types.map(String) : [],
        c.email || null, c.phone_no || null, !!c.is_archived]);
    contacts = list.length;
  } catch (e) { errors.push('Contacts: ' + e.message); }

  let tags = null;
  try {
    const body = await bukkuGet(conn, '/tags');
    const list = (body && Array.isArray(body.tags) ? body.tags : []).filter((g) => g && g.id != null && !g.is_archived);
    await replaceCopy(conn.company_id, 'DELETE FROM bukku_tags WHERE company_id = $1', list,
      'INSERT INTO bukku_tags (company_id, bukku_id, name) VALUES ($1,$2,$3) ON CONFLICT (company_id, bukku_id) DO NOTHING',
      (g) => [conn.company_id, g.id, String(g.name || '').slice(0, 100)]);
    tags = list.length;
  } catch (e) { errors.push('Tags: ' + e.message); }

  if (accounts == null && contacts == null && tags == null) {
    await pool.query('UPDATE bukku_connections SET last_error = $1 WHERE company_id = $2', [errors.join(' | ').slice(0, 300), conn.company_id]);
    return bad(res, errors.join(' '));
  }
  await pool.query('UPDATE bukku_connections SET last_sync_at = now(), last_error = $1 WHERE company_id = $2', [errors.length ? errors.join(' | ').slice(0, 300) : null, conn.company_id]);
  await logActivity(req.user.sub, 'Synced Bukku chart of accounts & contacts', conn.name, (accounts == null ? 'accounts failed' : accounts + ' accounts') + ', ' + (contacts == null ? 'contacts failed' : contacts + ' contacts') + ', ' + (tags == null ? 'tags failed' : tags + ' tags'));
  res.json({ ok: true, accounts: accounts || 0, contacts: contacts || 0, tags: tags || 0, errors });
});

// ============ anyone who can open the company: the accounts to pick from ============

router.get('/companies/:companyId/bukku/accounts', requireAuth, scopeToCompany, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT bukku_id, code, name, type, synced_at FROM bukku_accounts WHERE company_id = $1 ORDER BY code, name', [req.params.companyId]
  );
  res.json({
    syncedAt: rows[0] ? rows[0].synced_at : null,
    accounts: rows.map((r) => ({ id: String(r.bukku_id), code: r.code, name: r.name, type: r.type, label: (r.code ? r.code + ' ' : '') + r.name }))
  });
});

router.get('/companies/:companyId/bukku/contacts', requireAuth, scopeToCompany, async (req, res) => {
  const type = ['customer', 'supplier', 'employee'].includes(req.query.type) ? req.query.type : null;
  const { rows } = await pool.query(
    `SELECT legal_name, other_name, contact_code, reg_no, types, email, phone_no FROM bukku_contacts
      WHERE company_id = $1 AND NOT is_archived AND ($2::text IS NULL OR $2 = ANY(types)) ORDER BY legal_name`,
    [req.params.companyId, type]
  );
  res.json({ contacts: rows.map((r) => ({ legalName: r.legal_name, otherName: r.other_name || '', code: r.contact_code, regNo: r.reg_no || '', types: r.types, email: r.email || '', phone: r.phone_no || '' })) });
});

// A person who works on the company's tuition (a CC CREST manager) reads the Bukku contacts again right now (read only).
router.post('/companies/:companyId/bukku/refresh-contacts', requireAuth, scopeToCompany, requireAnyPage(['tuition', 'purchases'], 2), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM bukku_connections WHERE company_id = $1', [req.params.companyId]);
  const conn = rows[0];
  if (!conn) return bad(res, '这家公司还没有连接 Bukku（请 Owner 到 Control Panel > Bukku API 连接）。');
  const list = await fetchContacts(conn);
  await replaceCopy(conn.company_id, 'DELETE FROM bukku_contacts WHERE company_id = $1', list,
    `INSERT INTO bukku_contacts (company_id, bukku_key, legal_name, other_name, contact_code, reg_no, types, email, phone_no, is_archived)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (company_id, bukku_key) DO NOTHING`,
    (c) => [conn.company_id, String(c.id != null ? c.id : (c.contact_code || c.legal_name || '')).slice(0, 120), String(c.legal_name || '').slice(0, 200),
      c.other_name || null, String(c.contact_code || '').slice(0, 60), c.reg_no || null, Array.isArray(c.types) ? c.types.map(String) : [],
      c.email || null, c.phone_no || null, !!c.is_archived]);
  await pool.query('UPDATE bukku_connections SET last_sync_at = now() WHERE company_id = $1', [conn.company_id]);
  res.json({ ok: true, contacts: list.length });
});

// The Owner switches "send purchase bills to Bukku (as drafts)" on or off for a company.
router.put('/bukku/connections/:companyId/send', requireAuth, requireRole('admin'), async (req, res) => {
  const on = !!(req.body && req.body.enabled);
  const status = req.body && req.body.status === 'ready' ? 'ready' : 'draft';
  const { rows } = await pool.query('UPDATE bukku_connections SET send_enabled = $2, send_status = $3 WHERE company_id = $1 RETURNING company_id', [req.params.companyId, on, status]);
  if (!rows[0]) return bad(res, 'Save the Bukku subdomain and Access Token first.');
  const { rows: co } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  await logActivity(req.user.sub, on ? 'Switched on sending purchase bills to Bukku' : 'Switched off sending purchase bills to Bukku', co[0] ? co[0].name : String(req.params.companyId), on ? ('as ' + (status === 'ready' ? 'finished bills' : 'drafts')) : null);
  res.json({ ok: true, enabled: on, status });
});

// The Owner switches "record the payment in Bukku after the bank check" on or off for a company, and names the Bukku bank account that pays.
router.put('/bukku/connections/:companyId/pay', requireAuth, requireRole('admin'), async (req, res) => {
  const on = !!(req.body && req.body.enabled);
  const accountId = Number(req.body && req.body.accountId) || 0;
  if (on) {
    if (!accountId) return bad(res, '请选付款用的 Bukku 银行账户。 Choose the Bukku bank account that pays.');
    const { rows: a } = await pool.query('SELECT 1 FROM bukku_accounts WHERE company_id = $1 AND bukku_id = $2', [req.params.companyId, accountId]);
    if (!a[0]) return bad(res, '这个账户不在这家公司的 Bukku 科目表里，请先「重新同步」。 That account is not in the synced chart of accounts.');
  }
  const { rows } = await pool.query('UPDATE bukku_connections SET pay_auto = $2, pay_account_id = $3 WHERE company_id = $1 RETURNING company_id', [req.params.companyId, on, accountId || null]);
  if (!rows[0]) return bad(res, 'Save the Bukku subdomain and Access Token first.');
  const { rows: co } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  await logActivity(req.user.sub, on ? 'Switched on recording payments in Bukku after the bank check' : 'Switched off recording payments in Bukku', co[0] ? co[0].name : String(req.params.companyId), null);
  res.json({ ok: true });
});

module.exports = router;
// used by the purchase bill routes: the saved connection of a company, and a POST to the Bukku API
module.exports.bukku = {
  loadConn: async (companyId) => (await pool.query('SELECT * FROM bukku_connections WHERE company_id = $1', [companyId])).rows[0] || null,
  post: (conn, path, body) => bukkuGet(conn, path, {}, body),
  get: (conn, path, query) => bukkuGet(conn, path, query)
};
