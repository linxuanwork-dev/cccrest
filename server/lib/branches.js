// Branches / outlets of a company (migration 057 + 058): one list for every module, instead of branch codes written in the programs.
const { pool } = require('../db');

/* [{ code, name, merchant_id, active, sort_order, extra }] in the order the pages show them */
async function list(companyId, db, opts) {
  const onlyActive = !(opts && opts.includeInactive);
  const { rows } = await (db || pool).query(
    `SELECT code, name, merchant_id, active, sort_order, extra FROM branches
      WHERE company_id = $1 ${onlyActive ? 'AND active' : ''} ORDER BY sort_order, code`, [companyId]);
  return rows;
}

async function codes(companyId, db) {
  return (await list(companyId, db)).map((b) => b.code);
}

module.exports = { list, codes };
