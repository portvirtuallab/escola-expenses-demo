// Offline-first data layer. The UI talks only to this module.
// Online: calls the backend and caches the result on the device.
// Offline: reads from the cache, keeps draft edits and new receipts in an outbox,
//          and replays them in order as soon as the connection returns.
import { store } from './store.js';
import { OfflineError } from './backends.js';

const Rules = globalThis.Rules;

export class Data {
  constructor(backend) {
    this.backend = backend;
    this.offlineCapable = backend.mode !== 'demo';
    this.user = null;
    this.listeners = new Set();
    this.flushing = null;
    window.addEventListener('online', () => this.flush().catch(() => {}));
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, detail) { this.listeners.forEach(fn => fn(type, detail)); }
  key(k) { return (this.user?.email || 'anon') + ':' + k; }

  async me() {
    try {
      const me = await this.backend.call('me');
      this.user = me.user;
      if (this.offlineCapable) await store.put('kv', me, 'me');
      return me;
    } catch (e) {
      if (!e.offline || !this.offlineCapable) throw e;
      const me = await store.get('kv', 'me');
      if (!me) throw new Error('You are offline. Connect once to sign in; after that the app works offline.');
      this.user = me.user;
      return { ...me, offline: true };
    }
  }

  async cacheClaim(c) { if (this.offlineCapable) await store.put('kv', c, this.key('claim:' + c.id)); return c; }
  async cachedClaim(id) { return store.get('kv', this.key('claim:' + id)); }

  async list() {
    if (!this.offlineCapable) return this.backend.call('list');
    try {
      await this.flush();
      const list = await this.backend.call('list');
      for (const c of list) await this.cacheClaim(await this.withPending(c));
      // keep claims created offline that are not on the server yet
      const pendingIds = (await this.outbox()).filter(o => o.type === 'create').map(o => o.id);
      const extra = [];
      for (const id of pendingIds) if (!list.some(c => c.id === id)) { const c = await this.cachedClaim(id); if (c) extra.push(c); }
      const all = [...extra, ...(await Promise.all(list.map(c => this.withPending(c))))];
      await store.put('kv', all.map(c => c.id), this.key('list'));
      return all;
    } catch (e) {
      if (!e.offline) throw e;
      const ids = (await store.get('kv', this.key('list'))) || [];
      const out = [];
      for (const id of ids) { const c = await this.cachedClaim(id); if (c) out.push(c); }
      return out;
    }
  }

  async get(id) {
    if (!this.offlineCapable) return this.backend.call('get', { id });
    if (await this.hasPending(id)) return this.cachedClaim(id);
    try { return this.cacheClaim(await this.backend.call('get', { id })); }
    catch (e) { if (!e.offline) throw e; const c = await this.cachedClaim(id); if (!c) throw new Error('This claim is not available offline yet.'); return c; }
  }

  async create(defaults) {
    const id = crypto.randomUUID();
    if (!this.offlineCapable) return this.backend.call('create', { id, defaults });
    try { await this.flush(); return this.cacheClaim(await this.backend.call('create', { id, defaults })); }
    catch (e) {
      if (!e.offline) throw e;
      const c = Rules.newClaim(id, this.user, new Date().toISOString(), defaults);
      c._local = true;
      await this.cacheClaim(c);
      await this.queue({ type: 'create', id, defaults });
      await this.addToList(id);
      return c;
    }
  }

  async save(claim, op = 'save', comment = '') {
    if (!this.offlineCapable) return this.backend.call('save', { id: claim.id, claim, op, comment });
    try {
      await this.flush();
      if (await this.hasPending(claim.id)) throw new OfflineError();
      return this.cacheClaim(await this.backend.call('save', { id: claim.id, claim, op, comment }));
    } catch (e) {
      if (!e.offline) throw e;
      if (op !== 'save') throw new Error('You are offline. Your draft is saved on this device; submit it when you are back online.');
      const local = structuredClone(claim);
      local._pending = true;
      local._savedLocally = new Date().toISOString();
      await this.cacheClaim(local);
      const box = await this.outbox();
      if (!box.some(o => o.type === 'save' && o.id === claim.id)) await this.queue({ type: 'save', id: claim.id });
      return local;
    }
  }

  async upload(claimId, rowId, file) {
    if (!this.offlineCapable) return this.backend.call('upload', { id: claimId, row: rowId, file });
    try {
      await this.flush();
      if (await this.hasPending(claimId)) throw new OfflineError();
      const c = await this.backend.call('upload', { id: claimId, row: rowId, file });
      return this.cacheClaim(c);
    } catch (e) {
      if (!e.offline) throw e;
      const c = await this.cachedClaim(claimId);
      const attId = 'pending-' + crypto.randomUUID();
      await store.put('blobs', file, 'pending:' + attId);
      const row = c.rows.find(r => r.id === rowId);
      row.attachments.push({ id: attId, name: file.name, type: file.type, size: file.size, pending: true });
      c._pending = true;
      await this.cacheClaim(c);
      await this.queue({ type: 'upload', id: claimId, row: rowId, attId, name: file.name, fileType: file.type });
      return c;
    }
  }

  async removeFile(claim, att) {
    if (att.pending) {
      await store.del('blobs', 'pending:' + att.id);
      for (const o of await this.outbox()) if (o.attId === att.id) await store.del('outbox', o.seq);
      claim.rows.forEach(r => { r.attachments = r.attachments.filter(a => a.id !== att.id); });
      return this.cacheClaim(claim);
    }
    if (!this.offlineCapable) return this.backend.call('removeFile', { id: claim.id, fileId: att.id });
    return this.cacheClaim(await this.backend.call('removeFile', { id: claim.id, fileId: att.id }));
  }

  /** Returns the receipt as a Blob, from the device when possible. */
  async file(claimId, att) {
    if (att.pending) return store.get('blobs', 'pending:' + att.id);
    if (!this.offlineCapable) return this.backend.call('file', { id: claimId, fileId: att.id });
    const cached = await store.get('blobs', 'file:' + att.id);
    if (cached) return cached;
    const blob = await this.backend.call('file', { id: claimId, fileId: att.id });
    await store.put('blobs', blob, 'file:' + att.id);
    return blob;
  }

  /* ───────── outbox ───────── */

  async outbox() { return this.offlineCapable ? store.all('outbox') : []; }
  async pendingCount() { return (await this.outbox()).length; }
  async hasPending(id) { return (await this.outbox()).some(o => o.id === id); }
  async queue(item) { await store.add('outbox', { ...item, at: new Date().toISOString(), user: this.user?.email }); this.emit('pending', await this.pendingCount()); }
  async addToList(id) { const ids = (await store.get('kv', this.key('list'))) || []; if (!ids.includes(id)) { ids.unshift(id); await store.put('kv', ids, this.key('list')); } }

  /** Re-applies receipts still waiting in the outbox on top of a fresh server copy. */
  async withPending(server) {
    const box = (await this.outbox()).filter(o => o.type === 'upload' && o.id === server.id);
    if (!box.length) return server;
    const c = structuredClone(server);
    for (const o of box) {
      const row = c.rows.find(r => r.id === o.row);
      if (row && !row.attachments.some(a => a.id === o.attId)) row.attachments.push({ id: o.attId, name: o.name, type: o.fileType, pending: true });
    }
    c._pending = true;
    return c;
  }

  flush() {
    if (!this.offlineCapable) return Promise.resolve();
    if (!this.flushing) this.flushing = this._flush().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async _flush() {
    let done = 0;
    for (const item of await this.outbox()) {
      if (item.user && this.user && item.user !== this.user.email) continue;
      try {
        if (item.type === 'create') {
          await this.backend.call('create', { id: item.id, defaults: item.defaults });
        } else if (item.type === 'save') {
          const local = await this.cachedClaim(item.id);
          const clean = structuredClone(local);
          clean.rows.forEach(r => { r.attachments = r.attachments.filter(a => !a.pending); });
          const saved = await this.backend.call('save', { id: item.id, claim: clean, op: 'save' });
          await this.cacheClaim(await this.mergeLocal(saved, item.seq));
        } else if (item.type === 'upload') {
          const blob = await store.get('blobs', 'pending:' + item.attId);
          if (blob) {
            const file = new File([blob], item.name, { type: item.fileType });
            const saved = await this.backend.call('upload', { id: item.id, row: item.row, file });
            const added = saved.rows.find(r => r.id === item.row)?.attachments.slice(-1)[0];
            if (added) await store.put('blobs', blob, 'file:' + added.id);
            await store.del('blobs', 'pending:' + item.attId);
            await this.cacheClaim(await this.mergeLocal(saved, item.seq));
          }
        }
        await store.del('outbox', item.seq);
        done++;
      } catch (e) {
        if (e.offline) break;
        // Conflicts and validation errors cannot be retried: drop the item and tell the user.
        await store.del('outbox', item.seq);
        if (item.type !== 'upload') { try { await this.cacheClaim(await this.backend.call('get', { id: item.id })); } catch { /* ignore */ } }
        this.emit('sync-error', { item, message: e.message });
      }
    }
    if (done) this.emit('synced', done);
    this.emit('pending', await this.pendingCount());
  }

  async mergeLocal(server, seq) {
    const rest = (await this.outbox()).filter(o => o.seq !== seq && o.id === server.id);
    const c = await this.withPending(server);
    if (!rest.length) delete c._pending;
    return c;
  }
}
