/* Reads SSM "Certificate of Incorporation" + "Section 14" PDFs (text layer, incl. CamScanner OCR). */
(function (root) {
  const STATES = ['NEGERI SEMBILAN', 'PULAU PINANG', 'W.P. KUALA LUMPUR', 'W.P. LABUAN', 'W.P. PUTRAJAYA', 'KUALA LUMPUR', 'PUTRAJAYA', 'LABUAN',
    'JOHOR', 'KEDAH', 'KELANTAN', 'MELAKA', 'PAHANG', 'PENANG', 'PERAK', 'PERLIS', 'SABAH', 'SARAWAK', 'SELANGOR', 'TERENGGANU'];
  const STATE_CANON = { 'KUALA LUMPUR': 'W.P. KUALA LUMPUR', PUTRAJAYA: 'W.P. PUTRAJAYA', LABUAN: 'W.P. LABUAN', PENANG: 'PULAU PINANG' };

  /* pages: [{ items: [{ str, x, y, w, h }] }]  (y measured from top) -> [{ page, y, x, label?, value, text }] */
  function toLines(pages) {
    const lines = [];
    pages.forEach((pg, pi) => {
      const items = pg.items.filter(it => it.str !== '').slice().sort((a, b) => a.y - b.y || a.x - b.x);
      const rows = [];
      for (const it of items) {
        const r = rows.find(r => Math.abs(r.y - it.y) < 3.2);
        if (r) r.items.push(it); else rows.push({ y: it.y, items: [it] });
      }
      rows.forEach(r => {
        r.items.sort((a, b) => a.x - b.x);
        // segments split by a big horizontal gap (label column | value column)
        const segs = []; let cur = null, end = -1e9;
        for (const it of r.items) {
          const gap = it.x - end;
          if (!cur || (gap > 18 && it.str.trim())) { cur = { x: it.x, parts: [] }; segs.push(cur); }
          else if (gap > 2.6 && it.str.trim() && cur.parts.length && !/\s$/.test(cur.parts[cur.parts.length - 1])) cur.parts.push(' ');
          cur.parts.push(it.str);
          if (it.str.trim()) end = it.x + it.w;
        }
        const s = segs.map(s => ({ x: s.x, text: s.parts.join('').replace(/\s+/g, ' ').trim() })).filter(s => s.text);
        if (s.length) lines.push({ page: pi, y: r.y, segs: s, text: s.map(x => x.text).join(' ') });
      });
    });
    return lines;
  }

  const LABELS = [
    ['pname', /^propos\w*\s*na\w*/i], ['lodge', /^lodg\w*/i], ['purpose', /^purpose/i], ['ctype', /^company\s*ty\w*/i],
    ['subtype', /^sub\s*ty\w*/i], ['incdate', /^incorpor\w*\s*da\w*/i], ['regno', /^registr\w*\s*n[o0]\.?/i],
    ['nature', /^general\s*natur\w*(\s*of\s*bus\w*)?/i], ['bizdesc', /^business\s*desc\w*/i],
    ['regaddr', /^regist\w*\s*addr\w*/i], ['bizaddr', /^business\s*addr\w*/i], ['email', /^e\s*-?\s*ma[il1|]{1,3}\b/i],
    ['office', /^off[il1|]ce\s*n[o0]/i], ['fax', /^fax\s*n\w*/i],
    ['dname', /^director\s*na\w*/i], ['mname', /^member\s*na\w*/i], ['idtype', /^[il1|]d\s*ty\w*/i], ['idno', /^[il1|]dent\w*\s*n[o0]/i],
    ['nat', /^nat[il1|]\w*/i], ['addr', /^address/i], ['dob', /^date\s*of\s*b\s*\w*/i], ['race', /^race/i],
    ['price', /^price/i], ['class', /^class/i], ['nshare', /^number\s*of\s*sh/i], ['total', /^total\s*num/i],
  ];

  function classify(lines) {
    lines.forEach(l => {
      const first = l.segs[0].text;
      for (const [k, re] of LABELS) {
        const m = re.exec(first);
        if (m) {
          l.label = k;
          const rest = first.slice(m[0].length).trim();
          l.value = [rest, ...l.segs.slice(1).map(s => s.text)].filter(Boolean).join(' ').trim();
          break;
        }
      }
      if (!l.label) l.value = l.text;
    });
    // attach unlabeled value-column lines to the nearest labeled line on the same page
    const labeled = lines.filter(l => l.label);
    const valueX = {};
    labeled.forEach(l => { if (l.segs.length > 1) (valueX[l.page] = valueX[l.page] || []).push(l.segs[1].x); });
    const vx = (p) => { const a = (valueX[p] || []).sort((a, b) => a - b); return a.length ? a[a.length >> 1] : 1e9; };
    lines.forEach(l => {
      if (l.label || l.segs[0].x < vx(l.page) - 12) return;
      let best = null, bd = 1e9;
      labeled.forEach(t => { if (t.page === l.page) { const d = Math.abs(t.y - l.y); if (d < bd) { bd = d; best = t; } } });
      if (best && bd < 16) (best.extra = best.extra || []).push(l);
    });
    labeled.forEach(l => {
      if (!l.extra) return;
      const all = [{ y: l.y, v: l.value }, ...l.extra.map(e => ({ y: e.y, v: e.text }))].sort((a, b) => a.y - b.y);
      l.value = all.map(a => a.v).filter(Boolean).join(' ');
    });
    return lines;
  }

  const nil = (v) => (!v || /^(n[il1|]{1,2}|-|n\/a)$/i.test(v.trim())) ? '' : v.trim();
  function fixDigits(s) { return s.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1'); }
  function date(v) {
    if (!v) return '';
    const d = fixDigits(v).replace(/[^\d/.-]/g, '');
    let m = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(d) || /^(\d{2})(\d{2})(\d{4})$/.exec(d.replace(/\D/g, ''));
    if (!m) return '';
    return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  function ic(v) {
    const d = fixDigits(v || '').replace(/\D/g, '');
    return d.length === 12 ? `${d.slice(0, 6)}-${d.slice(6, 8)}-${d.slice(8)}` : (v || '').replace(/\s/g, '').toUpperCase();
  }
  function phone(v) {
    const d = fixDigits(nil(v)).replace(/\D/g, '');
    if (!d) return '';
    if (/^01/.test(d)) return d.slice(0, 3) + '-' + d.slice(3);
    if (/^0[3]/.test(d)) return d.slice(0, 2) + '-' + d.slice(2);
    if (/^0[4-9]/.test(d)) return d.slice(0, 2) + '-' + d.slice(2);
    return d;
  }
  function coName(v) {
    return (v || '').toUpperCase().replace(/\s+/g, ' ')
      .replace(/\bS[DO0]N\.?\s*BHD\.?$/, 'SDN. BHD.').replace(/\bBHD\.?$/, 'BHD.').trim();
  }

  /* "142-02, JALAN ADDA 7, TAMAN ADDA HEIGHT, 81100JOHOR BAHRU JOHOR MALAYSIA" -> parts */
  function address(v) {
    let s = (nil(v) || '').toUpperCase().replace(/\s+/g, ' ').trim();
    if (!s) return null;
    s = s.replace(/[, ]*MALAYSIA\.?$/, '').trim();
    let state = '';
    for (const st of STATES) {
      const re = new RegExp('[,\\s]*' + st.replace(/[.]/g, '\\.').replace(/ /g, '\\s*') + '\\.?$');
      if (re.test(s)) { state = STATE_CANON[st] || st; s = s.replace(re, '').trim(); break; }
    }
    let pc = '', city = '', street = s;
    const m = /(\d{5})(?!.*\d{5})\s*,?\s*([^,\d]*)$/.exec(s);
    if (m) { pc = m[1]; city = m[2].replace(/[,\s]+$/, '').trim(); street = s.slice(0, m.index).replace(/[,\s]+$/, '').trim(); }
    // fall back: city == state name (e.g. "JOHOR BAHRU" contains state)
    const parts = street.split(/\s*,\s*/).filter(Boolean);
    const lines = ['', '', ''];
    const cap = 36; let i = 0;
    for (const p of parts) {
      const add = (lines[i] ? lines[i] + ', ' : '') + p;
      if (add.length <= cap || !lines[i]) lines[i] = add;
      else if (i < 2) { i++; lines[i] = p; }
      else lines[i] += ', ' + p;
    }
    return { line1: lines[0], line2: lines[1], line3: lines[2], city, pc, state };
  }

  const RACE = { MALAY: 'MELAYU', MELAYU: 'MELAYU', CHINESE: 'CINA', CINA: 'CINA', INDIAN: 'INDIA', INDIA: 'INDIA' };

  function parse(pages) {
    const lines = classify(toLines(pages));
    const out = { company: {}, directors: [], warnings: [], found: [] };
    const C = out.company;
    let mode = 'company', cur = null, seenOffice = 0, seenFax = 0, afterBizAddr = false;
    let certName = '', certReg = '', certDate = '';
    // certificate page
    lines.forEach((l, i) => {
      if (/certify\s*that/i.test(l.text) && lines[i + 1]) {
        certName = lines[i + 1].text;
        if (lines[i + 2]) certReg = lines[i + 2].text;
      }
      const m = /from\s+the\s+(\d{1,2})\s*(?:st|nd|rd|th)?\s*day\s+of\s+([A-Za-z]+)\s+(\d{4})/i.exec(l.text);
      if (m && !certDate) {
        const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
        if (mon) certDate = `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      }
    });
    for (const l of lines) {
      if (/particulars\s*of\s*director/i.test(l.text)) { mode = 'director'; continue; }
      if (/particulars\s*of\s*(member|shareholder)/i.test(l.text)) { mode = 'member'; continue; }
      if (!l.label) continue;
      const v = (l.value || '').trim();
      if (l.label === 'dname') { mode = 'director'; cur = { name: v.toUpperCase() }; out.directors.push(cur); continue; }
      if (l.label === 'mname') { mode = 'member'; cur = null; continue; }
      if (mode === 'director' && cur) {
        if (l.label === 'idtype') cur.idType = v.toUpperCase();
        else if (l.label === 'idno') cur.idNo = v;
        else if (l.label === 'nat') cur.nat = v.toUpperCase().replace(/^MALAYS[I1]A$/, 'MALAYSIA');
        else if (l.label === 'addr') cur.addr = v.toUpperCase();
        else if (l.label === 'dob') cur.dob = date(v);
        else if (l.label === 'race') cur.race = v.toUpperCase();
        else if (l.label === 'email') cur.email = v.toLowerCase().replace(/\s/g, '');
        continue;
      }
      if (mode !== 'company') continue;
      switch (l.label) {
        case 'pname': C.name = coName(v); break;
        case 'regno': C.regRaw = v; break;
        case 'incdate': C.incDate = date(v); break;
        case 'bizdesc': C.nature = nil(v).toUpperCase(); break;
        case 'nature': if (!C.msic) C.msic = v; break;
        case 'regaddr': C.regAddrRaw = v; break;
        case 'bizaddr': C.bizAddrRaw = nil(v); afterBizAddr = true; break;
        case 'email': if (!C.email) C.email = nil(v).toLowerCase().replace(/\s/g, ''); break;
        case 'office': seenOffice++; if (afterBizAddr) C.bizTel = phone(v); else C.tel = phone(v); break;
        case 'fax': seenFax++; if (afterBizAddr) C.bizFax = phone(v); else C.fax = phone(v); break;
      }
    }
    if (!C.name && certName) C.name = coName(certName);
    if (!C.regRaw && certReg) C.regRaw = certReg;
    if (!C.incDate && certDate) C.incDate = certDate;
    if (C.regRaw) {
      const tok = C.regRaw.replace(/\s/g, '').split('(')[0].toUpperCase();
      C.reg = /^\d{4}/.test(fixDigits(tok)) ? fixDigits(tok.slice(0, 4)) + tok.slice(4).replace(/O/g, '0').replace(/[IL|]/g, '1') : tok;
      if (!/^\d{12}$/.test(C.reg)) out.warnings.push(`注册号读到「${C.reg}」，不是 12 位数字，请核对。`);
    }
    C.regAddr = address(C.regAddrRaw);
    C.bizAddr = address(C.bizAddrRaw);
    out.directors.forEach(d => { d.ic = d.idType && /PASS/i.test(d.idType) ? (d.idNo || '').replace(/\s/g, '').toUpperCase() : ic(d.idNo); d.passport = /PASS/i.test(d.idType || ''); d.raceMy = RACE[d.race] || ''; });
    if (!C.name) out.warnings.push('没有读到公司名称。');
    if (!out.directors.length) out.warnings.push('没有读到董事资料（Particulars of Director）。');
    out.directors.forEach((d, i) => { if (!d.passport && !/^\d{6}-\d{2}-\d{4}$/.test(d.ic)) out.warnings.push(`董事 ${i + 1}（${d.name}）的 IC 读到「${d.ic}」，请核对。`); });
    out.lines = lines.length;
    return out;
  }

  /* pdf.js document -> pages for parse() */
  async function pagesFromPdf(pdfjsLib, bytes) {
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i);
      const vp = pg.getViewport({ scale: 1 });
      const tc = await pg.getTextContent();
      pages.push({
        items: tc.items.filter(it => typeof it.str === 'string').map(it => {
          const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
          return { str: it.str, x, y, w: it.width * (vp.scale || 1), h: it.height };
        })
      });
    }
    return pages;
  }

  const api = { parse, pagesFromPdf, address, toLines };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SSMReader = api;
})(typeof window !== 'undefined' ? window : globalThis);
