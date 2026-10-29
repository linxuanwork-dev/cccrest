/* Borang filler: overlays client data onto the original KWSP/PERKESO forms. */
(function (root) {
  const FORMS = [
    { id: 'kwsp1', pdf: 'kwsp1', label: 'KWSP 1 (Majikan)', agency: 'KWSP', pages: 4 },
    { id: 'portal', pdf: 'portal', label: 'ID Portal PERKESO', agency: 'PERKESO', pages: 1 },
    { id: 'b1', pdf: 'b1', label: 'Borang 1 - Pendaftaran Majikan', agency: 'PERKESO', pages: 1 },
    { id: 'b2', pdf: 'b2', label: 'Borang 2 - Pendaftaran Pekerja', agency: 'PERKESO', pages: 1, emp: true },
    { id: 'sip1', pdf: 'sip1', label: 'SIP 1 - Pendaftaran Majikan (EIS)', agency: 'PERKESO', pages: 1 },
    { id: 'sip1a', pdf: 'sip1a', label: 'SIP 1A - Pemberitahuan Majikan (EIS)', agency: 'PERKESO', pages: 1 },
    { id: 'sip2', pdf: 'sip2', label: 'SIP 2 - Pendaftaran Pekerja (EIS)', agency: 'PERKESO', pages: 1, emp: true },
    { id: 'sip2a', pdf: 'sip2a', label: 'SIP 2A - Pemberitahuan Pekerja (EIS)', agency: 'PERKESO', pages: 1, emp: true },
  ];

  const U = (s) => (s == null ? '' : String(s)).toUpperCase().replace(/\s+/g, ' ').trim();
  const digits = (s) => (s || '').replace(/\D/g, '');

  function dmy(iso) { // '2026-10-28' -> '28102026'
    if (!iso) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    return m ? m[3] + m[2] + m[1] : '';
  }
  function dmyText(iso) { const d = dmy(iso); return d ? d.slice(0, 2) + '/' + d.slice(2, 4) + '/' + d.slice(4) : ''; }

  // MyKad YYMMDD-PB-###G -> DOB + gender
  function icInfo(ic, refYear) {
    const d = digits(ic);
    if (d.length !== 12) return null;
    const yy = +d.slice(0, 2), mm = +d.slice(2, 4), dd = +d.slice(4, 6);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    const cur = (refYear || new Date().getFullYear()) % 100;
    const yyyy = (yy <= cur ? 2000 : 1900) + yy;
    return { dob: `${yyyy}-${d.slice(2, 4)}-${d.slice(4, 6)}`, gender: (+d[11]) % 2 ? 'L' : 'P' };
  }

  function joinAddr(a, withCity) {
    if (!a) return '';
    const parts = [a.line1, a.line2, a.line3];
    if (withCity) parts.push(a.city);
    return parts.map(U).filter(Boolean).join(', ').replace(/,\s*,/g, ',');
  }
  const addrEq = (a, b) => ['line1', 'line2', 'line3', 'city', 'pc', 'state'].every(k => U(a && a[k]) === U(b && b[k]));
  const addrEmpty = (a) => !a || ['line1', 'line2', 'line3', 'city', 'pc', 'state'].every(k => !U(a[k]));

  // Borang 2 nota: ruangan (1) kod jenis kad pengenalan, ruangan (6) kod bangsa
  const ID_CODES = { B: 'B', L: 'L', T: 'T', P: 'P', PR: 'PR', SSN: 'SSN', passport: 'PASPORT' };
  const RACE_CODES = { MELAYU: '01', CINA: '02', INDIA: '03', 'BUMIPUTERA SABAH': '04', 'BUMIPUTERA SARAWAK': '05', 'LAIN-LAIN': '06', 'ORANG ASLI': '06' };
  function raceCode(r) { const u = U(r); if (/^0[1-6]$/.test(u)) return u; return RACE_CODES[u] || u; }

  /* Turn the form data into flat values used by the spec. */
  function derive(d) {
    const D = {};
    const c = d.company || {};
    D.co_name = U(c.name); D.co_reg = U(c.reg).replace(/\s/g, '');
    D.inc_date = dmy(c.incDate); D.emp1_date = dmy(c.firstEmpDate);
    D.ent = c.entity || ''; D.ent_other = c.entity === 'other' ? U(c.entityOther) : '';
    D.nature = U(c.nature); D.n_emp = c.nEmp ? String(c.nEmp) : '';
    const ssm = c.ssm || 'ssm';
    if (c.entity === 'sole') D.sole_ssm = ssm;
    if (c.entity === 'part') D.part_ssm = ssm;
    D.kw_type = ({ sdn: 'company', bhd: 'company', llp: 'llp', gov: 'gov' })[c.entity] ||
      ((c.entity === 'sole' || c.entity === 'part') ? (ssm === 'ssm' ? 'business' : 'nonssm') : (c.entity === 'other' ? 'nonssm' : ''));

    const biz = d.bizAddr || {};
    const reg = d.regSame ? null : d.regAddr;
    const mail = d.mailSame ? biz : (d.mailAddr || {});
    D.biz_addr = joinAddr(biz, true); D.biz_pc = digits(biz.pc); D.biz_state = U(biz.state);
    if (reg && !addrEmpty(reg) && !addrEq(reg, biz)) { D.reg_addr = joinAddr(reg, true); D.reg_pc = digits(reg.pc); D.reg_state = U(reg.state); }
    D.mail_addr = joinAddr(mail, true); D.mail_addr_only = joinAddr(mail, false);
    D.mail_city = U(mail.city); D.mail_pc = digits(mail.pc); D.mail_state = U(mail.state);
    if (!d.mailSame && !addrEmpty(d.mailAddr) && !addrEq(mail, biz)) { // SOCSO A3: business premise if different from mailing
      D.a3_addr = joinAddr(biz, true); D.a3_pc = digits(biz.pc); D.a3_state = U(biz.state);
    }
    D.co_tel = U(c.tel); D.co_mob = U(c.mob); D.co_fax = U(c.fax); D.co_email = U(c.email);
    (d.hasBranch ? (d.branches || []) : []).slice(0, 2).forEach((b, i) => {
      if (!b) return;
      D[`br${i + 1}_name`] = U(b.name); D[`br${i + 1}_addr`] = U(b.addr);
    });

    const o = d.officer || {};
    D.off_name = U(o.name); D.off_ic = U(o.ic); D.off_pos = U(o.pos); D.off_tel1 = U(o.tel1); D.off_tel2 = U(o.tel2);
    D.off_mob = U(o.mob); D.off_fax = U(o.fax); D.off_email = U(o.email);
    const w = d.owner || {};
    D.own_name = U(w.name); D.own_pos = U(w.pos); D.own_ic = U(w.ic); D.own_cit = U(w.cit);
    const a = d.adminSame ? { name: o.name, ic: o.ic, pos: o.pos, tel: o.tel1, mob: o.mob, email: o.email, tac: o.mob } : (d.admin || {});
    D.adm_name = U(a.name); D.adm_ic = U(a.ic); D.adm_pos = U(a.pos); D.adm_tel = U(a.tel); D.adm_mob = U(a.mob);
    D.adm_email = U(a.email); D.adm_tac = U(a.tac);
    D.app_name = D.adm_name; D.app_ic = D.adm_ic; D.app_tel = D.adm_mob || D.adm_tel; D.app_email = D.adm_email;

    const s = d.signSame ? { name: w.name, ic: w.ic, pos: w.pos, tel: o.mob || c.tel, email: c.email } : (d.signer || {});
    D.sig_name = U(s.name); D.sig_ic = U(s.ic); D.sig_pos = U(s.pos);
    D.sig_tel = U(s.tel); D.sig_fax = U(c.fax); D.sig_email = U(s.email || c.email);
    D.sig_date = dmy(d.signDate); D.sig_date_txt = dmyText(d.signDate);

    const so = d.socso || {};
    D.socso_code = U(so.code); D.socso_kodper = U(so.kodPer);
    D.emp_code = D.socso_code || D.co_reg;
    D.pay = so.pay || 'portal'; D.portal_type = so.portalType || 'new'; D.portal_cat = so.portalCat || 'main';

    D.employees = (d.employees || []).filter(e => e && (e.name || e.ic)).map(e => {
      const t = ID_CODES[e.idType] !== undefined ? e.idType : (e.idType === 'mykad' ? 'B' : 'B');
      const info = t === 'B' ? icInfo(e.ic) : null;
      return {
        jenis: ID_CODES[t],
        ic: U(e.ic), passport: t !== 'B' && t !== 'L',
        dob: dmy(e.dob || (info && info.dob)), name: U(e.name),
        gender: U(e.gender || (info && info.gender)), race: raceCode(e.race),
        start: dmy(e.start), job: U(e.job),
        over: e.over ? +e.over : ((+e.salary || 0) > 4000 ? 4000 : (+e.salary || 0) > 3000 ? 3000 : 0),
      };
    });
    return D;
  }

  /* ---------------- drawing ---------------- */
  function makeDrawer(PDFLib, page, font, H, warn, ctx) {
    const { rgb } = PDFLib;
    const ink = rgb(0, 0, 0);
    const capH = (fs) => fs * 0.72;
    function ch(text, c, fs) {
      const w = font.widthOfTextAtSize(text, fs);
      const cx = (c[0] + c[2]) / 2, cy = (c[1] + c[3]) / 2;
      page.drawText(text, { x: cx - w / 2, y: H - cy - capH(fs) / 2, size: fs, font, color: ink });
    }
    function cellFs(c) { return Math.min(9.5, (c[3] - c[1]) * 0.66, (c[2] - c[0]) * 0.85); }
    function putChars(str, cells, label) {
      if (!str) return;
      if (str.length > cells.length) warn(`${ctx}：「${label}」太长（${str.length}/${cells.length} 格），已截断`);
      const fs = cellFs(cells[0]);
      for (let i = 0; i < Math.min(str.length, cells.length); i++) if (str[i] !== ' ') ch(str[i], cells[i], fs);
    }
    function fitText(text, x, y, w, fs, al) {
      let size = fs;
      while (size > 5 && font.widthOfTextAtSize(text, size) > w) size -= 0.25;
      if (font.widthOfTextAtSize(text, size) > w) {
        warn(`${ctx}：「${text.slice(0, 24)}…」放不下，已截断`);
        while (text.length > 1 && font.widthOfTextAtSize(text, size) > w) text = text.slice(0, -1);
      }
      const tw = font.widthOfTextAtSize(text, size);
      const xx = al === 'c' ? x - tw / 2 : x;
      page.drawText(text, { x: xx, y: H - y, size, font, color: ink });
    }
    function wrapWords(text, caps) { // fill row capacities word by word
      const words = text.split(' ').filter(Boolean);
      const rows = caps.map(() => '');
      let r = 0, i = 0;
      while (i < words.length && r < caps.length) {
        let wd = words[i];
        const cur = rows[r];
        const need = cur ? cur.length + 1 + wd.length : wd.length;
        if (need <= caps[r]) { rows[r] = cur ? cur + ' ' + wd : wd; i++; }
        else if (!cur && wd.length > caps[r]) { rows[r] = wd.slice(0, caps[r]); words[i] = wd.slice(caps[r]); r++; }
        else r++;
      }
      return { rows, overflow: i < words.length };
    }
    function textLines(text, x0, x1, y0, y1, fs) { // up to 2 lines inside a table cell
      const w = x1 - x0 - 5;
      let size = fs;
      const lineFit = (s) => font.widthOfTextAtSize(s, size) <= w;
      let lines = [text];
      if (!lineFit(text)) {
        const words = text.split(' ');
        let a = '', i = 0;
        while (i < words.length && lineFit((a ? a + ' ' : '') + words[i])) { a = (a ? a + ' ' : '') + words[i]; i++; }
        if (!a) { a = words[0]; i = 1; }
        lines = [a, words.slice(i).join(' ')].filter(Boolean);
        while (size > 5 && lines.some(l => !lineFit(l))) size -= 0.25;
      }
      const lh = size * 1.15, total = lh * lines.length;
      const top = (y0 + y1) / 2 - total / 2;
      lines.forEach((l, k) => fitText(l, (x0 + x1) / 2, top + lh * (k + 0.78), w, size, 'c'));
    }
    function tick(c) {
      const pad = Math.min(c[2] - c[0], c[3] - c[1]) * 0.18;
      page.drawLine({ start: { x: c[0] + pad, y: H - c[3] + pad }, end: { x: c[2] - pad, y: H - c[1] - pad }, thickness: 1.6, color: ink });
    }
    return { ch, putChars, fitText, wrapWords, textLines, tick, warn: (m) => warn(`${ctx}：${m}`) };
  }

  function fmtValue(v, mode, cells, pre) {
    if (!v) return '';
    if (mode === 'digits') return digits(v);
    if (mode === 'id') {
      const dd = digits(v);
      if (dd.length === 12 && /^[\d\s-]+$/.test(v)) {
        return cells.length >= 14 ? `${dd.slice(0, 6)}-${dd.slice(6, 8)}-${dd.slice(8)}` : dd;
      }
      return v.replace(/\s/g, '');
    }
    if (mode === 'phone') {
      if (pre && pre.length) { // pre-printed dash at pre[0]
        const k = pre[0];
        let [a, b] = v.includes('-') ? [v.split('-')[0], v.split('-').slice(1).join('')] : [null, null];
        const dd = digits(v);
        if (a == null) { const n = /^01/.test(dd) || /^08/.test(dd) ? 3 : 2; a = dd.slice(0, n); b = dd.slice(n); }
        a = digits(a); b = digits(b);
        if (a.length > k) { b = a.slice(k) + b; a = a.slice(0, k); }
        const arr = new Array(cells.length).fill(' ');
        for (let i = 0; i < a.length; i++) arr[k - a.length + i] = a[i];
        for (let i = 0; i < b.length && k + 1 + i < cells.length; i++) arr[k + 1 + i] = b[i];
        if (k + 1 + b.length > cells.length) arr.overflow = true;
        return arr;
      }
      return digits(v);
    }
    return v;
  }

  async function build(PDFLib, templates, spec, data, selected) {
    const D = derive(data);
    const warnings = [];
    const out = await PDFLib.PDFDocument.create();
    out.setTitle(`Borang KWSP & PERKESO - ${D.co_name || 'SYARIKAT'}`);
    const font = await out.embedFont(PDFLib.StandardFonts.Helvetica);
    const srcCache = {};
    const src = async (k) => (srcCache[k] = srcCache[k] || await PDFLib.PDFDocument.load(templates[k]));
    let pageCount = 0;

    for (const f of FORMS) {
      if (!selected.includes(f.id)) continue;
      const specPages = spec.filter(p => p.pdf === f.pdf);
      const empPerPage = 10;
      const batches = f.emp ? Math.max(1, Math.ceil(D.employees.length / empPerPage)) : 1;
      for (let b = 0; b < batches; b++) {
        for (const sp of specPages) {
          const doc = await src(sp.pdf);
          const [pg] = await out.copyPages(doc, [sp.p]);
          out.addPage(pg); pageCount++;
          const H = pg.getHeight();
          const ctx = f.label + (batches > 1 ? ` (第 ${b + 1} 页)` : '');
          const dr = makeDrawer(PDFLib, pg, font, H, (m) => warnings.includes(m) || warnings.push(m), ctx);
          for (const it of sp.items) drawItem(dr, it, D, b * empPerPage);
        }
      }
    }
    return { bytes: await out.save(), warnings, pages: pageCount, D };
  }

  function drawItem(dr, it, D, empOffset) {
    const v = D[it.k];
    switch (it.t) {
      case 'cells': {
        const val = fmtValue(v, it.m, it.c, it.pre);
        if (!val) return;
        if (Array.isArray(val)) { // positioned (phone with dash)
          val.forEach((chr, i) => { if (chr && chr !== ' ' && it.c[i]) dr.ch(chr, it.c[i], Math.min(9.5, (it.c[i][3] - it.c[i][1]) * 0.66)); });
          if (val.overflow) dr.warn(`「${labelOf(it.k)}」太长，已截断`);
          return;
        }
        let cells = it.c;
        if (it.pre && it.pre.length) cells = it.c.filter((_, i) => !it.pre.includes(i));
        dr.putChars(val, cells, labelOf(it.k));
        return;
      }
      case 'wrap': {
        if (!v) return;
        const { rows, overflow } = dr.wrapWords(v, it.rows.map(r => r.length));
        if (overflow) dr.warn(`「${labelOf(it.k)}」${it.rows.length} 行放不下，已截断`);
        rows.forEach((s, i) => s && dr.putChars(s, it.rows[i], labelOf(it.k)));
        return;
      }
      case 'tick': if (v && v === it.v) dr.tick(it.c); return;
      case 'text': if (v) dr.fitText(v, it.x, it.y, it.w, it.fs || 9, it.al); return;
      case 'box': {
        if (!v) return;
        const c = it.c, fs = Math.min(it.fs || 9, (c[3] - c[1]) * 0.62);
        dr.fitText(v, c[0] + 4, (c[1] + c[3]) / 2 + fs * 0.36, c[2] - c[0] - 8, fs, 'l');
        return;
      }
      case 'emp': {
        it.rows.forEach((row, i) => {
          const e = D.employees[empOffset + i];
          if (!e) return;
          const L = (k) => `员工 ${empOffset + i + 1} ${k}`;
          const icv = fmtValue(e.ic, e.passport ? 'text' : 'id', row.ic);
          dr.putChars(icv, row.ic, L('IC'));
          dr.putChars(e.dob, row.dob, L('出生日期'));
          if (row.start) dr.putChars(e.start, row.start, L('入职日期'));
          const C = row.cols, y0 = row.y0, y1 = row.y1;
          const T = (key, text, fs) => C[key] && text && dr.textLines(text, C[key][0], C[key][1], y0, y1, fs);
          T('jenis', e.jenis, 9); T('nama', e.name, 8.5); T('jantina', e.gender, 9); T('bangsa', e.race, 9); T('job', e.job, 8);
          if (C.tick && e.over >= it.thr) {
            const cx = (C.tick[0] + C.tick[1]) / 2, cy = (y0 + y1) / 2;
            dr.tick([cx - 6, cy - 6, cx + 6, cy + 6]);
          }
        });
        return;
      }
    }
  }

  const LABELS = {
    co_name: '公司名称', co_reg: '注册号', biz_addr: '营业地址', reg_addr: '注册地址',
    mail_addr: '通讯地址', mail_addr_only: '通讯地址', a3_addr: '营业地址(A3)', nature: '业务性质',
    off_name: '联络人姓名', own_name: '东主姓名', adm_name: '管理员姓名', app_name: '申请人姓名', off_ic: '联络人 IC', own_ic: '东主 IC', adm_ic: '管理员 IC', app_ic: '申请人 IC',
    co_tel: '公司电话', co_mob: '公司手机', co_fax: '传真', off_pos: '联络人职位', own_pos: '东主职位', adm_tel: '管理员电话', adm_mob: '管理员手机', adm_tac: 'TAC 号码',
    off_tel1: '电话 1', off_tel2: '电话 2', off_mob: '联络人手机', off_fax: '联络人传真', own_cit: '国籍', n_emp: '员工人数', biz_pc: '邮区', mail_pc: '邮区',
    mail_city: '城市', mail_state: '州', biz_state: '州', socso_code: 'PERKESO 雇主编号', socso_kodper: 'Kod Perusahaan', emp_code: 'Kod Majikan / MyCoID',
  };
  const labelOf = (k) => LABELS[k] || k;

  const api = { FORMS, derive, build, icInfo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.BorangFiller = api;
})(typeof window !== 'undefined' ? window : globalThis);
