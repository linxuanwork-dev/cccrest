/* KWSP "Authorization to Open KWSP Employer Account" letter, filled from the KWSP page data and printed on the
   company letterhead (an uploaded letterhead image if the company profile has one, otherwise a letterhead built from
   the company name + registration no. + address, laid out like the sample letterhead).
   AuthLetter.build(PDFLib, data, profile, opts) -> { bytes, warnings } */
(function (root) {
  'use strict';
  const A4 = [595.28, 841.89];
  const MARGIN = 72;                                   // 1 inch, same as the Word sample
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const up = (s) => String(s || '').trim().toUpperCase();
  // Helvetica can only draw Latin-1; anything else is shown as ? instead of stopping the whole letter
  const safe = (s) => String(s == null ? '' : s).replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

  function longDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date();
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }
  function addressLine(a) {
    if (!a) return '';
    return [a.line1, a.line2, a.line3, [a.pc, a.city].filter(Boolean).join(' '), a.state].map((x) => String(x || '').trim()).filter(Boolean).join(', ').toUpperCase() + '.';
  }

  async function toPng(dataUrl) {                       // JPG / PNG / WebP -> PNG bytes pdf-lib can embed
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d');
    // Flatten onto white: a transparent PNG would otherwise go into the PDF as a colour layer + a transparency layer, and
    // viewers that ignore the transparency layer (phone previews, some printers) show the transparent area as black.
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0);
    const png = await new Promise((res) => c.toBlob(res, 'image/png'));
    return { bytes: new Uint8Array(await png.arrayBuffer()), w: bmp.width, h: bmp.height };
  }

  function wrap(font, text, size, maxW) {
    const words = safe(text).split(/\s+/).filter(Boolean), lines = []; let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (font.widthOfTextAtSize(t, size) <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  async function build(PDFLib, data, profile, opts) {
    opts = opts || {};
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const warnings = [];
    const c = data.company || {}, off = data.officer || {}, own = data.owner || {}, sgn = data.signer || {};
    const companyName = up(c.name) || up(profile && (profile.legalName || profile.name));
    const person = up(off.name), nric = up(off.ic);
    const signSame = data.signSame !== false;
    const signerName = up(signSame ? own.name : sgn.name) || up(own.name);
    const signerPos = (() => { const p = up(signSame ? own.pos : sgn.pos); return !p || p === 'PENGARAH' ? 'DIRECTOR' : p; })();
    if (!companyName) warnings.push('授权信：公司名称没填。');
    if (!person) warnings.push('授权信：联络人姓名没填（第 4 项）。');
    if (!nric) warnings.push('授权信：联络人 IC 没填（第 4 项）。');
    if (!signerName) warnings.push('授权信：东主 / 董事姓名没填（第 5 项）。');

    const doc = await PDFDocument.create();
    const page = doc.addPage(A4);
    const [W, H] = A4;
    const reg = doc.embedFont(StandardFonts.Helvetica), bold = doc.embedFont(StandardFonts.HelveticaBold);
    const [font, fontB] = await Promise.all([reg, bold]);
    const ink = rgb(0, 0, 0);
    let y = H - MARGIN;

    /* ---------- letterhead ---------- */
    const lhUrl = profile && profile.letterheadDataUrl;
    if (lhUrl) {
      const img = await toPng(lhUrl); const emb = await doc.embedPng(img.bytes);
      const ratio = img.h / img.w;
      if (ratio > 0.5) {                                 // a whole-page letterhead: use it as the page background
        page.drawImage(emb, { x: 0, y: 0, width: W, height: H });
        y = H - MARGIN - 30;
      } else {                                           // a header band across the top
        const w = W - 2 * 36, h = Math.min(150, w * ratio);
        page.drawImage(emb, { x: 36, y: H - 30 - h, width: w, height: h });
        y = H - 30 - h - 36;
      }
    } else {
      // no letterhead uploaded: company name (bold 18) + registration no. (9), then the address (11), like the sample
      const regNo = (c.reg || (profile && profile.registrationNo) || '').trim();
      const old = (profile && profile.oldRegistrationNo) ? '(' + profile.oldRegistrationNo + ')' : '';
      const addr = addressLine(data.bizAddr && (data.bizAddr.line1 || data.bizAddr.pc) ? data.bizAddr : data.regAddr)
        || up(profile && profile.addresses && profile.addresses[0] ? [profile.addresses[0].street, [profile.addresses[0].postcode, profile.addresses[0].city].filter(Boolean).join(' '), profile.addresses[0].state].filter(Boolean).join(', ') : '');
      let x = MARGIN;
      if (profile && profile.logoDataUrl) {
        const lg = await toPng(profile.logoDataUrl); const le = await doc.embedPng(lg.bytes);
        const lh = 46, lw = Math.min(110, lh * lg.w / lg.h);
        page.drawImage(le, { x: MARGIN, y: y - lh + 6, width: lw, height: lh });
        x = MARGIN + lw + 12;
      }
      const nameSize = 18, regSize = 9;
      const nm = safe(companyName), nmW = fontB.widthOfTextAtSize(nm, nameSize);
      page.drawText(nm, { x, y: y - 14, size: nameSize, font: fontB, color: ink });
      const regTxt = safe(regNo + old);
      if (regTxt) page.drawText(regTxt, { x: x + nmW + 6, y: y - 14, size: regSize, font, color: ink });
      wrap(font, addr, 11, W - MARGIN - x).forEach((ln, i) => page.drawText(ln, { x, y: y - 32 - i * 14, size: 11, font, color: ink }));
      y -= 32 + Math.max(1, wrap(font, addr, 11, W - MARGIN - x).length) * 14 + 28;
    }

    /* ---------- body ---------- */
    const maxW = W - 2 * MARGIN, size = 11, lead = 15;
    const line = (txt, o) => {
      o = o || {};
      const f = o.bold ? fontB : font;
      const t = safe(txt);
      page.drawText(t, { x: MARGIN, y, size, font: f, color: ink });
      if (o.underline) page.drawLine({ start: { x: MARGIN, y: y - 2 }, end: { x: MARGIN + f.widthOfTextAtSize(t, size), y: y - 2 }, thickness: 0.8, color: ink });
      y -= lead;
    };
    const para = (txt, o) => { wrap((o && o.bold) ? fontB : font, txt, size, maxW).forEach((ln) => line(ln, o)); };
    const gap = (n) => { y -= lead * (n == null ? 1 : n); };

    line(longDate(data.signDate)); gap();
    line('To Whom It May Concern,', { bold: true }); gap();
    line('Subject: Authorization to Open KWSP Employer Account', { bold: true, underline: true }); gap();
    para('We, ' + (companyName || '[COMPANY NAME]') + ', hereby authorize ' + (person || '[CONTACT PERSON]') + ', NRIC No. ' + (nric || '[NRIC]') +
      ', to act on our behalf for the purpose of registering and opening an employer account with KWSP (Employees Provident Fund).');
    gap();
    line('Thank you for your assistance.');
    line('Yours sincerely,');
    gap(3);
    line('_________________________________');
    line(signerName || '[DIRECTOR NAME]', { bold: true });
    line(signerPos, { bold: true });

    if (opts.stamp) {                                    // who printed it and when, small, bottom right
      const t = safe(opts.stamp), w = font.widthOfTextAtSize(t, 6.5);
      page.drawText(t, { x: W - w - 14, y: 8, size: 6.5, font, color: rgb(0.3, 0.3, 0.3) });
    }
    return { bytes: await doc.save(), warnings };
  }

  root.AuthLetter = { build };
})(window);
