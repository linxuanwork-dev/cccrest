-- Security hardening: login attempt limits, sessions that can be revoked (password change / account off), and
-- "must change password" for accounts still using a default or admin-set password.

ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false;

-- Failed-login counters, kept in the database so a restart does not reset them. Keys look like "u:<login id>" or "ip:<address>".
CREATE TABLE login_throttle (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ
);
