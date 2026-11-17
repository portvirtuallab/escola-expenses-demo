// Receipt scanner: camera capture, image compression and on-device OCR (Tesseract, self-hosted).
// Nothing leaves the device during recognition; only the final receipt file is uploaded.

const base = new URL('../', import.meta.url);
let workerPromise = null;

/* ───────── camera ───────── */

export function canUseCamera() { return !!navigator.mediaDevices?.getUserMedia; }

/**
 * Opens a full-screen camera with a capture button. Resolves with a JPEG File,
 * or null if cancelled. Falls back to the system picker when no camera is available.
 */
export function captureFromCamera() {
  return new Promise(async resolve => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    } catch {
      return resolve(pickFile(true));
    }
    const ui = document.createElement('div');
    ui.className = 'camera';
    ui.innerHTML = `<div class="cameraTop"><b>Scan a receipt</b><span>Fill the frame with the receipt, flat and well lit.</span></div>
      <div class="cameraView"><video playsinline autoplay muted></video><div class="frame"></div></div>
      <div class="cameraBar"><button type="button" data-act="cancel">Cancel</button><button type="button" class="shutter" data-act="shot" aria-label="Take photo"></button><button type="button" data-act="file">Choose file</button></div>`;
    document.body.appendChild(ui);
    const video = ui.querySelector('video');
    video.srcObject = stream;
    const close = v => { stream.getTracks().forEach(t => t.stop()); ui.remove(); resolve(v); };
    ui.addEventListener('click', async e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') close(null);
      if (act === 'file') { stream.getTracks().forEach(t => t.stop()); ui.remove(); resolve(pickFile(false)); }
      if (act === 'shot') {
        const c = document.createElement('canvas');
        c.width = video.videoWidth; c.height = video.videoHeight;
        c.getContext('2d').drawImage(video, 0, 0);
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
        close(await compressImage(new File([blob], 'receipt-' + stamp() + '.jpg', { type: 'image/jpeg' })));
      }
    });
  });
}

export function pickFile(capture) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,application/pdf';
    if (capture) input.capture = 'environment';
    input.onchange = async () => { const f = input.files[0]; resolve(f ? await compressImage(f) : null); };
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');

/** Downscales large photos (≤ 2000 px, JPEG 0.82) so uploads stay small. PDFs and small images pass through. */
export async function compressImage(file) {
  if (!/^image\/(jpeg|png)$/.test(file.type) || file.size < 600 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.(png|jpe?g)$/i, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}

/* ───────── OCR ───────── */

function loadTesseract() {
  if (globalThis.Tesseract) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('vendor/tesseract/tesseract.min.js', base).href;
    s.onload = resolve; s.onerror = () => reject(new Error('The receipt reader could not be loaded.'));
    document.head.appendChild(s);
  });
}

async function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadTesseract();
      const worker = await Tesseract.createWorker('eng', 1, {
        workerPath: new URL('vendor/tesseract/worker.min.js', base).href,
        corePath: new URL('vendor/tesseract/core', base).href,
        langPath: new URL('vendor/tesseract/lang', base).href,
        gzip: true,
        logger: m => getWorker.progress?.(m)
      });
      return worker;
    })().catch(e => { workerPromise = null; throw e; });
  }
  getWorker.progress = onProgress;
  return workerPromise;
}

/** Reads a receipt image on this device. Resolves with { text, fields, confidence }. */
export async function readReceipt(file, onProgress) {
  if (!/^image\//.test(file.type)) return { text: '', fields: {}, confidence: 0, skipped: 'Only photos can be read automatically.' };
  const worker = await getWorker(onProgress);
  const prepared = await prepareForOcr(file);
  const { data } = await worker.recognize(prepared);
  return { text: data.text, confidence: data.confidence, fields: parseReceipt(data.text) };
}

/** Greyscale + contrast stretch: noticeably better OCR on thermal receipts. */
async function prepareForOcr(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) { const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; d[i] = g; if (g < min) min = g; if (g > max) max = g; }
  const range = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) { const v = Math.max(0, Math.min(255, ((d[i] - min) / range) * 255)); d[i] = d[i + 1] = d[i + 2] = v; }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ───────── parsing ───────── */

const TOTAL_WORDS = /(total\s*(a\s*pagar|amount|due|eur|€)?|importe(\s*total)?|amount\s*due|grand\s*total|toplam|summe|montant|to\s*pay|a\s*pagar|total\s*tl)/i;
const SKIP_WORDS = /(subtotal|sub-total|base\s*imp|iva|vat|tax|kdv|cambio|change|entregado|cash\s*given|tip|propina|descuento|discount)/i;

function toNumber(s) {
  s = s.replace(/[^\d.,-]/g, '');
  if (!s) return NaN;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');           // 1.234,56
  else if (lastDot > lastComma) s = s.replace(/,/g, '');                           // 1,234.56
  else if (lastComma >= 0) s = s.replace(',', '.');
  return parseFloat(s);
}

const AMOUNT_RE = /(?:€|eur|tl|try|\$|£|usd|gbp)?\s*(\d{1,3}(?:[.,\s]\d{3})*[.,]\d{2}|\d+[.,]\d{2})\s*(?:€|eur|tl|try|\$|£)?/gi;

export function parseReceipt(text) {
  const lines = String(text || '').split(/\n+/).map(l => l.trim()).filter(Boolean);
  const out = {};

  // Amount: prefer the last "TOTAL"-like line that is not a subtotal/tax line; else the largest amount.
  let best = null;
  lines.forEach((line, i) => {
    if (!TOTAL_WORDS.test(line) || SKIP_WORDS.test(line)) return;
    const m = [...line.matchAll(AMOUNT_RE)].map(x => toNumber(x[1])).filter(n => n > 0);
    const next = !m.length && lines[i + 1] ? [...lines[i + 1].matchAll(AMOUNT_RE)].map(x => toNumber(x[1])).filter(n => n > 0) : [];
    const vals = m.length ? m : next;
    if (vals.length) best = vals[vals.length - 1];
  });
  if (best == null) {
    const all = lines.filter(l => !SKIP_WORDS.test(l)).flatMap(l => [...l.matchAll(AMOUNT_RE)].map(x => toNumber(x[1]))).filter(n => n > 0 && n < 100000);
    if (all.length) best = Math.max(...all);
  }
  if (best != null && isFinite(best)) out.amount = Math.round(best * 100) / 100;

  // Currency
  const t = lines.join(' ');
  if (/€|\beur\b|euro/i.test(t)) out.currency = 'EUR';
  else if (/\b(tl|try)\b|₺|toplam|kdv/i.test(t)) out.currency = 'TRY';
  else if (/£|\bgbp\b/i.test(t)) out.currency = 'GBP';
  else if (/\$|\busd\b/i.test(t)) out.currency = 'USD';
  else if (/\bchf\b/i.test(t)) out.currency = 'CHF';
  else if (/\b(mad|dh|dhs)\b/i.test(t)) out.currency = 'MAD';
  else if (/\b(ron|lei)\b/i.test(t)) out.currency = 'RON';

  // Date: dd/mm/yyyy, dd-mm-yy, dd.mm.yyyy, yyyy-mm-dd
  const dm = t.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/) || t.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
  if (dm) {
    let y, m, d;
    if (dm[1].length === 4) { y = +dm[1]; m = +dm[2]; d = +dm[3]; }
    else { d = +dm[1]; m = +dm[2]; y = +dm[3]; if (y < 100) y += 2000; if (m > 12 && d <= 12) [d, m] = [m, d]; }
    if (y > 2000 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) out.date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // Receipt number
  const nm = t.match(/(?:ticket|factura|invoice|receipt|recibo|fatura|fis|n[º°o.]|no\.?|num(?:ber|ero)?)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-/]{2,20})/i);
  if (nm && /\d/.test(nm[1])) out.number = nm[1];

  // Supplier: first line that looks like a name (letters, not a date/amount/address keyword)
  const vendor = lines.slice(0, 6).find(l => /[a-z]{3,}/i.test(l) && !/\d{2}[/.-]\d{2}|tel|phone|cif|nif|vat|www|http|@|calle|street|c\/|avda|total/i.test(l) && l.replace(/[^a-z]/gi, '').length >= 4);
  if (vendor) out.vendor = vendor.replace(/[^\p{L}\p{N}&.,' -]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80);

  return out;
}
