// Tiny promise wrapper around IndexedDB: the app's on-device storage.
// Stores: kv (cached claims, settings), outbox (changes waiting to sync), blobs (receipt files).
const DB_NAME = 'escola-expenses';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(storeName, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    Promise.resolve(fn(store)).then(r => { result = r; });
    tx.oncomplete = () => resolve(result && typeof result === 'object' && 'result' in result && result instanceof IDBRequest ? result.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export const store = {
  async get(name, key) { const db = await open(); return req(db.transaction(name).objectStore(name).get(key)); },
  async put(name, value, key) { return run(name, 'readwrite', s => { key === undefined ? s.put(value) : s.put(value, key); }); },
  async add(name, value) { const db = await open(); return req(db.transaction(name, 'readwrite').objectStore(name).add(value)); },
  async del(name, key) { return run(name, 'readwrite', s => { s.delete(key); }); },
  async all(name) { const db = await open(); return req(db.transaction(name).objectStore(name).getAll()); },
  async keys(name) { const db = await open(); return req(db.transaction(name).objectStore(name).getAllKeys()); },
  async clear(name) { return run(name, 'readwrite', s => { s.clear(); }); }
};
