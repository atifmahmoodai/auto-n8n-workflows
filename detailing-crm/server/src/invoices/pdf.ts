import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import PDFDocument from 'pdfkit';
import { formatMoney } from '../lib/money.js';
import type { OrgContext } from '../lib/org.js';
import type { Storage } from '../lib/storage.js';
import type { InvoiceDetail } from './service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// DejaVu covers Latin, Greek and Cyrillic, so customer names with accents/non-English letters render.
const FONT_DIR = path.resolve(here, '..', '..', 'assets', 'fonts');
const REGULAR = path.join(FONT_DIR, 'DejaVuSans.ttf');
const BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function renderInvoicePdf(invoice: InvoiceDetail, org: OrgContext, storage: Storage): Promise<Buffer> {
  // Load photo thumbnails up front (missing files are skipped, never fatal).
  const photos: Array<{ kind: string; data: Buffer }> = [];
  for (const p of invoice.photos.slice(0, 8)) {
    try {
      photos.push({ kind: p.kind, data: await readAll(storage.createReadStream(p.thumb_key)) });
    } catch {
      // file missing on disk: skip
    }
  }

  const doc = new PDFDocument({
    size: 'A4',
    margin: 50,
    info: { Title: `Invoice ${invoice.number}`, Author: org.name },
  });
  doc.registerFont('regular', REGULAR);
  doc.registerFont('bold', BOLD);
  const done = readAll(doc);

  const money = (c: number) => formatMoney(c, org.currency, org.settings.locale);
  const date = (d: string) => DateTime.fromISO(d).setLocale(org.settings.locale).toLocaleString(DateTime.DATE_MED);
  const left = 50;
  const right = doc.page.width - 50;
  const width = right - left;
  const gray = '#6b7280';
  const b = org.settings.business;

  // Header
  doc
    .font('bold')
    .fontSize(20)
    .fillColor('#111827')
    .text(org.name, left, 50, { width: width * 0.6 });
  doc.font('regular').fontSize(9).fillColor(gray);
  for (const line of [
    b.address,
    [b.phone, b.email].filter(Boolean).join('  ·  '),
    b.website,
    b.vat_number ? `VAT No. ${b.vat_number}` : '',
  ]) {
    if (line) doc.text(line, { width: width * 0.6 });
  }
  doc.font('bold').fontSize(22).fillColor('#111827').text('INVOICE', left, 50, { width, align: 'right' });
  doc.font('regular').fontSize(10).fillColor('#111827');
  doc.text(invoice.number, { width, align: 'right' });
  doc.fillColor(gray).text(`Issued ${date(invoice.issue_date)}`, { width, align: 'right' });
  doc.text(`Due ${date(invoice.due_date)}`, { width, align: 'right' });
  const statusLabel =
    invoice.status === 'void'
      ? 'VOID'
      : invoice.status === 'paid'
        ? 'PAID'
        : invoice.paid_cents > 0
          ? 'PART PAID'
          : 'DUE';
  doc
    .font('bold')
    .fillColor(invoice.status === 'paid' ? '#15803d' : invoice.status === 'void' ? '#b91c1c' : '#b45309')
    .text(statusLabel, { width, align: 'right' });

  // Bill to
  let y = Math.max(doc.y, 150) + 20;
  doc.font('bold').fontSize(9).fillColor(gray).text('BILL TO', left, y);
  doc.font('regular').fontSize(10).fillColor('#111827');
  const bt = invoice.bill_to;
  for (const line of [bt.name, bt.address, bt.phone, bt.email]) if (line) doc.text(line);
  if (bt.vehicle) doc.fillColor(gray).text(`Vehicle: ${bt.vehicle}${bt.vin ? ` · VIN ${bt.vin}` : ''}`);
  if (invoice.appointment_start_at) {
    doc
      .fillColor(gray)
      .text(
        `Service date: ${DateTime.fromJSDate(invoice.appointment_start_at).setZone(org.timezone).setLocale(org.settings.locale).toLocaleString(DateTime.DATE_MED)}`,
      );
  }

  // Items table
  y = doc.y + 20;
  const col = { desc: left, qty: left + width * 0.58, unit: left + width * 0.7, total: left + width * 0.84 };
  const header = (atY: number) => {
    doc.font('bold').fontSize(9).fillColor(gray);
    doc.text('DESCRIPTION', col.desc, atY);
    doc.text('QTY', col.qty, atY, { width: width * 0.1, align: 'right' });
    doc.text('UNIT', col.unit, atY, { width: width * 0.13, align: 'right' });
    doc.text('AMOUNT', col.total, atY, { width: width * 0.16, align: 'right' });
    doc
      .moveTo(left, atY + 14)
      .lineTo(right, atY + 14)
      .strokeColor('#e5e7eb')
      .stroke();
    return atY + 22;
  };
  y = header(y);
  doc.font('regular').fontSize(10).fillColor('#111827');
  for (const item of invoice.items) {
    const h = doc.heightOfString(item.description, { width: width * 0.56 });
    if (y + h > doc.page.height - 120) {
      doc.addPage();
      y = header(50);
      doc.font('regular').fontSize(10).fillColor('#111827');
    }
    doc.text(item.description, col.desc, y, { width: width * 0.56 });
    doc.text(String(item.quantity), col.qty, y, { width: width * 0.1, align: 'right' });
    doc.text(money(item.unit_price_cents), col.unit, y, { width: width * 0.13, align: 'right' });
    doc.text(money(item.total_cents), col.total, y, { width: width * 0.16, align: 'right' });
    y += Math.max(h, 12) + 8;
  }
  doc.moveTo(left, y).lineTo(right, y).strokeColor('#e5e7eb').stroke();
  y += 10;

  // Totals
  const taxPct = `${(invoice.tax_rate_bp / 100).toFixed(invoice.tax_rate_bp % 100 === 0 ? 0 : 2)}%`;
  const rows: Array<[string, string, boolean?]> = [['Subtotal', money(invoice.subtotal_cents)]];
  if (invoice.discount_cents > 0) rows.push(['Discount', `−${money(invoice.discount_cents)}`]);
  if (invoice.tax_rate_bp > 0)
    rows.push([invoice.prices_include_tax ? `VAT ${taxPct} (included)` : `VAT ${taxPct}`, money(invoice.tax_cents)]);
  rows.push(['Total', money(invoice.total_cents), true]);
  if (invoice.paid_cents > 0) rows.push(['Paid', `−${money(invoice.paid_cents)}`]);
  if (invoice.status !== 'void')
    rows.push(['Balance due', money(Math.max(0, invoice.total_cents - invoice.paid_cents)), true]);
  if (y > doc.page.height - 160) {
    doc.addPage();
    y = 50;
  }
  for (const [label, value, strong] of rows) {
    doc
      .font(strong ? 'bold' : 'regular')
      .fontSize(strong ? 11 : 10)
      .fillColor('#111827');
    doc.text(label, left + width * 0.5, y, { width: width * 0.32, align: 'right' });
    doc.text(value, col.total, y, { width: width * 0.16, align: 'right' });
    y += strong ? 18 : 15;
  }
  if (invoice.status === 'void' && invoice.void_reason) {
    doc
      .font('regular')
      .fontSize(9)
      .fillColor('#b91c1c')
      .text(`Voided: ${invoice.void_reason}`, left, y + 6, { width });
    y = doc.y;
  }

  // Notes / payment instructions
  if (invoice.notes) {
    y += 16;
    if (y > doc.page.height - 100) {
      doc.addPage();
      y = 50;
    }
    doc.font('regular').fontSize(9).fillColor(gray).text(invoice.notes, left, y, { width });
    y = doc.y;
  }

  // Before & after photos
  if (photos.length) {
    y += 24;
    const cell = (width - 3 * 10) / 4;
    const imgH = cell * 0.75;
    if (y + 16 + imgH > doc.page.height - 50) {
      doc.addPage();
      y = 50;
    }
    doc.font('bold').fontSize(9).fillColor(gray).text('BEFORE & AFTER', left, y);
    y += 16;
    photos.forEach((p, i) => {
      const colIdx = i % 4;
      if (i > 0 && colIdx === 0) {
        y += imgH + 22;
        if (y + imgH > doc.page.height - 50) {
          doc.addPage();
          y = 50;
        }
      }
      const x = left + colIdx * (cell + 10);
      try {
        doc.image(p.data, x, y, { fit: [cell, imgH], align: 'center', valign: 'center' });
      } catch {
        // unsupported image data: leave the cell empty
      }
      doc
        .font('regular')
        .fontSize(8)
        .fillColor(gray)
        .text(p.kind === 'before' ? 'Before' : 'After', x, y + imgH + 3, { width: cell, align: 'center' });
    });
  }

  doc.end();
  return done;
}
