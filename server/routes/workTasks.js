const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { logActivity } = require('../lib/activity');
const purchaseRouter = require('./purchaseBukku');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers - same wrapper as dailySales.js.
['get', 'post', 'put', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

// Work list (Workflow): tasks for the CC CREST team. The person ticks "done", the Owner ticks "checked".
// Monthly bills (work_recurring) make a "collect the bill" and a "pay the bill" task every month.

const bad = (res, msg) => res.status(400).json({ error: msg });
const clean = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const TEAM = ['admin', 'manager', 'staff'];

// today in Malaysia (the server may run in another time zone)
function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
}
const pad = (n) => String(n).padStart(2, '0');
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysIn(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function validDate(s) {
  if (!DATE_RE.test(s || '')) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

// users a manager may give work to: self + own team
async function teamUserIds(managerUserId) {
  const { rows } = await pool.query(
    `SELECT u.id FROM users u WHERE u.active AND u.staff_id IN (SELECT staff_id FROM manager_staff WHERE manager_user_id = $1)`,
    [managerUserId]
  );
  return rows.map((r) => r.id);
}
async function canAssignTo(req, userId) {
  const { rows } = await pool.query('SELECT id, role, active FROM users WHERE id = $1', [userId]);
  const u = rows[0];
  if (!u || !u.active || !TEAM.includes(u.role)) return false;
  if (req.user.role === 'admin') return true;
  if (u.id === req.user.sub) return true;
  return (await teamUserIds(req.user.sub)).includes(u.id);
}

// ============ monthly bills -> tasks ============

// the tasks a monthly bill makes for one month: [{kind, due, user}]
function plannedTasks(rec, ym) {
  const [y, m] = ym.split('-').map(Number);
  const payDue = `${ym}-${pad(Math.min(rec.due_day, daysIn(y, m)))}`;
  const out = [];
  if (rec.needs_collect) out.push({ kind: 'collect', due: addDays(payDue, -rec.collect_days_before), user: rec.collect_user_id });
  out.push({ kind: 'pay', due: payDue, user: rec.pay_user_id });
  return out;
}
const taskTitle = (rec, kind) => (kind === 'collect' ? '拿单 Collect bill: ' : '付款 Pay bill: ') + rec.title;

// Make the tasks of every active monthly bill from the month it was made until about two weeks ahead (idempotent).
async function ensureRecurring(db) {
  const d = db || pool;
  const t = today();
  const horizon = addDays(t, 14).slice(0, 7);
  const { rows: recs } = await d.query(
    `SELECT r.*, (r.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text AS created_day FROM work_recurring r WHERE r.active`
  );
  for (const rec of recs) {
    let ym = rec.created_day.slice(0, 7);
    for (let guard = 0; guard < 24 && ym <= horizon; guard++) {
      for (const p of plannedTasks(rec, ym)) {
        const payDue = plannedTasks(rec, ym).find((x) => x.kind === 'pay').due;
        // a month whose payment day had already passed when the bill was set up is not asked for
        if (payDue < rec.created_day) continue;
        // a task is made once; a later change of the bill updates it (see updateOpenTasks), never creates it twice
        await d.query(
          `INSERT INTO work_tasks (company_id, title, kind, assignee_user_id, due_date, recurring_id, period, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (recurring_id, period, kind) WHERE recurring_id IS NOT NULL DO NOTHING`,
          [rec.company_id, taskTitle(rec, p.kind), p.kind, p.user, p.due, rec.id, ym, rec.created_by]
        );
      }
      const [y, m] = ym.split('-').map(Number);
      ym = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
    }
  }
}

// after a monthly bill was edited: the tasks nobody has done yet follow the new title / day / people
async function updateOpenTasks(rec) {
  if (!rec.active) { await pool.query(`DELETE FROM work_tasks WHERE recurring_id = $1 AND status = 'todo'`, [rec.id]); return; }
  const { rows } = await pool.query(`SELECT id, kind, period FROM work_tasks WHERE recurring_id = $1 AND status = 'todo'`, [rec.id]);
  for (const r of rows) {
    const p = plannedTasks(rec, r.period).find((x) => x.kind === r.kind);
    if (!p) { await pool.query('DELETE FROM work_tasks WHERE id = $1', [r.id]); continue; }
    await pool.query('UPDATE work_tasks SET title = $2, due_date = $3, assignee_user_id = $4, company_id = $5 WHERE id = $1',
      [r.id, taskTitle(rec, r.kind), p.due, p.user, rec.company_id]);
  }
}

// ============ people & tasks ============

router.get('/work/people', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  let rows;
  if (req.user.role === 'admin') {
    ({ rows } = await pool.query(`SELECT id, display_name, role FROM users WHERE active AND role = ANY($1) ORDER BY display_name`, [TEAM]));
  } else {
    const ids = [req.user.sub, ...(await teamUserIds(req.user.sub))];
    ({ rows } = await pool.query(`SELECT id, display_name, role FROM users WHERE active AND id = ANY($1) ORDER BY display_name`, [ids]));
  }
  res.json(rows.map((r) => ({ id: r.id, name: r.display_name, role: r.role })));
});

const taskOut = (r, t) => ({
  id: r.id, title: r.title, note: r.note || '', kind: r.kind, status: r.status, due: r.due,
  companyId: r.company_id, company: r.company_name || '', assigneeId: r.assignee_user_id, assignee: r.assignee_name || '',
  doneBy: r.done_by_name || '', doneAt: r.done_at, checkedBy: r.checked_by_name || '', checkedAt: r.checked_at,
  recurringId: r.recurring_id, overdue: r.status === 'todo' && r.due < t, createdBy: r.created_by
});

// which tasks a person may see: the Owner all, a manager own + team's + the ones made by them, staff own
async function scopeSql(req, params) {
  if (req.user.role === 'admin') return 'TRUE';
  params.push(req.user.sub);
  const me = '$' + params.length;
  if (req.user.role === 'manager') {
    const ids = await teamUserIds(req.user.sub);
    params.push(ids);
    return `(w.assignee_user_id = ${me} OR w.created_by = ${me} OR w.assignee_user_id = ANY($${params.length}::int[]))`;
  }
  return `w.assignee_user_id = ${me}`;
}

const TASK_SELECT = `
  SELECT w.id, w.company_id, w.title, w.note, w.kind, w.assignee_user_id, w.due_date::text AS due, w.status, w.done_at, w.checked_at,
         w.recurring_id, w.created_by, c.name AS company_name, au.display_name AS assignee_name,
         du.display_name AS done_by_name, cu.display_name AS checked_by_name
    FROM work_tasks w
    LEFT JOIN companies c ON c.id = w.company_id
    LEFT JOIN users au ON au.id = w.assignee_user_id
    LEFT JOIN users du ON du.id = w.done_by
    LEFT JOIN users cu ON cu.id = w.checked_by`;

// The tasks of one month (by due date) plus everything older that is not checked yet, and the progress of the month.
router.get('/work/tasks', requireAuth, requireRole(...TEAM), async (req, res) => {
  await ensureRecurring();
  const t = today();
  const month = MONTH_RE.test(req.query.month || '') ? req.query.month : t.slice(0, 7);
  const params = [month];
  const scope = await scopeSql(req, params);
  const { rows } = await pool.query(
    `${TASK_SELECT} WHERE ${scope} AND (to_char(w.due_date, 'YYYY-MM') = $1 OR (w.status <> 'checked' AND to_char(w.due_date, 'YYYY-MM') < $1))
      ORDER BY (w.status = 'checked'), w.due_date, w.id`,
    params
  );
  const tasks = rows.map((r) => taskOut(r, t));
  const inMonth = tasks.filter((x) => x.due.slice(0, 7) === month);
  const progress = { total: inMonth.length, done: inMonth.filter((x) => x.status !== 'todo').length, checked: inMonth.filter((x) => x.status === 'checked').length, byPerson: [] };
  const people = new Map();
  inMonth.forEach((x) => {
    const k = x.assigneeId || 0;
    if (!people.has(k)) people.set(k, { id: k, name: x.assignee || '—', total: 0, done: 0, checked: 0 });
    const p = people.get(k); p.total++; if (x.status !== 'todo') p.done++; if (x.status === 'checked') p.checked++;
  });
  progress.byPerson = [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
  res.json({ month, today: t, me: req.user.sub, tasks, progress });
});

// numbers for the menu badge: my open tasks due within 3 days (or late), and, for the Owner, the ones waiting to be checked
router.get('/work/summary', requireAuth, requireRole(...TEAM), async (req, res) => {
  await ensureRecurring();
  const t = today();
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'todo' AND assignee_user_id = $1 AND due_date <= $2::date + 3)::int AS mine_open,
            COUNT(*) FILTER (WHERE status = 'todo' AND assignee_user_id = $1 AND due_date < $2::date)::int AS mine_overdue,
            COUNT(*) FILTER (WHERE status = 'done')::int AS to_check
       FROM work_tasks`,
    [req.user.sub, t]
  );
  res.json({ mineOpen: rows[0].mine_open, mineOverdue: rows[0].mine_overdue, toCheck: req.user.role === 'admin' ? rows[0].to_check : 0 });
});

function cleanTask(b) {
  const title = clean(b.title, 200);
  if (!title) return { error: '请填事项。 The task title is required.' };
  if (!validDate(b.due)) return { error: '请选到期日。 Choose the due date.' };
  return { title, note: clean(b.note, 500), due: b.due, companyId: Number(b.companyId) || null, assigneeId: Number(b.assigneeId) || null };
}

router.post('/work/tasks', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  const b = cleanTask(req.body || {});
  if (b.error) return bad(res, b.error);
  if (!b.assigneeId) return bad(res, '请选负责人。 Choose who does it.');
  if (!await canAssignTo(req, b.assigneeId)) return bad(res, '不能把事项交给这个人。 You cannot give work to this person.');
  const { rows } = await pool.query(
    `INSERT INTO work_tasks (company_id, title, note, kind, assignee_user_id, due_date, created_by) VALUES ($1,$2,$3,'general',$4,$5,$6) RETURNING id`,
    [b.companyId, b.title, b.note || null, b.assigneeId, b.due, req.user.sub]
  );
  await logActivity(req.user.sub, 'Added a task', b.title, 'due ' + b.due);
  res.status(201).json({ id: rows[0].id });
});

async function loadTask(id) {
  const { rows } = await pool.query('SELECT * FROM work_tasks WHERE id = $1', [Number(id) || 0]);
  return rows[0];
}
const mayManage = (req, task) => req.user.role === 'admin' || (req.user.role === 'manager' && task.created_by === req.user.sub);

router.put('/work/tasks/:id', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  const task = await loadTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (!mayManage(req, task)) return res.status(403).json({ error: 'Not allowed' });
  const b = cleanTask(req.body || {});
  if (b.error) return bad(res, b.error);
  if (!b.assigneeId || !await canAssignTo(req, b.assigneeId)) return bad(res, '不能把事项交给这个人。 You cannot give work to this person.');
  await pool.query('UPDATE work_tasks SET title = $2, note = $3, due_date = $4, company_id = $5, assignee_user_id = $6 WHERE id = $1',
    [task.id, b.title, b.note || null, b.due, b.companyId, b.assigneeId]);
  res.json({ ok: true });
});

router.delete('/work/tasks/:id', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  const task = await loadTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (!mayManage(req, task)) return res.status(403).json({ error: 'Not allowed' });
  if (task.recurring_id) return bad(res, '这是每月固定还款生成的事项，要删请到 Workflow 的「每月固定还款」里删除或停用。 This task comes from a monthly bill - remove or switch off the monthly bill in Workflow instead.');
  await pool.query('DELETE FROM work_tasks WHERE id = $1', [task.id]);
  await logActivity(req.user.sub, 'Deleted a task', task.title, null);
  res.json({ ok: true });
});

// "Done": the person it was given to (or the Owner, or the manager of that person's team)
router.post('/work/tasks/:id/done', requireAuth, requireRole(...TEAM), async (req, res) => {
  const task = await loadTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  let ok = req.user.role === 'admin' || task.assignee_user_id === req.user.sub;
  if (!ok && req.user.role === 'manager' && task.assignee_user_id) ok = (await teamUserIds(req.user.sub)).includes(task.assignee_user_id);
  if (!ok) return res.status(403).json({ error: 'Not allowed' });
  const done = !(req.body && req.body.done === false);
  if (task.status === 'checked') return bad(res, '已经检查过了，不能再改。 Already checked - the Owner can untick the check first.');
  if (done) await pool.query(`UPDATE work_tasks SET status = 'done', done_by = $2, done_at = now() WHERE id = $1`, [task.id, req.user.sub]);
  else await pool.query(`UPDATE work_tasks SET status = 'todo', done_by = NULL, done_at = NULL WHERE id = $1`, [task.id]);
  res.json({ ok: true, status: done ? 'done' : 'todo' });
});

// "Checked": the Owner only, after it is done
router.post('/work/tasks/:id/check', requireAuth, requireRole('admin'), async (req, res) => {
  const task = await loadTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  const checked = !(req.body && req.body.checked === false);
  if (checked) {
    if (task.status === 'todo') return bad(res, '还没有人勾「已做」。 Nobody has ticked it as done yet.');
    await pool.query(`UPDATE work_tasks SET status = 'checked', checked_by = $2, checked_at = now() WHERE id = $1`, [task.id, req.user.sub]);
  } else {
    await pool.query(`UPDATE work_tasks SET status = 'done', checked_by = NULL, checked_at = NULL WHERE id = $1`, [task.id]);
  }
  // a payment of a purchase bill that the Owner has now checked: record it in Bukku (when that is switched on for the company)
  let bukku = null;
  if (checked && task.purchase_bill_id) {
    try { bukku = await purchaseRouter.recordBukkuPayment(task.purchase_bill_id, req.user.sub); } catch (e) { bukku = { error: e.message }; }
  }
  res.json({ ok: true, status: checked ? 'checked' : 'done', bukku });
});

// ============ purchase bills that need someone's attention (shown in My Jobs) ============

router.get('/work/purchase-reminders', requireAuth, requireRole(...TEAM), async (req, res) => {
  const params = [];
  let scope = 'TRUE';
  if (req.user.role !== 'admin') {
    const staffIds = [];
    if (req.user.staffId) staffIds.push(req.user.staffId);
    if (req.user.role === 'manager') {
      const { rows } = await pool.query('SELECT staff_id FROM manager_staff WHERE manager_user_id = $1', [req.user.sub]);
      rows.forEach((r) => staffIds.push(r.staff_id));
    }
    params.push(staffIds);
    scope = 'c.id IN (SELECT company_id FROM company_staff WHERE staff_id = ANY($1::int[]))';
  }
  const { rows } = await pool.query(
    `SELECT c.id, c.name,
       COUNT(*) FILTER (WHERE b.approved_at IS NULL AND NOT b.imported AND b.status <> 'exported')::int AS to_approve,
       COUNT(*) FILTER (WHERE b.no_original)::int AS no_original,
       COUNT(*) FILTER (WHERE b.approved_at IS NOT NULL AND b.in_bukku_at IS NULL)::int AS to_bukku,
       COUNT(*) FILTER (WHERE b.approved_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM work_tasks t WHERE t.purchase_bill_id = b.id AND t.kind = 'pay'))::int AS to_pay
     FROM companies c
     JOIN purchase_bukku_settings s ON s.company_id = c.id AND s.enabled
     JOIN purchase_bukku_bills b ON b.company_id = c.id
     WHERE ${scope}
     GROUP BY c.id, c.name ORDER BY c.name`, params);
  res.json({ companies: rows.filter((r) => r.to_approve || r.no_original || r.to_bukku || r.to_pay).map((r) => ({ id: r.id, name: r.name, toApprove: r.to_approve, noOriginal: r.no_original, toBukku: r.to_bukku, toPay: r.to_pay })) });
});

// ============ the whole purchase flow, bill by bill: where is every bill now ============
// A Approve waits - B approved, not in Bukku yet (companies that use Bukku) - C approved, no payment asked for yet -
// D payment asked: the manager still has to go to the bank - E the manager paid: waiting for the Owner's bank check - F finished (last 30 days)
router.get('/work/purchase-pipeline', requireAuth, requireRole(...TEAM), async (req, res) => {
  const params = [];
  let scope = 'TRUE';
  if (req.user.role !== 'admin') {
    const staffIds = [];
    if (req.user.staffId) staffIds.push(req.user.staffId);
    if (req.user.role === 'manager') {
      const { rows } = await pool.query('SELECT staff_id FROM manager_staff WHERE manager_user_id = $1', [req.user.sub]);
      rows.forEach((r) => staffIds.push(r.staff_id));
    }
    params.push(staffIds);
    scope = 'c.id IN (SELECT company_id FROM company_staff WHERE staff_id = ANY($1::int[]))';
  }
  const base = `FROM purchase_bukku_bills b
      JOIN companies c ON c.id = b.company_id
      JOIN purchase_bukku_settings s ON s.company_id = c.id AND s.enabled
      LEFT JOIN bukku_connections bc ON bc.company_id = c.id
      LEFT JOIN LATERAL (SELECT t.id, t.status, t.due_date::text AS due, t.assignee_user_id, t.done_by, t.done_at, t.checked_at FROM work_tasks t
                          WHERE t.purchase_bill_id = b.id AND t.kind = 'pay' ORDER BY t.id DESC LIMIT 1) pt ON true
      LEFT JOIN users au ON au.id = pt.assignee_user_id
      LEFT JOIN users du ON du.id = pt.done_by
     WHERE ${scope}`;
  const { rows: counts } = await pool.query(
    `SELECT c.id, c.name, (bc.company_id IS NOT NULL) AS has_bukku,
       COUNT(*) FILTER (WHERE b.approved_at IS NULL AND NOT b.imported AND b.status <> 'exported')::int AS a,
       COUNT(*) FILTER (WHERE b.approved_at IS NOT NULL AND pt.id IS NULL AND bc.company_id IS NOT NULL AND b.bukku_txn_id IS NULL)::int AS b,
       COUNT(*) FILTER (WHERE b.approved_at IS NOT NULL AND pt.id IS NULL AND (bc.company_id IS NULL OR b.bukku_txn_id IS NOT NULL))::int AS c,
       COUNT(*) FILTER (WHERE pt.status = 'todo')::int AS d,
       COUNT(*) FILTER (WHERE pt.status = 'done')::int AS e,
       COUNT(*) FILTER (WHERE pt.status = 'checked' AND pt.checked_at > now() - interval '30 days')::int AS f
     ${base} GROUP BY c.id, c.name, bc.company_id ORDER BY c.name`, params);
  const { rows: wait } = await pool.query(
    `SELECT c.name AS company, b.supplier, b.no, b.total, b.paid_by, pt.id AS task_id, pt.status, pt.due, au.display_name AS assignee, du.display_name AS done_by_name, pt.done_at
     ${base} AND pt.status IN ('todo','done') ORDER BY (pt.status = 'done') DESC, pt.due, b.id LIMIT 300`, params);
  const t = today();
  res.json({
    today: t,
    companies: counts.filter((r) => r.a || r.b || r.c || r.d || r.e || r.f).map((r) => ({ id: r.id, name: r.name, hasBukku: r.has_bukku, a: r.a, b: r.b, c: r.c, d: r.d, e: r.e, f: r.f })),
    waiting: wait.map((r) => ({ company: r.company, supplier: r.supplier, no: r.no, total: Number(r.total), paidBy: r.paid_by || '', taskId: r.task_id, stage: r.status === 'done' ? 'e' : 'd', due: r.due, late: r.status === 'todo' && r.due < t, assignee: r.assignee || '', doneBy: r.done_by_name || '', doneAt: r.done_at }))
  });
});

// ============ monthly bills (Owner) ============

const recOut = (r) => ({
  id: r.id, companyId: r.company_id, company: r.company_name || '', title: r.title, dueDay: r.due_day, needsCollect: r.needs_collect,
  collectDaysBefore: r.collect_days_before, collectUserId: r.collect_user_id, collectUser: r.collect_name || '',
  payUserId: r.pay_user_id, payUser: r.pay_name || '', active: r.active
});

router.get('/work/recurring', requireAuth, requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.*, c.name AS company_name, cu.display_name AS collect_name, pu.display_name AS pay_name
       FROM work_recurring r LEFT JOIN companies c ON c.id = r.company_id
       LEFT JOIN users cu ON cu.id = r.collect_user_id LEFT JOIN users pu ON pu.id = r.pay_user_id
      ORDER BY r.active DESC, r.due_day, r.title`
  );
  res.json(rows.map(recOut));
});

async function cleanRecurring(req, b) {
  const title = clean(b.title, 150);
  if (!title) return { error: '请填名称（例如：租金）。 The name is required (e.g. Rent).' };
  const dueDay = Math.round(Number(b.dueDay));
  if (!(dueDay >= 1 && dueDay <= 31)) return { error: '每月几号要还：1 到 31。 The day of the month to pay: 1 to 31.' };
  const needsCollect = b.needsCollect !== false;
  const before = Math.round(Number(b.collectDaysBefore));
  const collectDaysBefore = before >= 0 && before <= 28 ? before : 5;
  const payUserId = Number(b.payUserId) || null;
  const collectUserId = needsCollect ? (Number(b.collectUserId) || null) : null;
  if (!payUserId) return { error: '请选付款的负责人。 Choose who pays.' };
  if (needsCollect && !collectUserId) return { error: '请选拿单的负责人。 Choose who collects the bill.' };
  for (const id of [payUserId, collectUserId].filter(Boolean)) if (!await canAssignTo(req, id)) return { error: '不能把事项交给这个人。 You cannot give work to this person.' };
  return { title, companyId: Number(b.companyId) || null, dueDay, needsCollect, collectDaysBefore, payUserId, collectUserId, active: b.active !== false };
}

router.post('/work/recurring', requireAuth, requireRole('admin'), async (req, res) => {
  const b = await cleanRecurring(req, req.body || {});
  if (b.error) return bad(res, b.error);
  const { rows } = await pool.query(
    `INSERT INTO work_recurring (company_id, title, due_day, needs_collect, collect_days_before, collect_user_id, pay_user_id, active, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [b.companyId, b.title, b.dueDay, b.needsCollect, b.collectDaysBefore, b.collectUserId, b.payUserId, b.active, req.user.sub]
  );
  await logActivity(req.user.sub, 'Added a monthly bill', b.title, 'day ' + b.dueDay);
  await ensureRecurring();
  res.status(201).json({ id: rows[0].id });
});

router.put('/work/recurring/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { rows: ex } = await pool.query('SELECT id FROM work_recurring WHERE id = $1', [Number(req.params.id) || 0]);
  if (!ex[0]) return res.status(404).json({ error: 'Not found' });
  const b = await cleanRecurring(req, req.body || {});
  if (b.error) return bad(res, b.error);
  const { rows } = await pool.query(
    `UPDATE work_recurring SET company_id=$2, title=$3, due_day=$4, needs_collect=$5, collect_days_before=$6, collect_user_id=$7, pay_user_id=$8, active=$9 WHERE id = $1 RETURNING *`,
    [ex[0].id, b.companyId, b.title, b.dueDay, b.needsCollect, b.collectDaysBefore, b.collectUserId, b.payUserId, b.active]
  );
  await updateOpenTasks(rows[0]);
  await ensureRecurring();
  res.json({ ok: true });
});

router.delete('/work/recurring/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query('SELECT id, title FROM work_recurring WHERE id = $1', [Number(req.params.id) || 0]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  // tasks not done yet go with it; the ones already done / checked stay in the history
  await pool.query(`DELETE FROM work_tasks WHERE recurring_id = $1 AND status = 'todo'`, [rows[0].id]);
  await pool.query('DELETE FROM work_recurring WHERE id = $1', [rows[0].id]);
  await logActivity(req.user.sub, 'Removed a monthly bill', rows[0].title, null);
  res.json({ ok: true });
});

module.exports = router;
