const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const router = express.Router();
['get', 'post', 'put', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

// MT Claim form (DIDIK MULIA): each MT has a login of their own (tuition_mt_users) and fills the monthly claim form.
// This is NOT a CC CREST login: the token below only works on these endpoints. The form (server/assets/mtclaim/app.html)
// is public, the data is not. A claim is a 'claims/...' document in tuition_docs, which the CC CREST page (tuitionAllowance.js)
// shows to the CC CREST people, who approve it or send it back.

const PAGE = path.join(__dirname, '..', 'assets', 'mtclaim', 'app.html');
const JWT_SECRET = process.env.JWT_SECRET;
// Messages for the MT, in English / Bahasa Melayu / 中文 (the page sends its language in the X-Lang header)
const MSG = {
  need_login: ['Enter your user name and password.', 'Sila isi nama pengguna dan kata laluan.', '请填用户名和密码。'],
  too_many: ['Too many attempts. Try again in 15 minutes.', 'Terlalu banyak percubaan. Cuba lagi dalam 15 minit.', '试太多次了，请 15 分钟后再试。'],
  wrong_login: ['Wrong user name or password.', 'Nama pengguna atau kata laluan salah.', '用户名或密码不对。'],
  cur_wrong: ['The current password is wrong.', 'Kata laluan semasa salah.', '现在的密码不对。'],
  pw_short: ['The new password needs at least 8 characters.', 'Kata laluan baharu mesti sekurang-kurangnya 8 aksara.', '新密码至少 8 个字。'],
  pw_same: ['Choose a password different from the old one.', 'Pilih kata laluan yang berbeza daripada yang lama.', '新密码不能跟旧的一样。'],
  locked: ['Already submitted, it cannot be changed.', 'Sudah dihantar, tidak boleh diubah.', '已经提交了，不能再改。'],
  not_signed: ['Please sign in.', 'Sila log masuk.', '请登录。'],
  expired: ['Session ended. Please sign in again.', 'Sesi tamat. Sila log masuk semula.', '登录已过期，请重新登录。'],
  invalid: ['Invalid request.', 'Permintaan tidak sah.', '请求不对。'],
  row: ['Row {n}: ', 'Baris {n}: ', '第 {n} 行：'],
  no_student: ['student not found.', 'murid tidak dijumpai.', '找不到这个学生。'],
  dup_student: ['this student is on the form twice.', 'murid ini muncul dua kali.', '这个学生出现了两次。'],
  need_student: ["choose a student or type the new student's name.", 'pilih murid atau taip nama murid baharu.', '请选学生，或填新学生的名字。'],
  dup_name: ['this name is on the form twice.', 'nama ini muncul dua kali.', '这个名字出现了两次。'],
  pkg_unknown: ['package {pkg} is not in the list.', 'pakej {pkg} tiada dalam senarai.', 'package {pkg} 不在名单里。'],
  need_pkg: ['choose the package.', 'pilih pakej.', '请选 package。'],
  max_classes: ['{name}: package {pkg} allows at most {max} classes a month, you entered {n}.', '{name}: pakej {pkg} dibenarkan paling banyak {max} sesi sebulan, anda isi {n}.', '{name} 的 package {pkg} 一个月最多 {max} 堂，你填了 {n} 堂。'],
  dup_dates: ['the same date is entered twice.', 'tarikh yang sama diisi dua kali.', '有重复的日期。'],
  date_out: ['date {d} is not in {month}.', 'tarikh {d} bukan dalam {month}.', '日期 {d} 不在 {month} 里。'],
  need_fee: ['choose Yuran: DONE or BELUM.', 'pilih Yuran: DONE atau BELUM.', '请选 Yuran：DONE 或 BELUM。'],
  bad_product: ['the product is not in the list.', 'produk tiada dalam senarai.', '产品不在名单里。'],
  no_lines: ['No students on the form yet.', 'Belum ada murid dalam borang.', '还没有填任何学生。'],
  no_pkg_label: ['(none)', '(tiada)', '(没选)']
};
const langOf = (req) => { const l = String((req.headers && req.headers['x-lang']) || '').toLowerCase(); return l === 'ms' ? 1 : l === 'zh' ? 2 : 0; };
const tr = (lang, key, p) => String(MSG[key][lang]).replace(/\{(\w+)\}/g, (m, k) => (p && p[k] != null ? p[k] : m));
const bad = (res, req, key, code = 400, p) => res.status(code).json({ error: tr(langOf(req), key, p) });
const DEFAULT_CLASSES = { A: 4, B: 4, C: 8, 'A+': 4, 'B+': 8, 'C+': 2, 'S B+(2)': 18, '(S)A': 4, '(S)C+': 4, 'DA+': 8, '2A+': 8, 'TRAIL-A+': 1 };
const DEFAULT_PRODUCTS = ['Fast Track ABC', 'Fast Track ABB', 'Fast Track ABD', 'Fast Track ABK', 'Fast Track ABS'];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const stdClasses = (packages, pkg) => { const p = packages[pkg]; return (p && +p.classes) || DEFAULT_CLASSES[pkg] || 4; };
const claimPath = (u, month) => 'claims/' + u.branch + '_u' + u.id + '_' + month;
const pkOk = (pk, name) => !!(name && pk[name] && ((+pk[name].fee || 0) > 0 || (+pk[name].rate || 0) > 0));

// ---- login limits: 5 wrong passwords for one user name from one address lock it for 15 minutes ----
const fails = new Map();
const lockKey = (req, name) => String(name).toLowerCase() + '|' + req.ip;
function locked(key) { const f = fails.get(key); return !!(f && f.n >= 5 && Date.now() - f.at < 15 * 60 * 1000); }
function failed(key) {
  const f = fails.get(key);
  fails.set(key, { n: (f && Date.now() - f.at < 15 * 60 * 1000 ? f.n : 0) + 1, at: Date.now() });
  if (fails.size > 2000) fails.clear();
}

const sign = (u) => jwt.sign({ kind: 'mt', id: u.id }, JWT_SECRET, { expiresIn: '12h' });

async function mtAuth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return bad(res, req, 'not_signed', 401);
  let payload;
  try { payload = jwt.verify(h.slice(7), JWT_SECRET); } catch (e) { return bad(res, req, 'expired', 401); }
  if (!payload || payload.kind !== 'mt') return bad(res, req, 'not_signed', 401);
  const { rows } = await pool.query(
    `SELECT u.*, COALESCE(s.enabled, false) AS enabled FROM tuition_mt_users u
       LEFT JOIN tuition_settings s ON s.company_id = u.company_id WHERE u.id = $1`, [payload.id]
  );
  const u = rows[0];
  if (!u || !u.active || !u.enabled) return bad(res, req, 'not_signed', 401);
  req.mt = u;
  next();
}
const bump = (cid) => pool.query(
  `INSERT INTO tuition_settings (company_id, enabled, rev) VALUES ($1,false,1)
   ON CONFLICT (company_id) DO UPDATE SET rev = tuition_settings.rev + 1`, [cid]
);
const getDoc = async (cid, p) => {
  const r = await pool.query('SELECT data FROM tuition_docs WHERE company_id = $1 AND path = $2', [cid, p]);
  return r.rows[0] ? r.rows[0].data : null;
};

router.get('/mt-claim/app', (req, res) => { res.sendFile(PAGE); });

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
router.post('/mt-claim/login', async (req, res) => {
  const name = String((req.body && req.body.username) || '').trim(), pw = String((req.body && req.body.password) || '');
  if (!name || !pw) return bad(res, req, 'need_login');
  const key = lockKey(req, name);
  if (locked(key)) return bad(res, req, 'too_many', 429);
  const { rows } = await pool.query('SELECT * FROM tuition_mt_users WHERE lower(username) = lower($1)', [name]);
  const u = rows[0];
  const okPw = await bcrypt.compare(pw, u ? u.password_hash : DUMMY_HASH);
  if (!u || !okPw || !u.active) { failed(key); return bad(res, req, 'wrong_login', 401); }
  fails.delete(key);
  await pool.query('UPDATE tuition_mt_users SET last_login = now() WHERE id = $1', [u.id]);
  res.json({ token: sign(u), mustChange: u.must_change, mt: u.mt, branch: u.branch });
});

router.post('/mt-claim/password', mtAuth, async (req, res) => {
  const cur = String((req.body && req.body.current) || ''), nw = String((req.body && req.body.password) || '');
  if (!(await bcrypt.compare(cur, req.mt.password_hash))) return bad(res, req, 'cur_wrong', 401);
  if (nw.length < 8) return bad(res, req, 'pw_short');
  if (nw === cur) return bad(res, req, 'pw_same');
  await pool.query('UPDATE tuition_mt_users SET password_hash = $2, must_change = false WHERE id = $1', [req.mt.id, await bcrypt.hash(nw, 10)]);
  res.json({ ok: true });
});

// What the form needs: the MT's own students, every active student of the branch (names only, for "add a student"), the packages with
// their number of classes (fixed), the product list, and the claim of the month if there is one.
router.get('/mt-claim/me', mtAuth, async (req, res) => {
  const u = req.mt, month = String(req.query.month || '');
  if (!MONTH_RE.test(month)) return bad(res, req, 'invalid');
  const stu = (await getDoc(u.company_id, 'students/' + u.branch)) || { list: {} };
  const pk = ((await getDoc(u.company_id, 'settings/packages')) || {}).list || {};
  const cfg = (await getDoc(u.company_id, 'settings/config')) || {};
  const students = Object.entries(stu.list || {}).filter(([, s]) => s.status === 'Active')
    .map(([no, s]) => ({ uid: u.branch + ':' + no, no, name: s.name, pkg: s.pkg || '', own: s.mt === u.mt }));
  const packages = {};
  Object.keys(pk).forEach((k) => { if (pkOk(pk, k)) packages[k] = { classes: stdClasses(pk, k), rate: +pk[k].rate || 0 }; });
  let claim = await getDoc(u.company_id, claimPath(u, month));
  // once submitted the claim belongs to the office: the MT only sees that it was submitted (the history is in the CC CREST system)
  if (claim && ['submitted', 'approved'].includes(claim.status)) claim = { status: claim.status, month: claim.month, submittedAt: claim.submittedAt, lines: [] };
  const products = Array.isArray(cfg.claimProducts) && cfg.claimProducts.length ? cfg.claimProducts : DEFAULT_PRODUCTS;
  res.json({ mt: u.mt, branch: u.branch, month, students, packages, products, claim });
});

// Check the lines of a claim against what is fixed: the students of the branch, the packages, the number of classes of the package,
// the dates inside the month. `strict` is for submitting (everything must be filled), a draft may be incomplete.
async function checkLines(u, month, lines, strict, req) {
  const lang = langOf(req);
  if (!Array.isArray(lines) || lines.length > 80) return { error: tr(lang, 'invalid') };
  const stu = (await getDoc(u.company_id, 'students/' + u.branch)) || { list: {} };
  const pk = ((await getDoc(u.company_id, 'settings/packages')) || {}).list || {};
  const cfg = (await getDoc(u.company_id, 'settings/config')) || {};
  const prods = Array.isArray(cfg.claimProducts) && cfg.claimProducts.length ? cfg.claimProducts : DEFAULT_PRODUCTS;
  const out = [], seen = new Set(), seenNew = new Set();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] || {}, tag = tr(lang, 'row', { n: i + 1 });
    const uid = l.uid ? String(l.uid) : null;
    let name = String(l.name || '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 120);
    if (uid) {
      const [b, no] = uid.split(':');
      if (b !== u.branch || !(stu.list || {})[no]) return { error: tag + tr(lang, 'no_student') };
      if (seen.has(uid)) return { error: tag + tr(lang, 'dup_student') };
      seen.add(uid); name = stu.list[no].name;
    } else {
      if (!name) {
        if (!strict && !l.pkg && !(l.dates || []).length) continue;
        return { error: tag + tr(lang, 'need_student') };
      }
      if (seenNew.has(name)) return { error: tag + tr(lang, 'dup_name') };
      seenNew.add(name);
    }
    const pkg = String(l.pkg || '');
    if (pkg && !pkOk(pk, pkg)) return { error: tag + tr(lang, 'pkg_unknown', { pkg }) };
    if (strict && !pkg) return { error: tag + tr(lang, 'need_pkg') };
    const max = pkg ? stdClasses(pk, pkg) : 0;
    const dates = Array.isArray(l.dates) ? l.dates.map(String).filter(Boolean) : [];
    if (dates.length > max) return { error: tag + tr(lang, 'max_classes', { name, pkg: pkg || tr(lang, 'no_pkg_label'), max, n: dates.length }) };
    if (new Set(dates).size !== dates.length) return { error: tag + tr(lang, 'dup_dates') };
    for (const d of dates) {
      if (!DATE_RE.test(d) || d.slice(0, 7) !== month || isNaN(new Date(d))) return { error: tag + tr(lang, 'date_out', { d, month }) };
    }
    const fee = String(l.fee || '');
    if (!['', 'DONE', 'BELUM'].includes(fee) || (strict && !fee)) return { error: tag + tr(lang, 'need_fee') };
    const products = (Array.isArray(l.products) ? l.products : []).map(String);
    if (products.some((p) => !prods.includes(p))) return { error: tag + tr(lang, 'bad_product') };
    out.push({ uid, name, pkg, dates: dates.sort(), fee, products, remark: String(l.remark || '').slice(0, 200) });
  }
  if (strict && !out.length) return { error: tr(lang, 'no_lines') };
  return { lines: out };
}

async function saveClaim(u, month, lines, status, extra) {
  const p = claimPath(u, month);
  const cur = await getDoc(u.company_id, p);
  const data = Object.assign({}, cur || {}, { branch: u.branch, mt: u.mt, mtUserId: u.id, month, lines, status }, extra || {});
  await pool.query(
    `INSERT INTO tuition_docs (company_id, path, coll, data, updated_by, updated_at) VALUES ($1,$2,'claims',$3::jsonb,NULL, now())
     ON CONFLICT (company_id, path) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [u.company_id, p, JSON.stringify(data)]
  );
  await bump(u.company_id);
  return data;
}
function monthAllowed(month) {
  const n = new Date(), cur = n.getFullYear() * 12 + n.getMonth(), m = +month.slice(0, 4) * 12 + (+month.slice(5, 7) - 1);
  return m >= cur - 24 && m <= cur + 1;   // up to two years back (a late claim), one month ahead
}

router.put('/mt-claim/claim', mtAuth, async (req, res) => {
  const u = req.mt, month = String((req.body && req.body.month) || '');
  if (!MONTH_RE.test(month) || !monthAllowed(month)) return bad(res, req, 'invalid');
  const cur = await getDoc(u.company_id, claimPath(u, month));
  if (cur && ['submitted', 'approved'].includes(cur.status)) return bad(res, req, 'locked', 409);
  const r = await checkLines(u, month, req.body.lines, false, req);
  if (r.error) return res.status(400).json({ error: r.error });
  const d = await saveClaim(u, month, r.lines, cur && cur.status === 'returned' ? 'returned' : 'draft');
  res.json({ ok: true, claim: d });
});

router.post('/mt-claim/submit', mtAuth, async (req, res) => {
  const u = req.mt, month = String((req.body && req.body.month) || '');
  if (!MONTH_RE.test(month) || !monthAllowed(month)) return bad(res, req, 'invalid');
  const cur = await getDoc(u.company_id, claimPath(u, month));
  if (cur && ['submitted', 'approved'].includes(cur.status)) return bad(res, req, 'locked', 409);
  const r = await checkLines(u, month, req.body.lines, true, req);
  if (r.error) return res.status(400).json({ error: r.error });
  const d = await saveClaim(u, month, r.lines, 'submitted', { submittedAt: new Date().toISOString(), note: '' });
  res.json({ ok: true, claim: d });
});

router.use((err, req, res, next) => {
  console.error('mtClaim route error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Server error' });
});

module.exports = router;
module.exports.DEFAULT_PRODUCTS = DEFAULT_PRODUCTS;
