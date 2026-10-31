const { pool } = require('../db');

// Every feature that produces a file. The Control Panel lets the Owner set one naming pattern per feature; a feature
// with no pattern keeps its built-in file name. `letter: true` marks letters (they never get the print stamp).
const FEATURES = [
  { key: 'kwsp_forms', label: 'KWSP & PERKESO forms (PDF)', builtin: '{COMPANY}-KWSP-PERKESO', ext: 'pdf' },
  { key: 'kwsp_form_single', label: 'PERKESO forms, one file per form (PDF)', builtin: '{PREFIX}-{FORM}', ext: 'pdf' },
  { key: 'kwsp_authorization_letter', label: 'KWSP authorization letter (PDF)', builtin: '{COMPANY}-KWSP-AUTHORIZATION-LETTER', ext: 'pdf', letter: true },
  { key: 'einvoice_info', label: 'e-Invoice information sheet (PDF)', builtin: '{COMPANY}-EINVOICE-INFO', ext: 'pdf' },
  { key: 'employment_letter', label: 'Employment letter', builtin: '{COMPANY}-EMPLOYMENT-LETTER-{EMP}', ext: 'pdf', letter: true, soon: true },
  { key: 'confirmation_letter', label: 'Confirmation letter', builtin: '{COMPANY}-CONFIRMATION-LETTER-{EMP}', ext: 'pdf', letter: true, soon: true },
  { key: 'holiday_notice', label: 'Yearly holiday notice', builtin: '{COMPANY}-HOLIDAY-NOTICE-{YYYY}', ext: 'pdf', letter: true, soon: true },
  { key: 'salary_voucher', label: 'Salary payment voucher (PDF)', builtin: 'Salary-Voucher-{PERIOD}', ext: 'pdf' },
  { key: 'company_report', label: 'Company PDF reports', builtin: '{TITLE}', ext: 'pdf' },
  { key: 'sales_summary_excel', label: 'Sales Summary — Bukku invoice file (Excel)', builtin: '{BRANCH}-BUKKU SALES INV-{YYYY}_{MM}', ext: 'xlsx' },
  { key: 'sales_summary_pdf', label: 'Sales Summary report (PDF)', builtin: '{BRANCH}-BUKKU SALES INV-{YYYY}_{MM}', ext: 'pdf' },
  { key: 'purchase_bukku', label: 'Purchase Bill entry — Bukku import file (Excel)', builtin: '{PREFIX}-BUKKU-PURCHASES_BILL-{SPAN}', ext: 'xlsx' },
  { key: 'dm_invoice', label: 'DM Reg & Mod sales invoice (Excel)', builtin: 'sales-invoice-{BRANCH}-{MM}{YYYY}', ext: 'xlsx' },
  { key: 'ol_tng_report', label: 'OL-TNG Daily Settlement Report (Excel)', builtin: 'OL-TNG_{YYYY}_{MM}', ext: 'xlsx' }
];
const FEATURE_BY_KEY = Object.fromEntries(FEATURES.map((f) => [f.key, f]));

const TOKENS = {
  PREFIX: 'the company file prefix set on its profile',
  COMPANY: 'company name, capitals with hyphens',
  YYYY: 'year (4 digits)', YY: 'year (2 digits)', MM: 'month (2 digits)', DD: 'day (2 digits)',
  SEQ: 'running number, e.g. {SEQ:3} gives 001 (restarts each year if the pattern has {YYYY})',
  EMP: 'employee name', PERIOD: 'period, e.g. 2026-10', TITLE: 'report title', BRANCH: 'branch / outlet code', FORM: 'form name, e.g. BORANG 1 or SIP 1A', SPAN: 'month(s) of the bills, e.g. 2026_08 or 2026_07_2026_08'
};

// Malaysia time, whatever the server's clock zone is
function myNow(date) {
  const d = date || new Date();
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
    .reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  return { Y: parts.year, M: parts.month, D: parts.day };
}

function cleanFileName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n\t]+/g, '-').replace(/\s{2,}/g, ' ').replace(/-{2,}/g, '-').replace(/^[\s.-]+|[\s.-]+$/g, '').slice(0, 150);
}
const hyphenUpper = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');

function validatePattern(pattern) {
  const p = String(pattern || '').trim();
  if (!p) return 'The pattern cannot be empty.';
  if (p.length > 120) return 'The pattern is too long.';
  if (/[\\/:*?"<>|]/.test(p.replace(/\{[^}]*\}/g, ''))) return 'A file name cannot contain \\ / : * ? " < > |';
  const bad = [...p.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).filter((t) => !/^(PREFIX|COMPANY|YYYY|YY|MM|DD|EMP|PERIOD|TITLE|BRANCH|FORM|SPAN)$/.test(t) && !/^SEQ(:[1-6])?$/.test(t));
  if (bad.length) return 'Unknown placeholder: {' + bad[0] + '}';
  if (/[{}]/.test(p.replace(/\{[^}]*\}/g, ''))) return 'Unbalanced { } in the pattern.';
  return null;
}

function render(pattern, v) {
  return cleanFileName(pattern.replace(/\{([A-Z]+)(?::(\d))?\}/g, (m, tok, pad) => {
    if (tok === 'SEQ') return String(v.SEQ == null ? 1 : v.SEQ).padStart(Number(pad || 3), '0');
    return v[tok] == null ? '' : String(v[tok]);
  }));
}

async function companyInfo(companyId) {
  const { rows } = await pool.query('SELECT name, file_prefix FROM companies WHERE id = $1', [companyId]);
  const c = rows[0] || { name: '', file_prefix: null };
  const initials = String(c.name).replace(/[^A-Za-z ]/g, '').split(' ').filter(Boolean).map((w) => w[0]).join('').toUpperCase().slice(0, 3);
  return { name: c.name, PREFIX: hyphenUpper(c.file_prefix) || initials || 'DOC', COMPANY: hyphenUpper(c.name) || 'COMPANY' };
}

function baseValues(info, ctx) {
  const now = myNow();
  return Object.assign({ PREFIX: info.PREFIX, COMPANY: info.COMPANY, YYYY: now.Y, YY: now.Y.slice(2), MM: now.M, DD: now.D, PERIOD: now.Y + '-' + now.M }, ctx || {});
}

// The file name (without extension) for the next file of this feature. No pattern set -> `fallback` (the built-in name).
async function fileBase(feature, companyId, ctx, fallback) {
  const { rows } = await pool.query('SELECT pattern FROM doc_settings WHERE feature_key = $1', [feature]);
  if (!rows[0]) return fallback;
  const pattern = rows[0].pattern;
  const values = baseValues(await companyInfo(companyId), ctx);
  if (/\{SEQ(:\d)?\}/.test(pattern)) {
    const scope = /\{YYYY\}|\{YY\}/.test(pattern) ? (/\{MM\}/.test(pattern) ? values.YYYY + '-' + values.MM : values.YYYY) : 'all';
    const { rows: seq } = await pool.query(
      `INSERT INTO doc_sequences (company_id, feature_key, scope, last_value) VALUES ($1, $2, $3, 1)
       ON CONFLICT (company_id, feature_key, scope) DO UPDATE SET last_value = doc_sequences.last_value + 1 RETURNING last_value`,
      [companyId, feature, scope]
    );
    values.SEQ = seq[0].last_value;
  }
  return render(pattern, values) || fallback;
}

// What a pattern would produce, without using up a number (Control Panel preview)
async function previewName(pattern, companyId) {
  const values = baseValues(await companyInfo(companyId), { EMP: 'AHMAD-BIN-ALI', TITLE: 'REPORT', BRANCH: 'ML-TU', FORM: 'SIP 1', SPAN: '2026_08', SEQ: 1 });
  return render(pattern, values);
}

async function userNameFor(req) {
  if (req._docUserName) return req._docUserName;
  const { rows } = await pool.query('SELECT display_name, login_id FROM users WHERE id = $1', [req.user.sub]);
  req._docUserName = (rows[0] && (rows[0].display_name || rows[0].login_id)) || '';
  return req._docUserName;
}

async function logEvent(req, companyId, docType, docRef, event, details) {
  await pool.query(
    'INSERT INTO document_events (company_id, doc_type, doc_ref, event, details, user_id, user_name) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)',
    [companyId, docType, docRef || '', event, JSON.stringify(details || []), req.user.sub, await userNameFor(req)]
  );
}

// ---- field-level "what changed" for create / update history ----
function flatten(obj, prefix, out) {
  out = out || {};
  if (obj == null || typeof obj !== 'object') { out[prefix] = obj; return out; }
  if (Array.isArray(obj)) {
    if (!obj.length) out[prefix] = '';
    obj.forEach((v, i) => flatten(v, prefix + '[' + (i + 1) + ']', out));
    return out;
  }
  const keys = Object.keys(obj);
  if (!keys.length) out[prefix] = '';
  keys.forEach((k) => flatten(obj[k], prefix ? prefix + '.' + k : k, out));
  return out;
}
const show = (v) => (v == null ? '' : String(v)).slice(0, 120);
// -> [{ field, from, to }] (at most 60 entries); images are reported as changed, never stored
function diffObjects(before, after, skip) {
  const a = flatten(before || {}, ''), b = flatten(after || {}, '');
  const keys = Array.from(new Set(Object.keys(a).concat(Object.keys(b)))).filter((k) => !(skip || []).some((s) => k === s || k.startsWith(s + '.') || k.startsWith(s + '[')));
  const out = [];
  keys.forEach((k) => { if (show(a[k]) !== show(b[k])) out.push({ field: k, from: show(a[k]), to: show(b[k]) }); });
  return out.slice(0, 60);
}

// A run of edits by one person on one record is kept as one history entry (first "from" -> latest "to"), so typing
// doesn't fill the history with dozens of rows; a change that is typed back to where it started disappears.
function mergeChanges(oldList, newList) {
  const m = new Map();
  (oldList || []).forEach((c) => m.set(c.field, Object.assign({}, c)));
  (newList || []).forEach((c) => { const e = m.get(c.field); if (e) e.to = c.to; else m.set(c.field, Object.assign({}, c)); });
  return Array.from(m.values()).filter((c) => c.from !== c.to).slice(0, 60);
}
async function logUpdate(req, companyId, docType, docRef, changes) {
  if (!changes || !changes.length) return;
  const { rows } = await pool.query(
    `SELECT id, details FROM document_events WHERE company_id = $1 AND doc_type = $2 AND doc_ref = $3 AND event = 'updated' AND user_id = $4
       AND created_at > now() - interval '10 minutes' ORDER BY id DESC LIMIT 1`,
    [companyId, docType, docRef || '', req.user.sub]
  );
  if (rows[0]) {
    const merged = mergeChanges(rows[0].details, changes);
    if (!merged.length) await pool.query('DELETE FROM document_events WHERE id = $1', [rows[0].id]);
    else await pool.query('UPDATE document_events SET details = $1::jsonb, created_at = now() WHERE id = $2', [JSON.stringify(merged), rows[0].id]);
    return;
  }
  await logEvent(req, companyId, docType, docRef, 'updated', changes);
}

// ---- print stamp: date + user at the bottom right (never on letters or the official KWSP / PERKESO forms) ----
function stampText(name) {
  const n = myNow();
  return 'Printed ' + n.D + '/' + n.M + '/' + n.Y + (name ? ' by ' + name : '');
}
// Excel: shows in the print footer, so no cell of the sheet (or the Bukku import columns) changes
function stampWorkbook(wb, text) {
  const esc = String(text).replace(/&/g, '&&');
  wb.eachSheet((ws) => {
    const hf = ws.headerFooter || {};
    const existing = hf.oddFooter || '';
    if (/&R/.test(existing)) return;
    ws.headerFooter = Object.assign({}, hf, { oddFooter: existing + '&R&8' + esc });
  });
}
// pdfkit: call after all content is written (the document needs bufferPages: true) and before doc.end()
function stampPdfkitPages(doc, text) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const page = doc.page, bottom = page.margins.bottom;
    page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor('#555555');
    doc.text(text, page.width - doc.widthOfString(text) - 24, page.height - 20, { lineBreak: false });
    page.margins.bottom = bottom;
  }
}

module.exports = { logUpdate, FEATURES, FEATURE_BY_KEY, TOKENS, validatePattern, fileBase, previewName, logEvent, userNameFor, diffObjects, stampText, stampWorkbook, stampPdfkitPages, cleanFileName, hyphenUpper, companyInfo };
