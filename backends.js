// Two interchangeable backends with the same contract: call(action, payload) → data.
//  - RemoteBackend: Google Apps Script (Sheets + Drive + Gmail), authenticated with Google Sign-In.
//  - DemoBackend:   runs the same rules engine on this device (IndexedDB), with switchable demo users
//                   and a demo mailbox that shows the emails the real service would send.
import { store } from './store.js';

const Rules = globalThis.Rules;

export class OfflineError extends Error {
  constructor() { super('You are offline.'); this.offline = true; }
}

const toBase64 = blob => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});
const fromBase64 = (b64, type) => {
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
};

/* ───────────────────────── Google Apps Script ───────────────────────── */

export class RemoteBackend {
  constructor(config, auth) { this.url = config.apiUrl; this.auth = auth; this.mode = 'google'; }

  async call(action, payload = {}) {
    if (!navigator.onLine) throw new OfflineError();
    const token = await this.auth.token();
    const body = { ...payload, action, token };
    if (payload.file) {
      body.data = await toBase64(payload.file);
      body.name = payload.file.name; body.type = payload.file.type;
      delete body.file;
    }
    let res;
    try {
      // text/plain keeps this a "simple" request: Apps Script cannot answer CORS preflights.
      res = await fetch(this.url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow' });
    } catch {
      throw new OfflineError();
    }
    let out;
    try { out = await res.json(); } catch { throw Object.assign(new Error('The service returned an unexpected response.'), { status: 502 }); }
    if (!out.ok) {
      if (out.status === 401) this.auth.expire();
      throw Object.assign(new Error(out.error || 'Request failed.'), { status: out.status || 500 });
    }
    if (action === 'file') return fromBase64(out.data.data, out.data.type);
    return out.data;
  }
}

/* ───────────────────────── Demo (on this device) ───────────────────────── */

export const DEMO_USERS = {
  claimant: { id: 'demo-claimant', email: 'you@escolaeuropea.eu', name: 'Demo Claimant', label: 'You (claimant)' },
  manager: { id: 'demo-manager', email: 'manager@escolaeuropea.eu', name: 'Demo Manager', label: 'Manager' },
  tereza: { id: 'demo-tereza', email: 'tereza@escolaeuropea.eu', name: 'Tereza', label: 'Administration · Tereza' },
  carola: { id: 'demo-carola', email: 'carola@escolaeuropea.eu', name: 'Carola', label: 'Administration · Carola' }
};
export const DEMO_ADMINS = [{ name: 'Carola', email: DEMO_USERS.carola.email }, { name: 'Tereza', email: DEMO_USERS.tereza.email }];

export class DemoBackend {
  constructor() { this.mode = 'demo'; this.role = localStorageGet('demo-role') || 'claimant'; }
  get user() { return DEMO_USERS[this.role] || DEMO_USERS.claimant; }
  setRole(r) { this.role = r; localStorageSet('demo-role', r); }

  async claims() { return ((await store.get('kv', 'demo:claims')) || []).map(Rules.normalise); }
  async saveClaims(list) { await store.put('kv', list, 'demo:claims'); }
  async mailbox() { return (await store.get('kv', 'demo:mailbox')) || []; }

  async call(action, p = {}) {
    await new Promise(r => setTimeout(r, 120)); // feel like a network call
    const u = this.user, now = new Date().toISOString();
    const list = await this.claims();
    const find = id => {
      const c = list.find(x => x.id === id);
      if (!c) Rules.fail('Expense claim not found.', 404);
      if (!Rules.canAccess(c, u)) Rules.fail('You do not have access to this expense claim.', 403);
      return c;
    };
    const commit = async c => { const i = list.findIndex(x => x.id === c.id); if (i < 0) list.push(c); else list[i] = c; await this.saveClaims(list); return structuredClone(c); };

    switch (action) {
      case 'me': return { user: u, mail: true, demo: true, administrators: DEMO_ADMINS };
      case 'list': return structuredClone(list.filter(c => Rules.canAccess(c, u)).sort((a, b) => b.updated.localeCompare(a.updated)));
      case 'get': return structuredClone(find(p.id));
      case 'create': {
        const id = Rules.isUuid(p.id) ? p.id : crypto.randomUUID();
        const existing = list.find(x => x.id === id);
        if (existing) return structuredClone(existing);
        return commit(Rules.newClaim(id, u, now, p.defaults || {}));
      }
      case 'save': {
        const c = structuredClone(find(p.id));
        const out = Rules.applyAction(c, p.claim, u, p.op, p.comment, now);
        if (out.notify) {
          const msg = Rules.notification(c, out.notify, location.href.split('?')[0], new URL('icons/mark_white.png', location.href).href);
          const box = await this.mailbox();
          box.unshift({ ...msg, at: now, claimId: c.id });
          await store.put('kv', box.slice(0, 50), 'demo:mailbox');
          c.notification = { state: 'demo', kind: out.notify, to: msg.to, at: now };
        }
        return commit(c);
      }
      case 'upload': {
        const c = structuredClone(find(p.id));
        const file = p.file;
        Rules.checkUpload(c, u, p.row, { type: file.type, size: file.size });
        const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
        if (!Rules.signatureMatches(file.type, head)) Rules.fail('The file content does not match its type.');
        const id = crypto.randomUUID();
        await store.put('blobs', file, 'demo:file:' + id);
        Rules.addAttachment(c, p.row, { id, name: file.name, type: file.type, size: file.size }, u, now);
        return commit(c);
      }
      case 'removeFile': {
        const c = structuredClone(find(p.id));
        const removed = Rules.removeAttachment(c, u, p.fileId, now);
        await store.del('blobs', 'demo:file:' + removed.id);
        return commit(c);
      }
      case 'file': {
        const c = find(p.id);
        if (!Rules.findAttachment(c, p.fileId)) Rules.fail('Receipt not found.', 404);
        const blob = await store.get('blobs', 'demo:file:' + p.fileId);
        if (!blob) Rules.fail('File not found.', 404);
        return blob;
      }
      default: Rules.fail('Unknown action.');
    }
  }

  async reset() {
    const list = await this.claims();
    for (const c of list) for (const r of c.rows) for (const a of r.attachments) await store.del('blobs', 'demo:file:' + a.id);
    await this.saveClaims([]);
    await store.put('kv', [], 'demo:mailbox');
    await this.seed();
  }

  /** One claim waiting for the manager, so every demo role has something to do. */
  async seed() {
    const prev = this.role;
    this.setRole('claimant');
    try {
      let c = await this.call('create', { defaults: DEMO_ADMINS[1] });
      const row = (date, number, vendor, city, category, payment, amount, currency, rate, observations) =>
        ({ ...Rules.newRow(crypto.randomUUID()), date, number, vendor, city, category, payment, amount, currency, rate, observations, missingReason: 'Sample data: receipt not uploaded.' });
      c = {
        ...c, name: 'Demo Claimant', reference: 'Logitrans Istanbul 2026', start: '2026-11-10', end: '2026-11-14',
        responsible: DEMO_USERS.manager.email, adminName: 'Tereza', adminEmail: DEMO_USERS.tereza.email, advance: 150,
        rows: [
          row('2026-11-10', 'T-0412', 'Airport taxi', 'Istanbul', 'L', 'Cash', 950, 'TRY', 0.0257, 'Airport to exhibition hotel'),
          row('2026-11-11', 'R-2231', 'Hotel restaurant', 'Istanbul', 'M', 'VISA', 64.5, 'EUR', 1, 'Dinner with partner school'),
          row('2026-11-12', 'P-0098', 'Print shop', 'Istanbul', 'O', 'Cash', 1200, 'TRY', 0.0257, 'Stand brochures')
        ]
      };
      await this.call('save', { id: c.id, claim: c, op: 'submit' });
    } finally { this.setRole(prev); }
  }
}

function localStorageGet(k) { try { return localStorage.getItem('escola-expenses:' + k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem('escola-expenses:' + k, v); } catch { /* private mode */ } }
