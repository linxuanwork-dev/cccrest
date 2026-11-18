const express = require('express');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { logActivity } = require('../lib/activity');
const bukkuApi = require('./bukkuApi').bukku;
const AC = require('../lib/acheck');
const Rules = require('../lib/acheckRules');
const T = require('../lib/tng');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers - same wrapper as dailySales.js.
['get', 'post', 'put', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

// 账目检查: the Owner (admin) only. The books are READ from Bukku; nothing is changed there. The review prompt is server/assets/acheck/prompt.md
// (the Owner can change it on the page); the AI key is typed on the page by the Owner and kept encrypted.

const DEFAULT_PROMPT = path.join(__dirname, '..', 'assets', 'acheck', 'prompt.md');
const DEFAULT_MODEL = 'claude-opus-5-5';
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2'];
const DECISIONS = ['open', 'ok', 'self_fix', 'back_to_staff', 'exempt'];
const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });
const guard = [requireAuth, requireRole('admin')];
const YMD = /^\d{4}-\d{2}-\d{2}$/;

async function cfgGet(key) { const { rows } = await pool.query('SELECT value FROM ac_config WHERE key = $1', [key]); return rows[0] ? rows[0].value : ''; }
async function cfgSet(key, value) { await pool.query('INSERT INTO ac_config (key, value, updated_at) VALUES ($1,$2, now()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()', [key, value]); }
const defaultPrompt = () => fs.readFileSync(DEFAULT_PROMPT, 'utf8');

// ============ settings: key, model, prompt ============

router.get('/ac/overview', ...guard, async (req, res) => {
  const custom = await cfgGet('prompt');
  const { rows: co } = await pool.query(
    `SELECT c.id, c.name, (b.company_id IS NOT NULL) AS bukku,
       (SELECT r.id FROM ac_runs r WHERE r.company_id = c.id ORDER BY r.id DESC LIMIT 1) AS last_run
       FROM companies c LEFT JOIN bukku_connections b ON b.company_id = c.id ORDER BY (b.company_id IS NULL), c.name`);
  res.json({ hasKey: !!(await cfgGet('api_key_enc')), model: (await cfgGet('model')) || DEFAULT_MODEL, models: MODELS, customPrompt: !!custom, companies: co.map((c) => ({ id: c.id, name: c.name, bukku: c.bukku, lastRun: c.last_run })) });
});

router.get('/ac/prompt', ...guard, async (req, res) => { const custom = await cfgGet('prompt'); res.json({ prompt: custom || defaultPrompt(), isDefault: !custom }); });

router.put('/ac/config', ...guard, async (req, res) => {
  const b = req.body || {};
  if (typeof b.apiKey === 'string' && b.apiKey.trim()) { await cfgSet('api_key_enc', bukkuApi.encrypt(b.apiKey.trim())); await logActivity(req.user.sub, 'Set the AI key for the account check', '', ''); }
  if (b.clearKey === true) await cfgSet('api_key_enc', '');
  if (typeof b.model === 'string' && MODELS.includes(b.model)) await cfgSet('model', b.model);
  if (b.prompt === null) await cfgSet('prompt', '');
  else if (typeof b.prompt === 'string') { if (b.prompt.trim().length < 200) return bad(res, 'Prompt 太短。'); await cfgSet('prompt', b.prompt); }
  res.json({ ok: true });
});

// ============ one client: settings + masters + exemptions ============

const clientOut = (r, name) => ({ companyId: r.company_id, name, sstRegistered: r.sst_registered, sstRate: Number(r.sst_rate), fyEnd: r.fy_end, nature: r.nature, materiality: Number(r.materiality), tolerance: Number(r.tolerance), staff: r.staff, prepayments: r.prepayments, accruals: r.accruals });

async function loadClient(companyId) {
  const { rows: co } = await pool.query('SELECT id, name FROM companies WHERE id = $1', [companyId]);
  if (!co[0]) return null;
  const { rows } = await pool.query('SELECT * FROM ac_clients WHERE company_id = $1', [companyId]);
  return clientOut(rows[0] || { company_id: co[0].id, sst_registered: false, sst_rate: 0, fy_end: '', nature: '', materiality: 0, tolerance: 0.05, staff: '', prepayments: '', accruals: '' }, co[0].name);
}

router.get('/ac/clients/:id', ...guard, async (req, res) => {
  const c = await loadClient(Number(req.params.id) || 0); if (!c) return res.status(404).json({ error: 'Not found' });
  const { rows } = await pool.query('SELECT id, rule_id, title, detail, note, created_at FROM ac_whitelist WHERE company_id = $1 ORDER BY id DESC', [c.companyId]);
  res.json({ client: c, whitelist: rows.map((w) => ({ id: w.id, ruleId: w.rule_id, title: w.title, detail: w.detail, note: w.note, createdAt: w.created_at })) });
});

router.put('/ac/clients/:id', ...guard, async (req, res) => {
  const c = await loadClient(Number(req.params.id) || 0); if (!c) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {}, n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0), t = (v, m) => String(v == null ? '' : v).slice(0, m);
  await pool.query(
    `INSERT INTO ac_clients (company_id, sst_registered, sst_rate, fy_end, nature, materiality, tolerance, staff, prepayments, accruals, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (company_id) DO UPDATE SET sst_registered = $2, sst_rate = $3, fy_end = $4, nature = $5, materiality = $6, tolerance = $7, staff = $8, prepayments = $9, accruals = $10, updated_at = now()`,
    [c.companyId, !!b.sstRegistered, n(b.sstRate), t(b.fyEnd, 40), t(b.nature, 300), n(b.materiality), n(b.tolerance), t(b.staff, 80), t(b.prepayments, 6000), t(b.accruals, 6000)]);
  res.json({ ok: true });
});

router.delete('/ac/clients/:id/whitelist/:wid', ...guard, async (req, res) => {
  await pool.query('DELETE FROM ac_whitelist WHERE id = $1 AND company_id = $2', [Number(req.params.wid) || 0, Number(req.params.id) || 0]);
  res.json({ ok: true });
});

// ============ runs ============

const runOut = (r, full) => ({
  id: r.id, companyId: r.company_id, company: r.company, engine: r.engine, from: String(r.period_from).slice(0, 10), to: String(r.period_to).slice(0, 10), mode: r.mode, status: r.status, progress: r.progress, staff: r.staff, model: r.model,
  prevRunId: r.prev_run_id, error: r.error, createdAt: r.created_at, finishedAt: r.finished_at, summary: r.result && r.result.summary ? r.result.summary : null,
  ...(full ? { stats: r.stats, result: r.result, decisions: r.decisions, usage: r.usage } : {})
});

router.get('/ac/runs', ...guard, async (req, res) => {
  const cid = Number(req.query.companyId) || 0;
  const { rows } = await pool.query(
    `SELECT r.*, c.name AS company FROM ac_runs r JOIN companies c ON c.id = r.company_id WHERE ($1 = 0 OR r.company_id = $1) ORDER BY r.id DESC LIMIT 60`, [cid]);
  res.json({ runs: rows.map((r) => runOut(r, false)) });
});

router.get('/ac/runs/:id', ...guard, async (req, res) => {
  const { rows } = await pool.query('SELECT r.*, c.name AS company FROM ac_runs r JOIN companies c ON c.id = r.company_id WHERE r.id = $1', [Number(req.params.id) || 0]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(runOut(rows[0], true));
});

router.delete('/ac/runs/:id', ...guard, async (req, res) => {
  await pool.query("DELETE FROM ac_runs WHERE id = $1 AND status IN ('done','failed')", [Number(req.params.id) || 0]);
  res.json({ ok: true });
});

router.post('/ac/runs', ...guard, async (req, res) => {
  const b = req.body || {}, companyId = Number(b.companyId) || 0;
  const client = await loadClient(companyId); if (!client) return bad(res, '请选公司。');
  if (!YMD.test(String(b.from || '')) || !YMD.test(String(b.to || '')) || b.from > b.to) return bad(res, '请选好「从」和「到」的日期。');
  if (Math.round((new Date(b.to) - new Date(b.from)) / 86400000) > 400) return bad(res, '一次最多检查 13 个月。');
  const engine = b.engine === 'ai' ? 'ai' : 'rules';
  if (engine === 'ai' && !(await cfgGet('api_key_enc'))) return bad(res, '还没有设置 AI 的 key（页面下方「AI 设置」）。用「程序检查」不需要 key。');
  const conn = await bukkuApi.loadConn(companyId);
  if (!conn) return bad(res, '这家公司还没有连接 Bukku（Control Panel > Bukku API）。');
  const { rows: busy } = await pool.query("SELECT id FROM ac_runs WHERE status IN ('queued','fetching','analysing') AND created_at > now() - interval '40 minutes'");
  if (busy[0]) return bad(res, '现在已经有一个检查在跑（第 ' + busy[0].id + ' 号），请等它完成。');
  let mode = b.mode === 'recheck' ? 'recheck' : 'first', prev = null;
  if (mode === 'recheck') {
    const { rows: pr } = await pool.query("SELECT * FROM ac_runs WHERE company_id = $1 AND status = 'done' AND ($2::int IS NULL OR id = $2::int) ORDER BY id DESC LIMIT 1", [companyId, Number(b.prevRunId) || null]);
    if (!pr[0]) return bad(res, '找不到上一次已完成的检查，不能复查。'); prev = pr[0];
  }
  const model = engine === 'ai' ? ((await cfgGet('model')) || DEFAULT_MODEL) : '';
  const { rows } = await pool.query(
    `INSERT INTO ac_runs (company_id, period_from, period_to, mode, status, staff, model, prev_run_id, created_by, engine) VALUES ($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9) RETURNING id`,
    [companyId, b.from, b.to, mode, String(b.staff || client.staff || '').slice(0, 80), model, prev ? prev.id : null, req.user.sub, engine]);
  await logActivity(req.user.sub, 'Started an account check', client.name, b.from + ' ~ ' + b.to + ' (' + mode + ', ' + engine + ')');
  runJob(rows[0].id, conn, client, prev).catch((e) => console.error('account check', e));
  res.status(201).json({ id: rows[0].id });
});

const setRun = (id, f) => pool.query(
  `UPDATE ac_runs SET status = COALESCE($2, status), progress = COALESCE($3, progress), stats = COALESCE($4::jsonb, stats), result = COALESCE($5::jsonb, result), usage = COALESCE($6::jsonb, usage), error = COALESCE($7, error),
     finished_at = CASE WHEN $2 IN ('done','failed') THEN now() ELSE finished_at END WHERE id = $1`,
  [id, f.status || null, f.progress == null ? null : f.progress, f.stats ? JSON.stringify(f.stats) : null, f.result ? JSON.stringify(f.result) : null, f.usage ? JSON.stringify(f.usage) : null, f.error == null ? null : f.error]);

// what the system itself keeps for the prompt
async function extraFor(client, run, prev) {
  const e = {};
  e.clientSettings = JSON.stringify({ company: client.name, sst_registered: client.sstRegistered, sst_rate: client.sstRate, financial_year_end: client.fyEnd || '(没填)', business_nature: client.nature || '(没填)', materiality_amount: client.materiality || '(没填)', reconciliation_tolerance: client.tolerance });
  e.prepayments = client.prepayments.trim(); e.accruals = client.accruals.trim();
  const { rows: wl } = await pool.query('SELECT rule_id, title, detail, note FROM ac_whitelist WHERE company_id = $1 ORDER BY id', [client.companyId]);
  e.whitelist = wl.map((w) => [w.rule_id, w.title, w.detail, w.note].join(' | ')).join('\n');
  if (prev && prev.result) {
    const dec = prev.decisions || {};
    e.previous = JSON.stringify((prev.result.issues || []).map((x) => ({ id: x.id, rule_id: x.rule_id, severity: x.severity, title: x.title, detail: x.detail, evidence: x.evidence, amount_difference: x.amount_difference, handling: (dec[x.id] || {}).decision || 'open', handling_note: (dec[x.id] || {}).note || '' })));
  }
  // the TNG / platform settlement reports of the period that this system holds (daily, per outlet)
  try {
    const { rows: files } = await pool.query(`SELECT id, original_name, data FROM tng_files WHERE company_id = $1 AND period >= $2 AND period <= $3 ORDER BY period, id`, [client.companyId, String(run.period_from).slice(0, 7), String(run.period_to).slice(0, 7)]);
    const out = [];
    for (const f of files) {
      try {
        const p = await T.parseReport(f.data, f.original_name);
        for (const o of T.groupOutlets(p.rows)) {
          const s = T.summarise(o.rows, p.meta.period);
          s.days.filter((d) => d.count && d.ymd >= String(run.period_from).slice(0, 10) && d.ymd <= String(run.period_to).slice(0, 10)).forEach((d) => out.push([o.name, d.ymd, d.count, (d.gross / 100).toFixed(2), ((d.comm + d.gst) / 100).toFixed(2), (d.net / 100).toFixed(2), d.settle].join('|')));
        }
      } catch (err) { /* a file that cannot be read is skipped */ }
    }
    if (out.length) e.settlement = 'outlet|date|count|gross|commission+gst|net_settlement|settlement_date\n' + out.join('\n');
    if (out.length) e.settlementRows = out.map((l) => { const a = l.split('|'); return { outlet: a[0], ymd: a[1], count: Number(a[2]), gross: Number(a[3]), net: Number(a[5]), settle: a[6] }; });
  } catch (err) { /* the TNG tables may not be there */ }
  return e;
}

async function runJob(runId, conn, client, prev) {
  try {
    const { rows } = await pool.query('SELECT * FROM ac_runs WHERE id = $1', [runId]); const run = rows[0];
    await setRun(runId, { status: 'fetching', progress: '开始从 Bukku 读取…' });
    const from = String(run.period_from).slice(0, 10), to = String(run.period_to).slice(0, 10);
    let last = 0;
    const data = await AC.collect({ get: (p, q) => bukkuApi.get(conn, p, q), from, to, progress: (t) => { const n = Date.now(); if (n - last > 1500) { last = n; setRun(runId, { progress: t }).catch(() => {}); } } });
    const counts = {}; AC.SOURCES.forEach((s) => { counts[s.key] = (data.period[s.key] || []).length; });
    const extra = await extraFor(client, run, prev);
    if (run.engine === 'rules') {
      await setRun(runId, { status: 'analysing', progress: '程序正在检查…', stats: { counts, notes: data.notes, outstanding: { invoices: data.outstanding.invoices.length, bills: data.outstanding.bills.length } } });
      const { rows: wl } = await pool.query('SELECT rule_id, title FROM ac_whitelist WHERE company_id = $1', [client.companyId]);
      const found = Rules.runRules({ data, client, extra, today: new Date().toISOString().slice(0, 10) });
      const result = Rules.finish({ run: Object.assign({}, run, { company: client.name }), found, whitelist: wl, prev, prevDecisions: prev ? prev.decisions : {} });
      result.system_notes = data.notes;
      await setRun(runId, { status: 'done', progress: '完成', result });
      return;
    }
    const { parts, notes } = AC.buildParts({ data, extra, mode: run.mode, staff: run.staff, today: new Date().toISOString().slice(0, 10) });
    const template = (await cfgGet('prompt')) || defaultPrompt();
    const prompt = AC.fillPrompt(template, parts);
    const stats = { counts, notes: data.notes.concat(notes), promptChars: prompt.length, outstanding: { invoices: data.outstanding.invoices.length, bills: data.outstanding.bills.length } };
    await setRun(runId, { status: 'analysing', progress: 'AI 正在检查（' + counts.bills + ' 张 bill、' + counts.invoices + ' 张 invoice 等，要几分钟）…', stats });
    const apiKey = bukkuApi.decrypt(await cfgGet('api_key_enc'));
    const { text, usage } = await AC.callClaude({ apiKey, model: run.model, prompt, maxTokens: 20000, onText: (n) => { const t = Date.now(); if (t - last > 3000) { last = t; setRun(runId, { progress: 'AI 正在写结果…（已写 ' + n + ' 个字）' }).catch(() => {}); } } });
    const result = AC.parseAnswer(text);
    // what the system knows that the AI was not given
    const known = ['Bank Statement（Bukku 没有这项资料，可以之后加）', 'Salary Summary', '上月已核准 Trial Balance'].filter((x) => !(result.missing_data || []).some((m) => String(m).includes(x.split('（')[0])));
    result.system_notes = stats.notes.concat(known.map((k) => '这次没有提供：' + k));
    await setRun(runId, { status: 'done', progress: '完成', result, usage });
  } catch (e) {
    await setRun(runId, { status: 'failed', progress: '', error: String(e.message || e).slice(0, 500) });
  }
}

// at start-up: a check that was running when the server restarted cannot finish
pool.query("UPDATE ac_runs SET status = 'failed', error = '服务器重新启动了，这次检查中断，请再开始一次。', finished_at = now() WHERE status IN ('queued','fetching','analysing')").catch(() => {});

// ============ the Owner's decision on one issue ============

router.put('/ac/runs/:id/decision', ...guard, async (req, res) => {
  const b = req.body || {}; const decision = String(b.decision || '');
  if (!DECISIONS.includes(decision)) return bad(res, 'Invalid request');
  const { rows } = await pool.query('SELECT r.*, c.name AS company FROM ac_runs r JOIN companies c ON c.id = r.company_id WHERE r.id = $1', [Number(req.params.id) || 0]);
  const run = rows[0]; if (!run) return res.status(404).json({ error: 'Not found' });
  const issue = ((run.result && run.result.issues) || []).find((x) => String(x.id) === String(b.issueId));
  if (!issue) return bad(res, '找不到这一项。');
  const dec = Object.assign({}, run.decisions || {}); dec[issue.id] = { decision, note: String(b.note || '').slice(0, 500), at: new Date().toISOString() };
  await pool.query('UPDATE ac_runs SET decisions = $2::jsonb WHERE id = $1', [run.id, JSON.stringify(dec)]);
  if (decision === 'exempt') {
    const detail = (issue.evidence || []).map((e) => [e.doc_no, e.date, e.party, e.amount].filter((x) => x !== undefined && x !== null && x !== '').join(' ')).join('; ').slice(0, 600);
    const { rows: ex } = await pool.query('SELECT id FROM ac_whitelist WHERE company_id = $1 AND rule_id = $2 AND title = $3', [run.company_id, String(issue.rule_id || ''), String(issue.title || '')]);
    if (!ex[0]) await pool.query('INSERT INTO ac_whitelist (company_id, rule_id, title, detail, note) VALUES ($1,$2,$3,$4,$5)', [run.company_id, String(issue.rule_id || ''), String(issue.title || '').slice(0, 300), detail, String(b.note || '').slice(0, 300)]);
  }
  res.json({ ok: true });
});

// ============ the list for the staff (Excel) ============

router.get('/ac/runs/:id/export', ...guard, async (req, res) => {
  const { rows } = await pool.query('SELECT r.*, c.name AS company FROM ac_runs r JOIN companies c ON c.id = r.company_id WHERE r.id = $1', [Number(req.params.id) || 0]);
  const run = rows[0]; if (!run || !run.result) return res.status(404).json({ error: 'Not found' });
  const dec = run.decisions || {}, onlyStaff = req.query.all !== '1';
  const list = (run.result.issues || []).filter((x) => (onlyStaff ? (dec[x.id] || {}).decision === 'back_to_staff' : true));
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Issues');
  ws.columns = [{ header: '#', width: 5 }, { header: 'Severity', width: 9 }, { header: 'Rule', width: 7 }, { header: 'Category', width: 16 }, { header: 'Issue', width: 50 }, { header: 'Detail', width: 70 }, { header: 'Evidence', width: 60 }, { header: 'Amount', width: 12 }, { header: 'Check', width: 50 }, { header: 'Affects', width: 36 }, { header: 'Decision', width: 14 }, { header: 'Note', width: 36 }];
  list.forEach((x) => ws.addRow([x.id, x.severity, x.rule_id, x.category, x.title, x.detail, (x.evidence || []).map((e) => [e.source, e.doc_no, e.date, e.party, e.amount].filter((v) => v !== undefined && v !== '').join(' ')).join('\n'), x.amount_difference, x.suggested_check, (x.affects || []).join(', '), (dec[x.id] || {}).decision || 'open', (dec[x.id] || {}).note || '']));
  ws.getRow(1).font = { bold: true }; ws.views = [{ state: 'frozen', ySplit: 1 }]; ws.eachRow((r) => { r.alignment = { vertical: 'top', wrapText: true }; });
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="' + run.company.replace(/[^A-Za-z0-9]+/g, '-') + '-account-check-' + String(run.period_from).slice(0, 7) + (onlyStaff ? '-for-staff' : '') + '.xlsx"');
  res.send(buf);
});

router.get('/ac/app', requireAuth, requireRole('admin'), (req, res) => { res.sendFile(path.join(__dirname, '..', 'assets', 'acheck', 'app.html')); });

module.exports = router;
