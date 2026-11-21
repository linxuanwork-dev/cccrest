// Lists the tables that have a company_id but no company_isolation policy (run after adding a table: node tools/check-rls.js).
// Tables left out on purpose are in LEFT_OUT of server/lib/rls.js; anything else is a gap: add `SELECT enable_company_rls('the_table');` to the migration.
require('dotenv').config();
const { pool } = require('../server/db');
const rls = require('../server/lib/rls');
(async () => {
  const g = await rls.findGaps(pool);
  console.log('tables with a company_id:', g.total, '| with the policy:', g.withPolicy, '| left out on purpose:', rls.LEFT_OUT.join(', '));
  console.log(g.gaps.length ? 'GAPS (no policy): ' + g.gaps.join(', ') : 'No gaps.');
  await pool.end(); process.exit(g.gaps.length ? 1 : 0);
})();
