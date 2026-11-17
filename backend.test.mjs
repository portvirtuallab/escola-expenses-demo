// Runs the real Apps Script backend (Code.gs + Rules.gs) against emulated Google services.
import assert from 'node:assert/strict';
import { loadBackend, fakeToken } from './gas-emulator.mjs';

const g = await loadBackend();
const T = { me: fakeToken('orlando@escolaeuropea.eu', { name: 'Orlando' }), boss: fakeToken('eduard@escolaeuropea.eu'), adm: fakeToken('tereza@escolaeuropea.eu'), out: fakeToken('someone@gmail.com'), other: fakeToken('x@escolaeuropea.eu') };
const ok = r => { assert.equal(r.ok, true, r.error); return r.data; };
const err = (r, status) => { assert.equal(r.ok, false); if (status) assert.equal(r.status, status, r.error); return r.error; };

// identity
err(g.post({ action: 'me' }), 401);
err(g.post({ action: 'me', token: 'garbage' }), 401);
err(g.post({ action: 'me', token: T.out }), 403);
err(g.post({ action: 'me', token: fakeToken('a@escolaeuropea.eu', { clientId: 'other-app' }) }), 401);
assert.equal(ok(g.post({ action: 'me', token: T.me })).user.email, 'orlando@escolaeuropea.eu');

// create (idempotent with client id) and save
const id = crypto.randomUUID();
let c = ok(g.post({ action: 'create', token: T.me, id, defaults: { adminName: 'Tereza', adminEmail: 'tereza@escolaeuropea.eu' } }));
assert.equal(c.id, id); assert.equal(c.name, 'Orlando');
assert.equal(ok(g.post({ action: 'create', token: T.me, id })).id, id);
err(g.post({ action: 'create', token: T.other, id }), 409);
err(g.post({ action: 'get', token: T.other, id }), 403);
const row = { id: crypto.randomUUID(), date: '2026-11-12', number: 'T-1', vendor: 'Taxi', city: 'Barcelona', category: 'L', payment: 'Cash', amount: 36.3, currency: 'EUR', rate: 1, observations: '', missingReason: '', attachments: [] };
c = ok(g.post({ action: 'save', token: T.me, id, op: 'save', claim: { ...c, reference: 'Barcelona meeting', start: '2026-11-12', end: '2026-11-12', responsible: 'Eduard@EscolaEuropea.eu', rows: [row] } }));
assert.equal(c.responsible, 'eduard@escolaeuropea.eu'); assert.equal(c.revision, 2);
assert.equal(g.sheetRows('Expenses').length, 2);

// submitting without receipt or reason fails
err(g.post({ action: 'save', token: T.me, id, op: 'submit', claim: c }), 400);

// upload: signature check, then a real JPEG header
err(g.post({ action: 'upload', token: T.me, id, row: row.id, name: 'x.jpg', type: 'image/jpeg', data: Buffer.from('%PDF-1.4').toString('base64') }), 400);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
c = ok(g.post({ action: 'upload', token: T.me, id, row: row.id, name: 'ticket.jpg', type: 'image/jpeg', data: jpeg.toString('base64') }));
const att = c.rows[0].attachments[0];
assert.equal(att.name, 'ticket.jpg'); assert.ok(c.folderId);
const f = ok(g.post({ action: 'file', token: T.me, id, fileId: att.id }));
assert.deepEqual(Buffer.from(f.data, 'base64'), jpeg);
assert.match(g.sheetRows('Expenses')[1][17], /drive\.google\.com\/file/);

// submit → email to manager
c = ok(g.post({ action: 'save', token: T.me, id, op: 'submit', claim: c }));
assert.equal(c.status, 'review'); assert.equal(c.notification.state, 'sent');
assert.equal(g.mails.at(-1).to, 'eduard@escolaeuropea.eu'); assert.equal(g.mails.at(-1).replyTo, 'orlando@escolaeuropea.eu');
assert.match(g.mails.at(-1).htmlBody, /waiting for your approval/);
err(g.post({ action: 'upload', token: T.me, id, row: row.id, name: 'b.jpg', type: 'image/jpeg', data: jpeg.toString('base64') }), 403);

// manager sees it in list, returns it, claimant resubmits, manager approves
assert.equal(ok(g.post({ action: 'list', token: T.boss })).length, 1);
assert.equal(ok(g.post({ action: 'list', token: T.other })).length, 0);
err(g.post({ action: 'save', token: T.boss, id, op: 'return', claim: c }), 400);
c = ok(g.post({ action: 'save', token: T.boss, id, op: 'return', comment: 'Add the location of the meeting', claim: c }));
assert.equal(g.mails.at(-1).to, 'orlando@escolaeuropea.eu');
err(g.post({ action: 'save', token: T.me, id, op: 'submit', claim: { ...c, revision: 1 } }), 409);
c = ok(g.post({ action: 'save', token: T.me, id, op: 'submit', claim: c }));
c = ok(g.post({ action: 'save', token: T.boss, id, op: 'approve', claim: c }));
assert.equal(c.status, 'admin'); assert.equal(g.mails.at(-1).to, 'tereza@escolaeuropea.eu');
err(g.post({ action: 'save', token: T.boss, id, op: 'paid', claim: c }), 403);
c = ok(g.post({ action: 'save', token: T.adm, id, op: 'paid', comment: 'TR-55', claim: c }));
assert.equal(c.status, 'paid'); assert.equal(g.mails.length, 5);

// spreadsheet is readable for administration
const claims = g.sheetRows('Claims');
assert.equal(claims[1][4], 'Settled'); assert.equal(claims[1][5], 36.3);
assert.ok(g.sheetRows('History').length >= 7);
console.log(`PASS backend: identity & domain, create/save/upload/file, signature check, workflow, ${g.mails.length} emails, Sheets & Drive records`);
