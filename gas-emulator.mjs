// Test-only emulator of the Google Apps Script services used by apps-script/Code.gs.
// Runs the real Code.gs + Rules.gs in a Node VM so the backend can be tested end to end.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import crypto from 'node:crypto';

export async function loadBackend({ clientId = 'test-client.apps.googleusercontent.com', domains = 'escolaeuropea.eu' } = {}) {
  const props = new Map([['GOOGLE_CLIENT_ID', clientId], ['ALLOWED_DOMAINS', domains], ['APP_URL', 'https://example.github.io/escola-expenses/']]);
  const cache = new Map();
  const mails = [];
  const files = new Map(); // id → {name, type, bytes, folder, trashed, description}
  const folders = new Map(); // id → {name, parent}
  const books = new Map();
  const id = () => crypto.randomBytes(12).toString('hex');

  const blobOf = (bytes, type, name) => ({
    getBytes: () => Array.from(bytes, b => (b > 127 ? b - 256 : b)),
    getDataAsString: () => Buffer.from(bytes).toString('utf8'),
    getContentType: () => type, getName: () => name, _bytes: bytes
  });
  const fileApi = fid => {
    const f = files.get(fid);
    return {
      getId: () => fid, getName: () => f.name, getBlob: () => blobOf(f.bytes, f.type, f.name),
      setDescription: d => { f.description = d; }, setTrashed: t => { f.trashed = t; }, setContent: s => { f.bytes = Buffer.from(s); }
    };
  };
  const folderApi = fid => ({
    getId: () => fid, getUrl: () => 'https://drive/folders/' + fid,
    createFolder: name => { const n = id(); folders.set(n, { name, parent: fid }); return folderApi(n); },
    createFile: (blobOrName, content, type) => {
      const n = id();
      if (typeof blobOrName === 'string') files.set(n, { name: blobOrName, type, bytes: Buffer.from(content), folder: fid });
      else files.set(n, { name: blobOrName.getName(), type: blobOrName.getContentType(), bytes: Buffer.from(blobOrName._bytes), folder: fid });
      return fileApi(n);
    },
    getFilesByName: name => { const list = [...files.entries()].filter(([, f]) => f.folder === fid && f.name === name).map(([k]) => fileApi(k)); let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; }
  });

  function sheetApi(book, name) {
    const sh = book.sheets.get(name);
    const rangeApi = (r, c, nr = 1, nc = 1) => {
      const api = {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => sh.rows[r - 1 + i]?.[c - 1 + j] ?? '')),
        getValue: () => sh.rows[r - 1]?.[c - 1] ?? '',
        setValues: vals => { vals.forEach((row, i) => { sh.rows[r - 1 + i] ??= []; row.forEach((v, j) => { sh.rows[r - 1 + i][c - 1 + j] = v; }); }); return api; },
        clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (sh.rows[r - 1 + i]) sh.rows[r - 1 + i][c - 1 + j] = ''; trim(); return api; },
        createTextFinder: text => ({ matchEntireCell: () => ({ findNext: () => {
          for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (String(sh.rows[r - 1 + i]?.[c - 1 + j] ?? '') === text) return { getRow: () => r + i };
          return null; } }) }),
        setFontWeight: () => api, setFontColor: () => api, setBackground: () => api
      };
      return api;
    };
    const trim = () => { while (sh.rows.length && sh.rows[sh.rows.length - 1].every(v => v === '' || v == null)) sh.rows.pop(); };
    return {
      getName: () => name, setName: n => { book.sheets.set(n, sh); book.sheets.delete(name); return sheetApi(book, n); },
      getLastRow: () => sh.rows.length, getRange: rangeApi, appendRow: v => { sh.rows.push([...v]); },
      setFrozenRows: () => {}, hideColumns: () => {}, _rows: sh.rows
    };
  }
  const bookApi = bid => {
    const b = books.get(bid);
    return {
      getId: () => bid, getUrl: () => 'https://sheets/' + bid,
      getSheetByName: n => b.sheets.has(n) ? sheetApi(b, n) : null,
      insertSheet: n => { b.sheets.set(n, { rows: [] }); return sheetApi(b, n); },
      getSheets: () => [...b.sheets.keys()].map(n => sheetApi(b, n))
    };
  };

  const ctx = {
    console: { log: () => {}, warn: () => {}, error: e => console.error('[gas]', e) },
    JSON, Math, Date, String, Number, Object, Array, Error, isFinite, encodeURIComponent, Buffer,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }) },
    CacheService: { getScriptCache: () => ({ get: k => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ setMimeType: () => ({ getContent: () => s }) }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (alg, s) => [...crypto.createHash('sha256').update(s).digest()],
      base64EncodeWebSafe: bytes => Buffer.from(bytes.map(b => b & 255)).toString('base64url'),
      base64Encode: bytes => Buffer.from(bytes.map(b => b & 255)).toString('base64'),
      base64Decode: s => Array.from(Buffer.from(s, 'base64'), b => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID(),
      newBlob: (bytes, type, name) => blobOf(Buffer.from(bytes.map(b => b & 255)), type, name)
    },
    UrlFetchApp: {
      getRequest: () => ({}),
      fetch: url => {
        const token = decodeURIComponent(url.split('id_token=')[1] || '');
        let info = null;
        try { info = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); } catch { /* invalid */ }
        if (!info || token.split('.')[2] !== 'test-signature') return { getResponseCode: () => 400, getContentText: () => '{"error":"invalid_token"}' };
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ...info, exp: String(info.exp), email_verified: 'true' }) };
      }
    },
    SpreadsheetApp: {
      create: name => { const bid = id(); books.set(bid, { name, sheets: new Map([['Sheet1', { rows: [] }]]) }); return bookApi(bid); },
      openById: bid => { if (!books.has(bid)) throw new Error('No spreadsheet'); return bookApi(bid); }
    },
    DriveApp: {
      createFolder: name => { const n = id(); folders.set(n, { name }); return folderApi(n); },
      getFolderById: fid => { if (!folders.has(fid)) throw new Error('No folder'); return folderApi(fid); },
      getFileById: fid => { if (!files.has(fid)) throw new Error('No file'); return fileApi(fid); }
    },
    MailApp: { sendEmail: m => { mails.push(m); }, getRemainingDailyQuota: () => 100 },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@escolaeuropea.eu' }) }
  };
  vm.createContext(ctx);
  const dir = new URL('../apps-script/', import.meta.url);
  vm.runInContext(await readFile(new URL('Rules.gs', dir), 'utf8'), ctx, { filename: 'Rules.gs' });
  vm.runInContext(await readFile(new URL('Code.gs', dir), 'utf8'), ctx, { filename: 'Code.gs' });
  ctx.setup();

  const post = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
  const sheetRows = name => bookApi(props.get('SPREADSHEET_ID')).getSheetByName(name)._rows;
  return { ctx, post, mails, files, folders, props, sheetRows };
}

export function fakeToken(email, { clientId = 'test-client.apps.googleusercontent.com', name = '', expIn = 3600 } = {}) {
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  return enc({ alg: 'none' }) + '.' + enc({ iss: 'https://accounts.google.com', aud: clientId, sub: 'sub-' + email, email, name: name || email.split('@')[0], exp: Math.floor(Date.now() / 1000) + expIn }) + '.test-signature';
}
