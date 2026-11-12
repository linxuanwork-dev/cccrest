// Reads the text of an HQ bill (QC GROUP SDN. BHD. -> a DIDIK MULIA branch) into its lines. Pure functions, no database.
//
// The bill lists, for each item: a title line, optional "Key: value" lines (Client Name, Module, Jersey Size, Game) and a line with the
// quantity, unit price and amount, e.g.  "1RM 50.00RM 50.00".

const MONTHS = { JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6, JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
  JANUARI: 1, FEBRUARI: 2, MAC: 3, MEI: 5, JUN: 6, JULAI: 7, OGOS: 8, OKTOBER: 10, DISEMBER: 12 };
const num = (s) => Math.round(parseFloat(String(s).replace(/,/g, '')) * 100) / 100;
const KEYS = { 'client name': 'client', module: 'module', 'jersey size': 'jersey', game: 'game' };

function parseDate(text) {
  const m = String(text).match(/Invoice Date:\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!m) return '';
  const mo = MONTHS[m[2].toUpperCase()];
  return mo ? m[3] + '-' + String(mo).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0') : '';
}

// which branch the bill is for: from the file name (DM-BBU-...) first, then from the address on the bill
function guessBranch(text, fileName) {
  const f = String(fileName || '').toUpperCase().match(/(?:^|[^A-Z])(BBU|TST|TDA)(?:[^A-Z]|$)/);
  if (f) return f[1];
  const t = String(text).toUpperCase();
  if (t.includes('BANDAR BARU UDA')) return 'BBU';
  return '';
}

// what kind of item a title is. Fast Track and anything without a client name are stock only (no invoice).
function classify(title, fields) {
  const t = String(title).toUpperCase();
  if (/FAST\s*TRACK|^FT\b/.test(t)) return 'fasttrack';
  if (/TARGET\s*SPM/.test(t)) return 'targetspm';
  if (/^SAIZ JERSI|^JERSI|^JERSEY/.test(t)) return 'jersey';
  if (/PEMBELIAN MODUL/.test(t)) return 'module';
  if (/SEASONAL/.test(t)) return 'seasonal';
  if (/PENDAFTARAN/.test(t)) return 'registration';
  if (/REAKTIF|REACTIVE|AKTIF|ACTIVATION/.test(t)) return 'reactive';
  return fields && fields.client ? 'other' : 'stock';
}

function parseBill(text, fileName) {
  const raw = String(text || '').replace(/\r/g, '');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = { invoiceNo: '', date: '', due: 0, total: 0, billTo: '', branch: guessBranch(raw, fileName), items: [] };
  let m;
  if ((m = raw.match(/Invoice Number:\s*([A-Za-z0-9-]+)/))) out.invoiceNo = m[1];
  out.date = parseDate(raw);
  if ((m = raw.match(/RM\s*([\d,]+\.\d{2})\s*due/i))) out.due = num(m[1]);
  if ((m = raw.match(/Total:\s*RM\s*([\d,]+\.\d{2})/i))) out.total = num(m[1]);
  const bt = lines.indexOf('BILL TO');
  if (bt >= 0) out.billTo = lines.slice(bt + 1, bt + 5).join(', ');
  const start = lines.findIndex((l) => /^DESCRIPTION/i.test(l));
  let cur = null;
  for (let i = start + 1; start >= 0 && i < lines.length; i++) {
    const l = lines[i];
    if (/^Total:/i.test(l) || /^Amount Due:/i.test(l)) break;
    const q = l.match(/^(\d+)\s*RM\s*([\d,]+\.\d{2})\s*RM\s*([\d,]+\.\d{2})$/);
    if (q) {
      if (cur) { cur.qty = +q[1]; cur.price = num(q[2]); cur.amount = num(q[3]); cur.kind = classify(cur.title, cur.fields); out.items.push(cur); cur = null; }
      continue;
    }
    const kv = l.match(/^([A-Za-z ]+):\s*(.*)$/);
    if (cur && kv && KEYS[kv[1].trim().toLowerCase()]) { cur.fields[KEYS[kv[1].trim().toLowerCase()]] = kv[2].trim(); continue; }
    if (cur) cur.title += ' ' + l; else cur = { title: l, fields: {}, qty: 1, price: 0, amount: 0 };
  }
  const sum = Math.round(out.items.reduce((a, x) => a + x.amount, 0) * 100) / 100;
  out.itemsTotal = sum;
  out.totalMatches = !out.total || Math.abs(sum - out.total) < 0.01;
  return out;
}

module.exports = { parseBill, classify, guessBranch };
