const { Pool, types } = require('pg');

// DATE columns have no time/timezone meaning — return them as plain 'YYYY-MM-DD'
// strings instead of letting pg build a JS Date (which round-trips through the
// server's local timezone and can shift the calendar day by one).
types.setTypeParser(1082, (val) => val);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

// Railway's internal private-network hostname (service-to-service, same project)
// doesn't offer/need SSL. The public proxy host and any other external host do.
const useSSL = !/localhost|127\.0\.0\.1|\.railway\.internal(?::|\/|$)/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : false
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params)
};
