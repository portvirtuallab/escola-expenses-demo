// Builds the claim PDF on this device: branded summary pages, then every receipt
// (photos as full pages, PDF receipts merged page by page).
const Rules = globalThis.Rules;
const base = new URL('./', import.meta.url);

function loadPdfLib() {
  if (globalThis.PDFLib) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('pdf-lib.min.js', base).href;
    s.onload = resolve; s.onerror = () => reject(new Error('The PDF builder could not be loaded.'));
    document.head.appendChild(s);
  });
}

const A4 = [595.28, 841.89];
const M = 42;

/** @param getFile (attachment) => Promise<Blob> */
export async function buildClaimPdf(claim, getFile, onProgress = () => {}) {
  await loadPdfLib();
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const hex = h => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
  const C = { navy: hex('#062f66'), blue: hex('#0b4ea2'), cyan: hex('#009fe3'), amber: hex('#f9b233'), coral: hex('#e84e1b'), ink: hex('#10233d'), muted: hex('#65758a'), line: hex('#dfe7ef'), soft: hex('#edf3fb'), white: rgb(1, 1, 1) };

  const doc = await PDFDocument.create();
  doc.setTitle('Expense claim ' + (claim.reference || claim.id.slice(0, 8)));
  doc.setAuthor(claim.name || claim.ownerEmail);
  doc.setCreator('Escola Europea · Expense Claims');
  doc.setProducer('Escola Europea · Expense Claims');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logoBytes = await (await fetch(new URL('logo_blue.png', base))).arrayBuffer();
  const logo = await doc.embedPng(logoBytes);

  // Helvetica only covers WinAnsi: replace anything it cannot draw (e.g. Turkish ş, ı).
  const safe = (s, f = font) => {
    s = String(s ?? '').replace(/−/g, '-').replace(/[→]/g, '>').replace(/\s+/g, ' ');
    let out = '';
    for (const ch of s) {
      try { f.encodeText(ch); out += ch; }
      catch { const plain = ch.normalize('NFD').replace(/[̀-ͯ]/g, ''); try { f.encodeText(plain); out += plain; } catch { out += ch === 'ı' ? 'i' : '?'; } }
    }
    return out;
  };
  const width = (s, size, f = font) => f.widthOfTextAtSize(safe(s, f), size);
  const fit = (s, size, max, f = font) => { s = safe(s, f); if (f.widthOfTextAtSize(s, size) <= max) return s; while (s && f.widthOfTextAtSize(s + '…', size) > max) s = s.slice(0, -1); return s + '…'; };
  const wrap = (s, size, max, f = font) => {
    const words = safe(s, f).split(' '), lines = []; let cur = '';
    for (const w of words) { const t = cur ? cur + ' ' + w : w; if (f.widthOfTextAtSize(t, size) > max && cur) { lines.push(cur); cur = w; } else cur = t; }
    if (cur) lines.push(cur); return lines;
  };
  const money = v => safe(Rules.money(v));
  const t = Rules.totals(claim);

  let page, y, pageNo = 0;
  const pages = [];
  const newPage = () => {
    page = doc.addPage(A4); pages.push(page); pageNo++;
    page.drawRectangle({ x: 0, y: A4[1] - 6, width: A4[0] * 0.45, height: 6, color: C.cyan });
    page.drawRectangle({ x: A4[0] * 0.45, y: A4[1] - 6, width: A4[0] * 0.3, height: 6, color: C.amber });
    page.drawRectangle({ x: A4[0] * 0.75, y: A4[1] - 6, width: A4[0] * 0.25, height: 6, color: C.coral });
    const lh = 46, lw = lh * logo.width / logo.height;
    page.drawImage(logo, { x: M, y: A4[1] - 24 - lh, width: lw, height: lh });
    page.drawText('EXPENSE CLAIM', { x: A4[0] - M - width('EXPENSE CLAIM', 9, bold), y: A4[1] - 40, size: 9, font: bold, color: C.blue });
    const sub = 'Claim ' + claim.id.slice(0, 8).toUpperCase() + ' · ' + Rules.STATUS[claim.status];
    page.drawText(safe(sub), { x: A4[0] - M - width(sub, 8), y: A4[1] - 54, size: 8, font, color: C.muted });
    y = A4[1] - 92;
  };
  const ensure = h => { if (y - h < 56) newPage(); };
  const text = (s, x, size = 9, f = font, color = C.ink) => page.drawText(safe(s, f), { x, y, size, font: f, color });

  newPage();
  // Title block
  text(claim.reference || 'Expense claim', M, 20, bold, C.navy); y -= 18;
  text((claim.name || '') + ' · ' + claim.ownerEmail, M, 10, font, C.muted); y -= 24;

  // Details + total panel
  const panelW = 170, panelX = A4[0] - M - panelW, top = y + 8;
  page.drawRectangle({ x: panelX, y: top - 118, width: panelW, height: 118, color: C.navy });
  page.drawText('TOTAL CLAIMED', { x: panelX + 14, y: top - 22, size: 8, font: bold, color: C.cyan });
  page.drawText(money(t.total), { x: panelX + 14, y: top - 50, size: 22, font: bold, color: C.white });
  page.drawText(safe(`Cash ${Rules.money(t.cash)} · VISA ${Rules.money(t.visa)}`), { x: panelX + 14, y: top - 70, size: 8, font, color: C.white });
  page.drawText(safe(`Advance ${Rules.money(t.advance)}`), { x: panelX + 14, y: top - 84, size: 8, font, color: C.white });
  page.drawText(safe(`Cash balance - advance ${Rules.money(t.balance)}`), { x: panelX + 14, y: top - 98, size: 8, font: bold, color: C.amber });

  const details = [
    ['Reporting period', (claim.start || '—') + '  to  ' + (claim.end || '—')],
    ['Manager', claim.responsible || '—'],
    ['Administration', [claim.adminName, claim.adminEmail].filter(Boolean).join(' · ') || '—'],
    ['Receipts', `${t.withReceipt} of ${t.lines} expenses have a receipt`],
    ['Generated', new Date().toLocaleString('en-GB')]
  ];
  details.forEach(([k, v]) => { text(k, M, 8, font, C.muted); text(fit(v, 9.5, panelX - M - 110), M + 100, 9.5, bold); y -= 20; });
  y = Math.min(y, top - 130) - 6;

  // Category summary
  const cats = Object.entries(Rules.CATEGORIES);
  ensure(30 + cats.length * 16);
  text('Summary by category', M, 11, bold, C.navy); y -= 16;
  const sx = [M, M + 200, M + 300, M + 400];
  const headRow = (cols, xs, aligns) => {
    page.drawRectangle({ x: M, y: y - 5, width: A4[0] - 2 * M, height: 18, color: C.soft });
    cols.forEach((c, i) => { const w = width(c, 8, bold); page.drawText(safe(c, bold), { x: aligns[i] === 'r' ? xs[i] - w : xs[i] + 4, y, size: 8, font: bold, color: C.blue }); });
    y -= 18;
  };
  headRow(['Category', 'Cash', 'VISA', 'Total'], [M, M + 300, M + 400, A4[0] - M - 4], ['l', 'r', 'r', 'r']);
  cats.forEach(([k, label]) => {
    const v = t.byCategory[k];
    [[k + ' · ' + label, M + 4, 'l'], [money(v.Cash), M + 300, 'r'], [money(v.VISA), M + 400, 'r'], [money(v.Cash + v.VISA), A4[0] - M - 4, 'r']]
      .forEach(([s, x, a]) => page.drawText(safe(s), { x: a === 'r' ? x - width(s, 9) : x, y, size: 9, font, color: C.ink }));
    y -= 6; page.drawLine({ start: { x: M, y }, end: { x: A4[0] - M, y }, thickness: 0.5, color: C.line }); y -= 12;
  });
  y -= 14;

  // Expense table
  const cols = [
    { k: '#', x: M + 4, w: 16 }, { k: 'Date', x: M + 22, w: 54 }, { k: 'Supplier · location', x: M + 78, w: 150 },
    { k: 'Code', x: M + 232, w: 28 }, { k: 'Pay', x: M + 262, w: 34 }, { k: 'Original', x: M + 300, w: 76, r: true },
    { k: 'Rate', x: M + 380, w: 48, r: true }, { k: 'EUR', x: A4[0] - M - 4, w: 60, r: true }
  ];
  const tableHead = () => { headRow(cols.map(c => c.k), cols.map(c => c.r ? c.x + (c.k === 'EUR' ? 0 : c.w) : c.x - 4), cols.map(c => c.r ? 'r' : 'l')); };
  ensure(60);
  text('Expenses', M, 11, bold, C.navy); y -= 16;
  tableHead();
  claim.rows.forEach((r, i) => {
    const notes = [r.observations, r.attachments.length ? `Receipt: ${r.attachments.map(a => a.name).join(', ')}` : r.missingReason ? `Missing receipt: ${r.missingReason}` : ''].filter(Boolean).join(' — ');
    const noteLines = notes ? wrap(notes, 7.5, A4[0] - 2 * M - 90).slice(0, 3) : [];
    const h = 16 + noteLines.length * 10;
    if (y - h < 56) { newPage(); tableHead(); }
    const vals = [String(i + 1), r.date, fit([r.vendor, r.city].filter(Boolean).join(' · '), 9, 150), r.category, r.payment,
      `${Number(r.amount).toFixed(2)} ${r.currency}`, String(r.rate), money(Rules.cents(r) / 100)];
    cols.forEach((c, j) => {
      const s = safe(vals[j]); const f = j === 7 ? bold : font;
      const x = c.r ? (j === 7 ? c.x : c.x + c.w) - f.widthOfTextAtSize(s, 9) : c.x;
      page.drawText(s, { x, y, size: 9, font: f, color: C.ink });
    });
    y -= 11;
    noteLines.forEach(l => { page.drawText(l, { x: M + 78, y, size: 7.5, font, color: C.muted }); y -= 10; });
    y -= 2; page.drawLine({ start: { x: M, y: y + 4 }, end: { x: A4[0] - M, y: y + 4 }, thickness: 0.5, color: C.line }); y -= 6;
  });
  ensure(30);
  page.drawText('Total', { x: M + 4, y, size: 10, font: bold, color: C.navy });
  page.drawText(money(t.total), { x: A4[0] - M - 4 - width(money(t.total), 10, bold), y, size: 10, font: bold, color: C.navy });
  y -= 30;

  // History
  ensure(40);
  text('Approval history', M, 11, bold, C.navy); y -= 16;
  claim.history.forEach(h => {
    const lines = h.comment ? wrap('“' + h.comment + '”', 8, A4[0] - 2 * M - 160) : [];
    ensure(16 + lines.length * 10);
    page.drawCircle({ x: M + 4, y: y + 3, size: 3, color: C.cyan });
    text(h.text, M + 14, 9, bold);
    const meta = new Date(h.at).toLocaleString('en-GB') + ' · ' + h.by;
    page.drawText(safe(meta), { x: A4[0] - M - width(meta, 8), y, size: 8, font, color: C.muted });
    y -= 12;
    lines.forEach(l => { page.drawText(l, { x: M + 14, y, size: 8, font, color: C.muted }); y -= 10; });
    y -= 4;
  });

  // Signature boxes
  ensure(80); y -= 10;
  ['Claimant', 'Manager approval', 'Administration'].forEach((label, i) => {
    const w = (A4[0] - 2 * M - 20) / 3, x = M + i * (w + 10);
    page.drawRectangle({ x, y: y - 50, width: w, height: 56, borderColor: C.line, borderWidth: 0.8 });
    page.drawText(safe(label), { x: x + 8, y: y - 6, size: 8, font: bold, color: C.blue });
  });

  // Receipts
  const atts = claim.rows.flatMap((r, i) => r.attachments.map(a => ({ a, r, i })));
  let done = 0;
  for (const { a, r, i } of atts) {
    onProgress(++done, atts.length, a.name);
    let blob;
    try { blob = await getFile(a); } catch { blob = null; }
    const caption = `Receipt · Expense ${i + 1} · ${r.date} · ${r.vendor} · ${Rules.money(Rules.cents(r) / 100)} · ${a.name}`;
    const stampPage = p => {
      const [w, h] = [p.getWidth(), p.getHeight()];
      p.drawRectangle({ x: 0, y: h - 22, width: w, height: 22, color: C.navy });
      p.drawText(fit(caption, 8, w - 24), { x: 12, y: h - 15, size: 8, font, color: C.white });
    };
    if (!blob) {
      newPage(); text('Receipt could not be loaded: ' + a.name, M, 10, bold, C.coral); continue;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    try {
      if (a.type === 'application/pdf') {
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const copied = await doc.copyPages(src, src.getPageIndices());
        copied.forEach(p => { doc.addPage(p); stampPage(p); });
      } else {
        const img = a.type === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        const p = doc.addPage(A4);
        const maxW = A4[0] - 2 * M, maxH = A4[1] - 2 * M - 30;
        const s = Math.min(maxW / img.width, maxH / img.height, 1.5);
        p.drawImage(img, { x: (A4[0] - img.width * s) / 2, y: (A4[1] - 30 - img.height * s) / 2, width: img.width * s, height: img.height * s });
        stampPage(p);
      }
    } catch {
      newPage(); text('Receipt could not be added to the PDF: ' + a.name, M, 10, bold, C.coral);
    }
  }

  // Footer with page numbers on summary pages
  const total = doc.getPageCount();
  doc.getPages().forEach((p, idx) => {
    const s = `Escola Europea – Intermodal Transport · Page ${idx + 1} of ${total}`;
    p.drawText(safe(s), { x: (p.getWidth() - width(s, 7)) / 2, y: 18, size: 7, font, color: C.muted });
  });

  return new Blob([await doc.save()], { type: 'application/pdf' });
}
