const bcrypt = require('bcryptjs');

// The passwords the system was first set up with (and a few very common ones). Nobody may keep or choose these.
const DEFAULT_PASSWORDS = ['admin123', 'manager123', 'staff123', 'client123'];
const COMMON = DEFAULT_PASSWORDS.concat(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'abc12345', 'iloveyou1', 'cccrest123']);

const RULE_TEXT = '密码至少 8 个字符，并同时包含字母和数字。 Password must be at least 8 characters with letters and numbers.';

// returns an error message, or null when the password is acceptable
function checkPassword(pw, loginId) {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 100) return RULE_TEXT;
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return RULE_TEXT;
  if (COMMON.includes(pw.toLowerCase())) return '这个密码太常见了，请换一个。 That password is too common.';
  if (loginId && pw.toLowerCase().includes(String(loginId).toLowerCase())) return '密码不能包含登录名。 The password cannot contain the login ID.';
  return null;
}

// Marks every account that still uses one of the default passwords as "must change password". Runs at start-up.
async function flagDefaultPasswords(pool) {
  const { rows } = await pool.query('SELECT id, login_id, password_hash FROM users WHERE must_change_password = false');
  const flagged = [];
  for (const u of rows) {
    for (const p of DEFAULT_PASSWORDS) {
      if (await bcrypt.compare(p, u.password_hash)) { flagged.push(u.id); break; }
    }
  }
  if (flagged.length) await pool.query('UPDATE users SET must_change_password = true, token_version = token_version + 1 WHERE id = ANY($1)', [flagged]);
  return flagged.length;
}

module.exports = { checkPassword, flagDefaultPasswords, DEFAULT_PASSWORDS };
