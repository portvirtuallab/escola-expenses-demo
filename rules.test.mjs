import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
// Load exactly as the browser does: a classic script that defines the global `Rules`.
const sandbox = { crypto };
vm.createContext(sandbox);
vm.runInContext(await readFile(new URL('../js/rules.js', import.meta.url), 'utf8') + '\nthis.Rules = Rules;', sandbox);
const Rules = sandbox.Rules;
const now = () => new Date().toISOString();
const owner = { id: 'o', email: 'Owner@escolaeuropea.eu', name: 'Owner' }, boss = { id: 'b', email: 'boss@escolaeuropea.eu' }, admin = { id: 'a', email: 'tereza@escolaeuropea.eu' }, other = { id: 'x', email: 'x@escolaeuropea.eu' };
const uuid = () => crypto.randomUUID();
let c = Rules.newClaim(uuid(), owner, now(), { adminName: 'Tereza', adminEmail: admin.email });
assert.equal(c.ownerEmail, 'owner@escolaeuropea.eu');
assert.ok(Rules.canAccess(c, owner) && !Rules.canAccess(c, other));
const row = { ...Rules.newRow(uuid()), date: '2026-11-10', vendor: 'Taxi', city: 'Barcelona', amount: 38.4, rate: 1, missingReason: 'Lost' };
let input = { ...structuredClone(c), name: 'Owner', reference: 'Trip', start: '2026-11-10', end: '2026-11-12', responsible: boss.email, rows: [row] };
// cannot submit without being valid
assert.throws(() => Rules.applyAction(structuredClone(c), { ...input, responsible: '' }, owner, 'submit', '', now()), /manager/);
// stale revision
assert.throws(() => Rules.applyAction(structuredClone(c), { ...input, revision: 9 }, owner, 'save', '', now()), e => e.status === 409);
// save twice collapses history
let out = Rules.applyAction(c, input, owner, 'save', '', now()); c = out.claim;
out = Rules.applyAction(c, { ...input, revision: c.revision }, owner, 'save', '', now()); c = out.claim;
assert.equal(c.history.filter(h => h.text === 'Draft saved').length, 1);
// attachments cannot be injected by the client
const injected = structuredClone(input); injected.revision = c.revision; injected.rows[0].attachments = [{ id: 'evil' }];
c = Rules.applyAction(c, injected, owner, 'save', '', now()).claim;
assert.equal(c.rows[0].attachments.length, 0);
// other user cannot edit; manager cannot approve before submit
assert.throws(() => Rules.applyAction(structuredClone(c), { ...input, revision: c.revision }, other, 'save', '', now()), e => e.status === 403);
assert.throws(() => Rules.applyAction(structuredClone(c), { ...c }, boss, 'approve', '', now()), e => e.status === 403);
out = Rules.applyAction(c, { ...input, revision: c.revision }, owner, 'submit', '', now()); c = out.claim;
assert.equal(c.status, 'review'); assert.equal(out.notify, 'review');
assert.equal(Rules.pendingFor(c, boss), 'Approve or request changes');
assert.throws(() => Rules.applyAction(structuredClone(c), { ...c }, owner, 'approve', '', now()), e => e.status === 403);
assert.throws(() => Rules.applyAction(structuredClone(c), { ...c }, boss, 'return', '', now()), /Describe/);
c = Rules.applyAction(c, { ...c }, boss, 'return', 'Add the taxi receipt', now()).claim;
assert.equal(c.status, 'returned'); assert.ok(Rules.canEdit(c, owner));
c = Rules.applyAction(c, { ...input, revision: c.revision }, owner, 'submit', '', now()).claim;
out = Rules.applyAction(c, { ...c }, boss, 'approve', '', now()); c = out.claim; assert.equal(out.notify, 'admin');
assert.throws(() => Rules.applyAction(structuredClone(c), { ...c }, boss, 'paid', '', now()), e => e.status === 403);
out = Rules.applyAction(c, { ...c }, admin, 'paid', 'TR-1', now()); c = out.claim;
assert.equal(c.status, 'paid'); assert.equal(out.notify, 'paid');
// totals & rounding per line
const t = Rules.totals({ advance: 10, rows: [{ amount: 1.005, rate: 1, payment: 'Cash', category: 'L' }, { amount: 950, rate: 0.0257, payment: 'VISA', category: 'M' }] });
assert.equal(t.cash, 1.01); assert.equal(t.visa, 24.42); assert.equal(t.balance, -8.99);
// email
const mail = Rules.notification(c, 'paid', 'https://x.github.io/app', '');
assert.equal(mail.to, 'owner@escolaeuropea.eu'); assert.match(mail.text, /\?claim=/); assert.match(mail.html, /settled/);
// signatures
assert.ok(Rules.signatureMatches('application/pdf', [0x25, 0x50, 0x44, 0x46]));
assert.ok(!Rules.signatureMatches('image/png', [0x25, 0x50, 0x44, 0x46]));
console.log('PASS rules: permissions, transitions, revisions, attachments guard, totals, email, signatures');
