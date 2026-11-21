// Row-level security (phase 1, step 6; migration 061). Off unless RLS_MODE=enforce.
//
// With RLS_MODE=enforce every request of a person who is NOT the Owner runs its database statements as the role cccrest_app, with the list of the
// companies that person may use (app.company_ids). The policies in the database (company_isolation on every table with a company_id) then keep the
// rows of every other company out of reach, even for a statement that forgot its company_id filter. The Owner (admin), requests without a signed-in
// person (login, the MT claim form, the folder watcher with its token) and the migrations run as the owner of the tables, as before.
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const mode = () => String(process.env.RLS_MODE || 'off').toLowerCase();
const enforcing = () => mode() === 'enforce';
const current = () => als.getStore() || null;

const cache = new Map();   // 'staff:3' -> { ids, at }
const TTL_MS = 10000;
let poolRef = null;

const ints = (list) => (list || []).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));

/* the companies a person may use: the same rules as scopeToCompany in auth.js. null = all companies (the Owner) */
async function allowedCompanyIds(user, db) {
  const q = db || poolRef;
  if (!user) return [];
  if (user.role === 'admin') return null;
  const key = user.role + ':' + (user.role === 'client' ? user.companyId : user.role === 'staff' ? user.staffId : user.sub);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ids;
  let ids = [];
  if (user.role === 'client') ids = user.companyId ? [user.companyId] : [];
  else if (user.role === 'staff') ids = (await q.query('SELECT company_id FROM company_staff WHERE staff_id = $1', [user.staffId])).rows.map((r) => r.company_id);
  else if (user.role === 'manager') ids = (await q.query(
    'SELECT DISTINCT cs.company_id FROM company_staff cs JOIN manager_staff ms ON ms.staff_id = cs.staff_id WHERE ms.manager_user_id = $1', [user.sub])).rows.map((r) => r.company_id);
  ids = ints(ids);
  cache.set(key, { ids, at: Date.now() });
  return ids;
}
const forget = () => cache.clear();

// express: after attachUser, before the routes
function middleware(req, res, next) {
  if (!enforcing() || !req.user || req.user.role === 'admin') return next();
  allowedCompanyIds(req.user).then((ids) => { als.run({ ids: ints(ids) }, next); }, next);
}

// run a function with the rules of a given list of companies (tests, jobs that work for one company)
function run(ids, fn) { return als.run({ ids: ints(ids) }, fn); }

const setupSql = (ctx) => "SET ROLE cccrest_app; SELECT set_config('app.company_ids', '" + ints(ctx.ids).join(',') + "', false), set_config('app.bypass', 'off', false)";
const resetSql = 'RESET ROLE; RESET app.company_ids; RESET app.bypass';

/* patches pool.query and pool.connect: inside a request context (and only then) the connection is switched to cccrest_app first and switched back
   when it is released. Everything else passes straight through. */
function wrapPool(pool) {
  if (pool.__rls) return pool;
  pool.__rls = true; poolRef = pool;
  const rawQuery = pool.query.bind(pool), rawConnect = pool.connect.bind(pool);

  async function acquire(ctx) {
    const client = await rawConnect();
    try { await client.query(setupSql(ctx)); } catch (err) { client.release(err); throw err; }
    const rawRelease = client.release.bind(client);
    client.release = (err) => {
      if (err) return rawRelease(err);
      return client.query(resetSql).then(() => rawRelease(), (e) => rawRelease(e));   // a connection that can not be switched back is thrown away
    };
    return client;
  }

  pool.query = function (text, params) {
    const ctx = current();
    if (!enforcing() || !ctx || typeof params === 'function') return rawQuery.apply(null, arguments);
    return (async () => {
      const client = await acquire(ctx);
      try { return await client.query(text, params); } finally { client.release(); }
    })();
  };
  pool.connect = function (cb) {
    if (typeof cb === 'function') return rawConnect(cb);
    const ctx = current();
    if (!enforcing() || !ctx) return rawConnect();
    return acquire(ctx);
  };
  return pool;
}

// the tables that were left out of the policies on purpose (the reasons are in migration 061)
const LEFT_OUT = ['users', 'audit_log', 'work_tasks', 'work_recurring', 'company_staff', 'assignment_requests'];

// tables with a company_id that have no company_isolation policy (and are not on the left-out list): the gaps
async function findGaps(db) {
  const q = db || poolRef;
  const cols = (await q.query("SELECT table_name, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'company_id' ORDER BY 1")).rows;
  const pol = new Set((await q.query("SELECT tablename FROM pg_policies WHERE policyname = 'company_isolation' AND schemaname = current_schema()")).rows.map((r) => r.tablename));
  return { total: cols.length, withPolicy: cols.filter((c) => pol.has(c.table_name)).length, gaps: cols.filter((c) => !pol.has(c.table_name) && !LEFT_OUT.includes(c.table_name)).map((c) => c.table_name + (c.is_nullable === 'YES' ? ' (company_id can be empty)' : '')) };
}

// at start: with RLS_MODE=enforce the role has to work and every table has to be covered, otherwise the start fails
// (the old version keeps running) instead of running without protection
async function selfCheck(pool) {
  if (!enforcing()) return;
  const client = await pool.connect();
  try {
    await client.query('SET ROLE cccrest_app');
    await client.query('RESET ROLE');
    const g = await findGaps(client);
    if (!g.withPolicy) throw new Error('no company_isolation policy found (migration 061)');
    if (g.gaps.length) throw new Error('tables with a company_id and no company_isolation policy: ' + g.gaps.join(', ') + ' (add: SELECT enable_company_rls(table name))');
  } finally { client.release(); }
}

module.exports = { als, mode, enforcing, current, middleware, run, wrapPool, allowedCompanyIds, forget, selfCheck, findGaps, LEFT_OUT };
