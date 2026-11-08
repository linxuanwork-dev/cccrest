const fs = require('fs');
const path = require('path');

// The Tuition & Allowance page (server/assets/tuition/app.html) is written in Chinese. Its other languages (English, Bahasa Melayu) are made
// when the page is served: every piece of Chinese text that people read is looked up in server/assets/tuition/i18n/*.js and swapped for
// the translation. Text kept as Chinese on purpose: lines that handle the stored "how" values of the bank matching (the page translates
// those when it shows them) and Chinese inside comments (not in the list).

const DIR = path.join(__dirname, '..', 'assets', 'tuition');
const PAGE = path.join(DIR, 'app.html');
const LANGS = ['zh', 'en', 'ms'];
const protectedLine = (l) => /\bhow\b\s*(?::|=|!==|===)/.test(l) || /how:\s*how/.test(l) || /^function howTxt\(/.test(l);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function dictionary() {
  const d = {};
  fs.readdirSync(path.join(DIR, 'i18n')).filter((f) => /^part\d+\.js$/.test(f)).sort().forEach((f) => {
    Object.assign(d, require(path.join(DIR, 'i18n', f)));
  });
  return d;
}

// what the page shows for the stored matching notes (see howTxt in the page)
const HOW = {
  en: { '已记住的付款人': 'Remembered payer', '已记住的家庭': 'Remembered family', '父母名字': 'Parents name', '备注里的学生名': 'Student name in the remark', '找不到': 'Not found', '手动确认': 'Manually confirmed', '+金额': '+ amount', '（金额对不上）': ' (amount does not match)', months: '({n} months)' },
  ms: { '已记住的付款人': 'Pembayar diingat', '已记住的家庭': 'Keluarga diingat', '父母名字': 'Nama ibu bapa', '备注里的学生名': 'Nama murid dalam catatan', '找不到': 'Tidak dijumpai', '手动确认': 'Disahkan manual', '+金额': '+ jumlah', '（金额对不上）': ' (jumlah tidak sepadan)', months: '({n} bulan)' }
};

const cache = {};
function build(lang) {
  const src = fs.readFileSync(PAGE, 'utf8');
  if (lang === 'zh') return src.replace('/*HOWM*/{}', '/*HOWM*/{}');
  const dict = dictionary(), idx = lang === 'ms' ? 1 : 0;
  const keys = Object.keys(dict).sort((a, b) => b.length - a.length);
  const re = new RegExp(keys.map(esc).join('|'), 'g');
  const PUNCT = { '（': ' (', '）': ')', '：': ': ', '，': ', ', '；': '; ', '。': '. ', '、': ', ', '「': '“', '」': '”' };
  const out = src.split('\n').map((l) => (protectedLine(l) ? l : l.replace(re, (m) => dict[m][idx]).replace(/[（）：，；。、「」]/g, (c) => PUNCT[c]))).join('\n');
  return out
    .replace('<html lang="zh">', '<html lang="' + lang + '">')
    .replace('/*HOWM*/{}', '/*HOWM*/' + JSON.stringify(HOW[lang]));
}

// the page in a language ('zh' by default); built once and kept
function pageFor(lang) {
  const l = LANGS.includes(lang) ? lang : 'zh';
  if (!cache[l] || process.env.NODE_ENV !== 'production') cache[l] = build(l);
  return cache[l];
}

// for tests: the Chinese text of the page that has no translation yet
function untranslated() {
  const dict = dictionary();
  const re = /[^<>`'"${}\n]*[一-鿿][^<>`'"${}\n]*/g;
  const missing = new Set();
  fs.readFileSync(PAGE, 'utf8').split('\n').forEach((l) => {
    if (protectedLine(l)) return;
    let m;
    while ((m = re.exec(l))) {
      const before = l.slice(0, m.index);
      if (/(^|[\s;{}])\/\/[^'"`]*$/.test(before) || /\/\*[^*]*$/.test(before) || /^\s*\/\//.test(l)) continue;
      const k = m[0].trim();
      if (k && !dict[k]) missing.add(k);
    }
  });
  return [...missing];
}

module.exports = { pageFor, untranslated, dictionary, LANGS };
