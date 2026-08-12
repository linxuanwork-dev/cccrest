const PDFDocument = require('pdfkit');

// Draws the letterhead image (if the company has one), then name/registration
// no./address, then the report title + period, then a divider — shared by
// every report export and the payroll voucher so they all look consistent.
function renderLetterheadHeader(doc, company, reportTitle, subtitle) {
  var y = doc.y;

  if (company.letterhead_data_url) {
    try {
      var match = company.letterhead_data_url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        var buffer = Buffer.from(match[2], 'base64');
        doc.image(buffer, doc.page.margins.left, y, { fit: [140, 70] });
        y += 78;
      }
    } catch (err) {
      // corrupt/unsupported image data — skip it rather than fail the export
    }
  }

  doc.y = y;
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#1a1a1a').text(company.name, { align: 'left' });
  doc.font('Helvetica').fontSize(9).fillColor('#444444');
  if (company.registration_no) doc.text('Registration No: ' + company.registration_no);
  if (company.address) doc.text(company.address);

  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#1a1a1a').text(reportTitle);
  if (subtitle) {
    doc.font('Helvetica').fontSize(9).fillColor('#666666').text(subtitle);
  }
  doc.moveDown(0.4);
  doc.moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor('#cccccc').stroke();
  doc.moveDown(0.8);
  doc.fillColor('#1a1a1a');
}

// Simple column-based table: columns = [{ key, label, width, align }], rows = [{...}]
function renderTable(doc, columns, rows) {
  var startX = doc.page.margins.left;
  var usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  var totalWeight = columns.reduce(function (s, c) { return s + (c.width || 1); }, 0);
  var colWidths = columns.map(function (c) { return (usableWidth * (c.width || 1)) / totalWeight; });

  function drawRow(values, opts) {
    opts = opts || {};
    var rowY = doc.y;
    var x = startX;
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(opts.color || '#1a1a1a');
    columns.forEach(function (col, i) {
      doc.text(String(values[i] == null ? '' : values[i]), x, rowY, {
        width: colWidths[i],
        align: col.align || 'left'
      });
      x += colWidths[i];
    });
    doc.moveDown(0.5);
  }

  drawRow(columns.map(function (c) { return c.label; }), { bold: true });
  doc.moveTo(startX, doc.y).lineTo(startX + usableWidth, doc.y).strokeColor('#cccccc').stroke();
  doc.moveDown(0.3);

  if (rows.length === 0) {
    doc.font('Helvetica').fontSize(9).fillColor('#888888').text('No records for this period.', startX);
    return;
  }

  rows.forEach(function (row) {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 40) {
      doc.addPage();
    }
    drawRow(columns.map(function (c) { return row[c.key]; }));
  });
}

module.exports = { renderLetterheadHeader, renderTable, PDFDocument };
