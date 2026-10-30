/* Reads scanned / photographed SSM documents (PDF without a text layer, or JPG/PNG photos) with OCR, entirely in
   the browser (tesseract.js + English data served from this app; nothing is uploaded anywhere).
   Output matches SSMReader.pagesFromPdf: [{ items: [{ str, x, y, w, h }] }] in PDF points, y measured from the top. */
(function (root) {
  'use strict';
  const BASE = '/api/kwsp/assets/vendor/tesseract/';
  const PAGE_WIDTH_PT = 595;               // item coordinates are scaled to an A4-wide page, like the PDF text layer
  const TARGET_PX = 2400;                  // width the page is rendered at before OCR

  /* Photo clean-up: grayscale, remove uneven lighting / shadows, black-and-white, then erase long table borders so
     the words inside the table cells can be read. Works in place on RGBA pixels. */
  function binarize(rgba, w, h, eraseLines) {
    const gray = new Float32Array(w * h);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    const W = w + 1, integ = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += gray[y * w + x]; integ[(y + 1) * W + x + 1] = integ[y * W + x + 1] + row; } }
    const r = Math.max(15, Math.round(w / 16));
    const bw = new Uint8Array(w * h);                       // 1 = ink
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const mean = (integ[y1 * W + x1] - integ[y0 * W + x1] - integ[y1 * W + x0] + integ[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
        bw[y * w + x] = gray[y * w + x] < mean * 0.86 ? 1 : 0;
      }
    }
    // (an ID card has no table borders, so for cards nothing is erased)
    const hMin = eraseLines === false ? Infinity : Math.round(w * 0.1), vMin = eraseLines === false ? Infinity : Math.max(60, Math.round(h * 0.02));
    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        if (!bw[y * w + x]) { x++; continue; }
        let e = x; while (e < w && bw[y * w + e]) e++;
        if (e - x >= hMin) for (let k = x; k < e; k++) bw[y * w + k] = 0;
        x = e;
      }
    }
    for (let x = 0; x < w; x++) {
      let y = 0;
      while (y < h) {
        if (!bw[y * w + x]) { y++; continue; }
        let e = y; while (e < h && bw[e * w + x]) e++;
        if (e - y >= vMin) for (let k = y; k < e; k++) bw[k * w + x] = 0;
        y = e;
      }
    }
    for (let i = 0, j = 0; i < bw.length; i++, j += 4) { const v = bw[i] ? 0 : 255; rgba[j] = rgba[j + 1] = rgba[j + 2] = v; rgba[j + 3] = 255; }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  let workerPromise = null;
  function getWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = (async () => {
      if (!root.Tesseract) await loadScript(BASE + 'tesseract.min.js');
      const abs = (p) => location.origin + p;
      return root.Tesseract.createWorker('eng', 1, {
        workerPath: abs(BASE + 'worker.min.js'),
        corePath: abs(BASE),
        langPath: abs(BASE),
        workerBlobURL: false
      });
    })().catch((e) => { workerPromise = null; throw e; });
    return workerPromise;
  }

  // drop stray table-border marks the OCR reads as characters
  const clean = (t) => t.replace(/^[|[\]!_~=—"'“”‘’]+(?=.)/, '').replace(/(?<=.)[|[\]!_~=]+$/, '').replace(/^["'“”‘’]+$/, '');

  async function recognizeCanvas(worker, canvas, opts) {
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    binarize(img.data, canvas.width, canvas.height, opts && opts.eraseLines);
    ctx.putImageData(img, 0, 0);
    const r = await worker.recognize(canvas, {}, { blocks: true });
    const sc = PAGE_WIDTH_PT / canvas.width, items = [];
    (r.data.blocks || []).forEach((b) => b.paragraphs.forEach((p) => p.lines.forEach((l) => l.words.forEach((wd) => {
      const text = clean(wd.text || '');
      if (!/[A-Za-z0-9]/.test(text)) return;
      if (text.length <= 3 && wd.confidence < 60) return;   // short low-confidence bits are usually table-border debris
      // trailing space: OCR word boxes sit closer together than PDF text pieces
      items.push({ str: text + ' ', x: wd.bbox.x0 * sc, y: wd.bbox.y1 * sc, w: (wd.bbox.x1 - wd.bbox.x0) * sc, h: (wd.bbox.y1 - wd.bbox.y0) * sc });
    }))));
    return { items };
  }

  /* progress(done, total) is called as pages finish */
  async function pagesFromScannedPdf(pdfjsLib, bytes, progress) {
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
    const worker = await getWorker();
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      if (progress) progress(i, doc.numPages);
      const pg = await doc.getPage(i);
      const base = pg.getViewport({ scale: 1 });
      const vp = pg.getViewport({ scale: Math.min(5, Math.max(2, TARGET_PX / base.width)) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
      await pg.render({ canvasContext: canvas.getContext('2d', { willReadFrequently: true }), viewport: vp }).promise;
      pages.push(await recognizeCanvas(worker, canvas));
    }
    return pages;
  }

  async function pagesFromImage(file, progress) {
    const worker = await getWorker();
    if (progress) progress(1, 1);
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1.5, TARGET_PX / bmp.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return [await recognizeCanvas(worker, canvas)];
  }

  /* ---------- Malaysian ID card (MyKad) ---------- */
  const fixDigits = (s) => s.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
  const IC_RE = /([\dOoIl|]{6})\s*[-–—]?\s*([\dOoIl|]{2})\s*[-–—]?\s*([\dOoIl|]{4})/;
  const STOP_RE = /\b(WARGANEGARA|LELAKI|PEREMPUAN|ISLAM|BUKAN\s*ISLAM|KRISTIAN|BUDDHA|HINDU|MYKAD|KAD\s*PENGENALAN)\b/;

  // groups OCR words into text lines (top to bottom)
  function toRows(items) {
    const hs = items.map((i) => i.h).sort((a, b) => a - b);
    const tol = Math.max(2.5, (hs[hs.length >> 1] || 8) * 0.55);
    const rows = [];
    items.slice().sort((a, b) => a.y - b.y || a.x - b.x).forEach((it) => {
      const r = rows.find((r) => Math.abs(r.y - it.y) < tol);
      if (r) r.items.push(it); else rows.push({ y: it.y, items: [it] });
    });
    return rows.map((r) => r.items.sort((a, b) => a.x - b.x).map((i) => i.str.trim()).filter(Boolean).join(' ')).filter(Boolean);
  }

  // rows of text -> { ic, name, address, dob, gender, nationality } (empty strings where nothing was found)
  function parseIdCard(rows) {
    const out = { ic: '', name: '', address: '', dob: '', gender: '', nationality: '' };
    let at = -1;
    for (let i = 0; i < rows.length; i++) {
      const m = IC_RE.exec(rows[i]);
      if (m) { out.ic = fixDigits(m[1]) + '-' + fixDigits(m[2]) + '-' + fixDigits(m[3]); at = i; break; }
    }
    const whole = rows.join(' ').toUpperCase();
    if (/PEREMPUAN/.test(whole)) out.gender = 'P'; else if (/LELAKI/.test(whole)) out.gender = 'L';
    if (/WARGANEGARA/.test(whole)) out.nationality = 'MALAYSIA';
    if (out.ic) {
      const d = out.ic.replace(/-/g, '');
      const yy = +d.slice(0, 2), mm = d.slice(2, 4), dd = d.slice(4, 6);
      const nowYY = new Date().getFullYear() % 100;
      const year = (yy <= nowYY ? 2000 : 1900) + yy;
      if (+mm >= 1 && +mm <= 12 && +dd >= 1 && +dd <= 31) out.dob = year + '-' + mm + '-' + dd;
      out.gender = (+d.slice(-1)) % 2 === 1 ? 'L' : 'P';        // the last digit of the IC decides it (odd = male)
    }
    if (at >= 0) {
      const nameRows = [], addrRows = [];
      let inAddr = false;
      for (let i = at + 1; i < rows.length; i++) {
        const up = rows[i].toUpperCase().trim();
        if (STOP_RE.test(up)) { if (inAddr || nameRows.length) break; else continue; }
        if (!inAddr && /[\d,]/.test(up)) inAddr = true;          // the name has no digits or commas; the address does
        (inAddr ? addrRows : nameRows).push(rows[i].trim());
      }
      out.name = nameRows.join(' ').toUpperCase().replace(/[^A-Z@'./ -]+/g, ' ').replace(/\s+/g, ' ').trim();
      out.address = addrRows.map((r) => r.toUpperCase().replace(/\s+/g, ' ').replace(/[|_~]+/g, '').trim()).filter(Boolean).join(', ');
    }
    return out;
  }

  /* Reads one photo of the front of an ID card. progress() is called when the recognition starts. */
  async function readIdCard(file, progress) {
    const worker = await getWorker();
    if (progress) progress();
    const bmp = await createImageBitmap(file);
    const scale = Math.min(2, 1800 / bmp.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const page = await recognizeCanvas(worker, canvas, { eraseLines: false });
    const rows = toRows(page.items.map((i) => ({ str: i.str, x: i.x, y: i.y, w: i.w, h: i.h })));
    const parsed = parseIdCard(rows);
    if (!parsed.ic) {
      // the big IC number is often skipped by the normal page layout: look for it again as loose digits only
      try {
        await worker.setParameters({ tessedit_char_whitelist: '0123456789-', tessedit_pageseg_mode: '11' });
        const again = await recognizeCanvas(worker, canvas, { eraseLines: false });
        const m = IC_RE.exec(toRows(again.items).join(' '));
        if (m) {
          const ic = fixDigits(m[1]) + '-' + fixDigits(m[2]) + '-' + fixDigits(m[3]);
          const filled = parseIdCard([ic].concat(rows));          // the number first, then the card's own text lines
          return Object.assign(filled, { rows });
        }
      } catch (e) { /* keep what the first pass found */ }
      finally { await worker.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '3' }).catch(() => {}); }
    }
    return Object.assign(parsed, { rows });
  }

  root.SSMOcr = { pagesFromScannedPdf, pagesFromImage, binarize, readIdCard, parseIdCard };
})(window);
