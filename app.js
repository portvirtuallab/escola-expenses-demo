// Escola Europea · Expense Claims — user interface.
import { store } from './store.js';
import { RemoteBackend, DemoBackend, DEMO_USERS } from './backends.js';
import { GoogleAuth } from './auth.js';
import { Data } from './data.js';
import { captureFromCamera, pickFile, readReceipt } from './scanner.js';
import { ecbRate } from './rates.js';

const R = globalThis.Rules;
const CFG = globalThis.APP_CONFIG || {};
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = R.esc;
const money = v => R.money(v);
const fmtDate = iso => iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '';

const S = {
  backend: null, auth: null, data: null, user: null, admins: [], demo: false,
  claims: [], c: null, dirty: false, busy: false, saving: null, autosave: null,
  ocr: {}, thumbs: new Map(), installPrompt: null, emptyHtml: ''
};

/* ═════════════════════════ UI helpers ═════════════════════════ */

let toastTimer;
function toast(msg, kind = '', ms = 5000) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (kind === 'error' || kind === true ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function modal(title, html, onOpen) {
  const back = document.createElement('div');
  back.className = 'modalBack';
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2><button type="button" data-close>Close ✕</button></header><div class="modalBody">${html}</div></div>`;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); close.onClose?.(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  back.addEventListener('click', e => { if (e.target === back || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(back);
  onOpen?.(back.querySelector('.modalBody'), close);
  return close;
}

function guard(fn) {
  return async (...args) => {
    if (S.busy) return;
    S.busy = true;
    document.body.style.cursor = 'progress';
    try { return await fn(...args); }
    catch (e) { console.error(e); toast(e.message || 'Something went wrong.', 'error', 8000); }
    finally { S.busy = false; document.body.style.cursor = ''; }
  };
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const slug = s => String(s || 'claim').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '').slice(0, 50);
const editable = () => !!S.c && R.canEdit(S.c, S.user);

/* ═════════════════════════ Boot ═════════════════════════ */

async function boot() {
  S.emptyHtml = $('#main').innerHTML;
  registerServiceWorker();
  watchNetwork();
  setupInstall();
  bindGlobal();
  const params = new URLSearchParams(location.search);
  S.demo = params.has('demo') || !CFG.apiUrl || !CFG.googleClientId;

  if (S.demo) {
    S.backend = new DemoBackend();
    if (!(await S.backend.claims()).length) await S.backend.seed();
    setupDemoBar();
  } else {
    S.auth = new GoogleAuth(CFG);
    S.backend = new RemoteBackend(CFG, S.auth);
    try { await S.auth.init(); }
    catch (e) { if (!(await store.get('kv', 'me'))) return signInScreen(e.message); }
    S.auth.onNeedsButton = () => { if (!S.user) signInScreen(); else toast('Your session expired. Sign in again to keep syncing.', 'error', 0); };
    if (!S.auth.valid() && navigator.onLine) await waitForSignIn();
    $('#signOut').hidden = false;
  }

  S.data = new Data(S.backend);
  S.data.on(onDataEvent);
  await start(params);
}

function signInScreen(error) {
  document.body.classList.add('signedOut');
  $('#shell aside').hidden = true;
  $('#mobileScan').hidden = true;
  $('#identity').textContent = 'Not signed in';
  $('#main').innerHTML = `<div class="signin">
    <img src="logo_blue.png" alt="Escola Europea - Intermodal Transport">
    <div class="eyebrow">Expense claims</div><h1>Sign in to continue</h1>
    <p>Use your <b>@${esc(CFG.allowedDomain || 'escolaeuropea.eu')}</b> Google account. Your claims, receipts and approvals are kept in the Escola Europea Google Workspace.</p>
    <div id="gsi"></div>${error ? `<p class="tiny" style="color:var(--coral)">${esc(error)}</p>` : ''}
    <p class="tiny">No password is stored by this application.</p></div>`;
  if (globalThis.google?.accounts?.id) S.auth.renderButton($('#gsi'));
}

function waitForSignIn() {
  return new Promise(resolve => {
    signInScreen();
    S.auth.onChange = () => {
      S.auth.onChange = null;
      document.body.classList.remove('signedOut');
      $('#shell aside').hidden = false;
      $('#mobileScan').hidden = false;
      $('#main').innerHTML = S.emptyHtml;
      resolve();
    };
  });
}

async function start(params = new URLSearchParams()) {
  const me = await S.data.me();
  S.user = me.user;
  const fromServer = me.administrators || [];
  S.admins = (CFG.administrators || []).map(a => ({ ...a, email: a.email || fromServer.find(x => x.name === a.name)?.email || '' }));
  fromServer.forEach(a => { if (!S.admins.some(x => x.name === a.name)) S.admins.push(a); });
  $('#identity').textContent = S.user.email;
  $('#avatar').textContent = (S.user.name || S.user.email || '?')[0].toUpperCase();
  if (me.offline) toast('Offline: showing the claims saved on this device.', '', 6000);

  S.claims = await S.data.list();
  S.c = null;
  list();
  const wanted = params.get('claim') || params.get('note');
  const action = params.get('action');
  const todo = S.claims.find(c => R.pendingFor(c, S.user));
  if (wanted && S.claims.some(c => c.id === wanted)) await openClaim(wanted);
  else if (todo) await openClaim(todo.id);
  else if (S.claims.length) await openClaim(S.claims[0].id);
  else welcome();
  if (action === 'scan') scanNew();
  if (action === 'new') newClaim();
  updateNet();
  setupAlerts();
  watch(true);
}

/* ═════════════════════════ Sidebar ═════════════════════════ */

function list() {
  const items = S.claims.map(v => {
    const todo = R.pendingFor(v, S.user);
    const mine = v.ownerEmail === S.user.email;
    return `<button class="note s-${v.status}${S.c?.id === v.id ? ' active' : ''}" data-id="${v.id}" type="button">
      ${esc(v.reference || 'Untitled claim')}
      <small><i class="dot"></i>${esc(mine ? R.STATUS[v.status] : (v.name || v.ownerEmail) + ' · ' + R.STATUS[v.status])}${v._pending ? ' · ⟳ on this device' : ''}</small>
      ${todo ? `<span class="todo">● ${esc(todo)}</span>` : ''}</button>`;
  });
  $('#notes').innerHTML = items.length ? items.join('') : '<div class="emptyClaims">No claims yet.<br>Start with “New expense claim” or scan a receipt.</div>';
  const todoCount = S.claims.filter(c => R.pendingFor(c, S.user)).length;
  $('#count').innerHTML = todoCount ? `<span class="badge" title="Waiting for you">${todoCount}</span>` : (S.claims.length || '');
  $$('#notes [data-id]').forEach(b => b.onclick = guard(() => openClaim(b.dataset.id)));
  try { if (navigator.setAppBadge) todoCount ? navigator.setAppBadge(todoCount) : navigator.clearAppBadge(); } catch { /* unsupported */ }
}

function replaceInList(c) {
  const i = S.claims.findIndex(x => x.id === c.id);
  if (i < 0) S.claims.unshift(c); else S.claims[i] = c;
  S.claims.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
}

function welcome() {
  S.c = null;
  $('#main').innerHTML = `<div class="empty">
    <img src="logo_blue.png" alt="Escola Europea - Intermodal Transport" style="height:150px;margin:0 auto 26px;display:block">
    <div class="eyebrow">Administration · Expense claims</div><h1>Your expenses, organised.</h1>
    <p>Photograph a receipt and the app reads it for you. Track approval from your manager to administration, and get a PDF with every receipt attached.</p>
    <div class="actions" style="justify-content:center;margin-top:22px"><button class="primary" id="wNew" type="button">＋ New expense claim</button><button class="scanBtn" id="wScan" type="button">📷 Scan a receipt</button></div>
    <div class="howto"><div><i>01</i><b>Prepare</b><span>Scan receipts; date, amount and supplier are filled in for you.</span></div>
    <div><i>02</i><b>Approve</b><span>Your manager gets an email and approves or requests changes.</span></div>
    <div><i>03</i><b>Administration</b><span>Tereza or Carola receive the approved claim.</span></div>
    <div><i>04</i><b>Settle</b><span>Settlement is recorded and you are notified.</span></div></div></div>`;
  $('#wNew').onclick = newClaim;
  $('#wScan').onclick = scanNew;
  list();
}

/* ═════════════════════════ Claim lifecycle ═════════════════════════ */

async function openClaim(id) {
  if (S.dirty) await persist('save').catch(() => {});
  setClaim(await S.data.get(id));
  try { history.replaceState(null, '', '?claim=' + id + (S.demo && location.search.includes('demo') ? '&demo' : '')); } catch { /* sandboxed */ }
}

function setClaim(c) {
  S.c = c;
  S.dirty = false;
  replaceInList(c);
  list();
  render();
}

const newClaim = guard(async () => {
  if (S.dirty) await persist('save');
  const a = S.admins[0] || {};
  const c = await S.data.create({ adminName: a.name || '', adminEmail: a.email || '' });
  setClaim(c);
  try { history.replaceState(null, '', '?claim=' + c.id); } catch { /* sandboxed */ }
  toast(c._local ? 'New claim created on this device. It will sync when you are online.' : 'New claim created.');
  setTimeout(() => $('[data-field="reference"]')?.focus(), 50);
});

/** Fields the claimant edits, used to detect edits made while a save is in flight. */
function editableSnapshot(c) {
  const { name, reference, start, end, responsible, adminName, adminEmail, advance } = c;
  return JSON.stringify({ name, reference, start, end, responsible, adminName, adminEmail, advance, rows: c.rows.map(({ attachments, ...r }) => r) });
}

async function persist(op = 'save', comment = '') {
  if (!S.c) return null;
  clearTimeout(S.autosave);
  while (S.saving) await S.saving.catch(() => {});
  const current = S.c;
  const snap = editableSnapshot(current);
  setSaveState('saving');
  S.saving = S.data.save(structuredClone(current), op, comment);
  try {
    const res = await S.saving;
    if (op === 'save' && S.c && S.c.id === res.id) {
      Object.assign(S.c, { revision: res.revision, updated: res.updated, history: res.history, status: res.status, notification: res.notification, _pending: res._pending, _savedLocally: res._savedLocally });
      if (!res._pending) delete S.c._pending;
      S.dirty = editableSnapshot(S.c) !== snap;
      replaceInList(S.c);
      list();
      renderHistory();
      setSaveState();
      if (S.dirty) scheduleAutosave();
    } else if (S.c && S.c.id === res.id) {
      setClaim(res);
    }
    return res;
  } catch (e) {
    setSaveState('error');
    throw e;
  } finally { S.saving = null; }
}

function scheduleAutosave() {
  clearTimeout(S.autosave);
  if (!editable()) return;
  S.autosave = setTimeout(() => persist('save').catch(e => toast(e.message, 'error', 8000)), 2500);
}

function changed() {
  S.dirty = true;
  summary();
  setSaveState();
  scheduleAutosave();
}

function setSaveState(state) {
  const el = $('#saveState');
  if (!el || !S.c) return;
  el.className = 'tiny saveState';
  if (state === 'saving') el.textContent = '⟳ Saving…';
  else if (state === 'error') { el.textContent = '⚠ Not saved'; }
  else if (S.dirty) el.textContent = '● Unsaved changes';
  else if (S.c._pending) { el.textContent = '⟳ Saved on this device · will sync when online'; el.classList.add('pending'); }
  else el.textContent = '✓ Saved · ' + fmtDate(S.c.updated);
}

/* ═════════════════════════ Rendering ═════════════════════════ */

function field(k, label, type = 'text', extra = '') {
  return `<label>${label}<input data-field="${k}" type="${type}" value="${esc(S.c[k])}" ${editable() ? '' : 'disabled'} ${extra}></label>`;
}
function rowInput(r, k, label, type = 'text', extra = '') {
  return `<label>${label}<input data-row="${r.id}" data-key="${k}" type="${type}" ${type === 'number' ? 'min="0" step="any" inputmode="decimal"' : ''} value="${esc(r[k])}" ${editable() ? '' : 'disabled'} ${extra}></label>`;
}
function rowSelect(r, k, label, values) {
  return `<label>${label}<select data-row="${r.id}" data-key="${k}" ${editable() ? '' : 'disabled'}>${Object.entries(values).map(([v, t]) => `<option value="${v}" ${r[k] === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
}

function render() {
  const c = S.c;
  if (!c) return welcome();
  const stage = { draft: 0, returned: 0, review: 1, admin: 2, paid: 3 }[c.status];
  const steps = ['Prepare draft', 'Manager approval', 'Administration review', 'Settle claim'];
  const stepSub = ['Details and receipts', 'Approve or request changes', c.adminName || 'Tereza or Carola', 'Settlement record'];
  const managers = [...new Set(S.claims.map(x => x.responsible).filter(Boolean))];
  $('#main').innerHTML = `
    <div class="printOnly printHead"><img src="logo_blue.png" alt="Escola Europea - Intermodal Transport" style="height:58px"><span>Expense claim · printed ${new Date().toLocaleDateString('en-GB')}</span></div>
    <div class="top"><div><div class="eyebrow">Expense claim</div><h1>${esc(c.reference || 'New expense claim')}</h1>
      <span class="tiny">Claim ${c.id.slice(0, 8).toUpperCase()} · ${esc(c.name || c.ownerEmail)} · created ${fmtDate(c.created || c.history[0]?.at)}</span></div>
      <div class="toolbar">${editable() ? '<button id="scanHere" class="secondary scanBtn" type="button">📷 Scan receipt</button>' : ''}
      <button id="pdf" class="secondary" type="button">⤓ PDF with receipts</button><button id="csv" class="secondary" type="button">⤓ CSV</button><button id="print" class="secondary" type="button">Print</button></div></div>
    <div class="steps">${steps.map((x, i) => {
      const done = i < stage || c.status === 'paid', cur = !done && i === stage;
      return `<div class="step${done ? ' done' : cur ? ' current' : ''}"><span class="num">${done ? '&#10003;' : i + 1}</span><b>${x}</b><small>${esc(stepSub[i])}</small></div>`;
    }).join('')}</div>
    <div class="layout"><div>
      <div id="notice"></div>
      <section class="card"><div class="cardHead"><h2><span class="sectionNo">01</span>Claim details</h2><span class="pill s-${c.status}">${R.STATUS[c.status]}</span></div>
        <div class="grid">${field('name', 'Full name', 'text', 'autocomplete="name"')}${field('reference', 'Reference / trip / course', 'text', 'placeholder="E.g. Logitrans Istanbul 2026"')}${field('start', 'Period start', 'date')}${field('end', 'Period end', 'date')}</div></section>
      <section class="card"><div class="cardHead"><h2><span class="sectionNo">02</span>Expenses and receipts</h2><span class="tiny">${c.rows.length} expense${c.rows.length === 1 ? '' : 's'}</span></div>
        ${!c.rows.length ? `<p>${editable() ? 'Scan your first receipt, or add an expense by hand. You can also drop files onto an expense.' : 'No expenses.'}</p>` : ''}
        ${c.rows.map(expenseHtml).join('')}
        ${editable() ? '<div class="actions"><button id="add" type="button" style="flex:1">＋ Add expense</button><button id="scanAdd" class="scanBtn" type="button">📷 Scan receipt</button></div>' : ''}
      </section>
      <section class="card"><div class="cardHead"><h2><span class="sectionNo">03</span>Approval and administration</h2></div>
        <div class="grid">${field('responsible', 'Manager email address', 'email', 'list="managers" autocomplete="email"')}
        <label>Administration<select id="adminName" ${editable() ? '' : 'disabled'}>${[...new Set([...S.admins.map(a => a.name), c.adminName].filter(Boolean))].map(n => `<option ${c.adminName === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
        ${field('adminEmail', 'Administration email address', 'email')}${field('advance', 'Advance received (€)', 'number', 'min="0" step="0.01" inputmode="decimal"')}</div>
        <datalist id="managers">${managers.map(m => `<option value="${esc(m)}">`).join('')}</datalist>
        <p class="tiny">The manager approves or requests changes; administration records settlement. Each step sends an email automatically.</p>
        <div id="workflow"></div></section>
      <section class="card"><h2>Claim history</h2><div id="history"></div></section>
    </div><div><section class="card summary"><div class="eyebrow">Claim summary</div><div class="total" id="total"></div><div class="tiny">Total expenses in euros</div><div id="summary"></div><div class="actions" id="saveActions"></div><p class="tiny saveState" id="saveState"></p></section></div></div>`;
  bindClaim();
  summary();
  workflow();
  renderHistory();
  setSaveState();
  loadThumbs();
}

function expenseHtml(r, i) {
  const ocr = S.ocr[r.id];
  const ed = editable();
  return `<article class="expense" data-box="${r.id}">
    <div class="expenseHead"><b>Expense ${String(i + 1).padStart(2, '0')} · <span data-euro="${r.id}">${money(R.cents(r) / 100)}</span></b>${ed ? `<button class="secondary" data-remove="${r.id}" type="button" aria-label="Remove expense ${i + 1}">Remove</button>` : ''}</div>
    <div class="grid">${rowInput(r, 'date', 'Date', 'date')}${rowInput(r, 'number', 'Receipt number')}${rowInput(r, 'vendor', 'Supplier / establishment')}
      ${rowInput(r, 'city', 'Location')}${rowSelect(r, 'category', 'Code / category', Object.fromEntries(Object.entries(R.CATEGORIES).map(([k, v]) => [k, k + ' · ' + v])))}${rowSelect(r, 'payment', 'Payment method', R.PAYMENTS)}
      ${rowInput(r, 'amount', 'Original amount', 'number')}${rowSelect(r, 'currency', 'Currency', R.CURRENCIES)}
      <div class="rateRow">${rowInput(r, 'rate', 'EUR per currency unit', 'number')}${ed ? `<button type="button" data-ecb="${r.id}" title="Use the official ECB reference rate for the expense date">ECB rate</button>` : ''}</div>
      <label class="wide">Purpose / notes<textarea data-row="${r.id}" data-key="observations" ${ed ? '' : 'disabled'}>${esc(r.observations)}</textarea></label></div>
    <div class="files">${r.attachments.map(a => `<div class="file${a.pending ? ' pending' : ''}"><span class="thumb" data-thumb="${esc(a.id)}">${a.type === 'application/pdf' ? 'PDF' : ''}</span>
      <a data-view="${esc(a.id)}" title="${esc(a.name)}">${esc(a.name)}</a><span class="tiny">${a.size ? Math.ceil(a.size / 1024) + ' KB' : ''}${a.pending ? ' · waiting to sync' : ''}</span>
      ${ed ? `<button class="x" data-unattach="${esc(a.id)}" type="button" aria-label="Remove receipt">✕</button>` : ''}</div>`).join('')}</div>
    ${ed ? `<div class="attachBar"><button type="button" data-shoot="${r.id}">📷 Photo of receipt</button><button type="button" data-pick="${r.id}">⤒ Upload JPG, PNG or PDF</button><span class="tiny" style="align-self:center">or drop files here · up to 10 MB each</span></div>` : ''}
    <div data-ocr="${r.id}">${ocr ? ocrHtml(r, ocr) : ''}</div>
    <label style="margin-top:12px">If a receipt is missing, explain why<textarea data-row="${r.id}" data-key="missingReason" ${ed ? '' : 'disabled'} placeholder="E.g. lost receipt; an expense declaration will be provided.">${esc(r.missingReason)}</textarea></label>
  </article>`;
}

function ocrHtml(r, o) {
  if (o.state === 'reading') return `<div class="ocr">🔎 <b>Reading the receipt on this device…</b> <span>${esc(o.status || '')}</span><div class="progress" style="flex-basis:100%"><i style="width:${Math.round((o.progress || 0) * 100)}%"></i></div></div>`;
  if (o.state === 'error') return `<div class="ocr">⚠ ${esc(o.message)}</div>`;
  const f = o.fields || {};
  const chips = [f.date && `📅 ${f.date}`, f.amount != null && `💶 ${f.amount.toFixed(2)} ${f.currency || ''}`, f.vendor && `🏷 ${f.vendor}`, f.number && `# ${f.number}`].filter(Boolean);
  if (!chips.length) return `<div class="ocr">🔎 The receipt was attached, but no date or amount could be read. Please fill them in.</div>`;
  return `<div class="ocr">${o.applied ? '✓ <b>Filled in from the receipt.</b> Please check the values.' : '🔎 <b>Read from the receipt:</b>'} ${chips.map(c => `<span class="chip">${esc(c)}</span>`).join('')}
    ${o.applied ? '' : `<button type="button" class="primary" data-apply="${r.id}">Use these values</button>`}<button type="button" data-dismiss="${r.id}">✕</button></div>`;
}

function summary() {
  const c = S.c;
  if (!c || !$('#total')) return;
  const t = R.totals(c);
  $('#total').textContent = money(t.total);
  $('#summary').innerHTML = `<table><thead><tr><th>Category</th><th>Cash</th><th>VISA</th></tr></thead><tbody>
    ${Object.entries(R.CATEGORIES).map(([k, v]) => `<tr><td>${k} · ${v}</td><td>${money(t.byCategory[k].Cash)}</td><td>${money(t.byCategory[k].VISA)}</td></tr>`).join('')}
    <tr><th>Total</th><th>${money(t.cash)}</th><th>${money(t.visa)}</th></tr></tbody></table>
    <div class="stat"><span>Advance received</span><b>${money(t.advance)}</b></div>
    <div class="stat"><span>Cash balance − advance</span><b>${money(t.balance)}</b></div>
    <p class="tiny">Positive balance: reimburse the claimant. Negative: return funds to Escola. VISA is shown separately; administration confirms its treatment.</p>
    <div class="stat"><span>With receipt</span><b>${t.withReceipt} / ${t.lines}</b></div>`;
  $$('[data-euro]').forEach(e => { const r = c.rows.find(x => x.id === e.dataset.euro); if (r) e.textContent = money(R.cents(r) / 100); });
}

function renderHistory() {
  if (!$('#history') || !S.c) return;
  $('#history').innerHTML = S.c.history.slice().reverse().map(h => `<div class="history"><b>${esc(h.text)}</b><span>${fmtDate(h.at)} · ${esc(h.by)}</span>${h.comment ? esc(h.comment) : ''}</div>`).join('');
}

function workflow() {
  const c = S.c, u = S.user, r = R.roles(c, u);
  $('#saveActions').innerHTML = editable() ? '<button class="primary" id="save" type="button">Save now</button><button id="submit" type="button">Request approval →</button>' : '';
  const notes = {
    draft: '<b>Current step: prepare.</b> Add the details, scan or attach receipts. Your draft saves automatically, also offline.',
    returned: '<b>Current step: make changes.</b> Read the manager\'s comment in the history, update the claim and request approval again.',
    review: r.manager && !r.owner ? '<b>Your approval is needed.</b> Review the expenses and receipts, then approve or request changes.' : '<b>Current step: approval.</b> The manager has been asked to review this claim.',
    admin: r.admin ? '<b>Ready for administration.</b> The manager approved this claim. Check it and record settlement.' : '<b>Current step: administration.</b> The manager approved this claim. Administration will record settlement.',
    paid: '<b>Claim settled.</b> Expenses, receipts and history remain available here.'
  };
  $('#notice').innerHTML = `<div class="hint${R.pendingFor(c, u) ? ' warn' : ''}">${notes[c.status]}</div>`;
  let s = '';
  if (c.status === 'review' && r.manager && !r.owner) s = '<label>Review comment<textarea id="comment" placeholder="Required when requesting changes"></textarea></label><div class="actions"><button class="primary" id="approve" type="button">Approve and forward to administration</button><button id="return" type="button">Request changes</button></div>';
  if (c.status === 'admin' && r.admin) s = '<label>Settlement reference / comment<textarea id="comment" placeholder="E.g. transfer reference"></textarea></label><div class="actions"><button class="primary" id="paid" type="button">Record settlement</button></div>';
  const n = c.notification;
  if (n) {
    if (n.state === 'sent') s += `<div class="hint" style="margin-top:18px">✉ Email sent to <b>${esc(n.to)}</b> ${n.at ? '· ' + fmtDate(n.at) : ''}</div>`;
    else if (n.state === 'demo') s += `<div class="hint" style="margin-top:18px">✉ Demo: the email to <b>${esc(n.to)}</b> is in the <a href="#" id="openMailbox">demo mailbox</a>. With the Google service it is sent automatically.</div>`;
    else if (n.state === 'manual' || n.state === 'failed') s += `<div class="hint warn" style="margin-top:18px"><b>Email not sent automatically.</b> ${n.state === 'failed' ? 'Delivery failed. ' : ''}<a id="mailLink">Prepare the email →</a></div>`;
  }
  $('#workflow').innerHTML = s;
  if ($('#mailLink')) $('#mailLink').href = 'mailto:' + encodeURIComponent(n.to) + '?subject=' + encodeURIComponent(n.subject || '') + '&body=' + encodeURIComponent(n.body || '');
  if ($('#openMailbox')) $('#openMailbox').onclick = e => { e.preventDefault(); openMailbox(); };
  ['save', 'submit', 'approve', 'return', 'paid'].forEach(a => { const b = $('#' + a); if (b) b.onclick = guard(() => act(a)); });
}

async function act(action) {
  const confirmText = {
    submit: 'Submit this claim for approval? Editing is locked while your manager reviews it, and your manager will receive an email.',
    approve: 'Approve this claim and forward it to administration?',
    return: 'Return this claim to the claimant with your comment?',
    paid: 'Record this claim as settled? The claimant will be notified.'
  }[action];
  const comment = $('#comment')?.value || '';
  if (action === 'return' && !comment.trim()) { $('#comment').focus(); return toast('Write a comment describing the changes required.', 'error'); }
  if (confirmText && !confirm(confirmText)) return;
  if (action === 'submit') {
    try { const probe = structuredClone(S.c); R.validateForSubmit(probe); } catch (e) { return toast(e.message, 'error', 8000); }
    if (S.c.rows.some(r => r.attachments.some(a => a.pending))) return toast('Some receipts are still waiting to sync. Submit when you are back online.', 'error', 8000);
  }
  const res = await persist(action === 'save' ? 'save' : action, comment);
  const n = res?.notification;
  if (action === 'save') toast(res?._pending ? 'Saved on this device. It will sync when you are online.' : 'Saved.');
  else toast(n?.state === 'sent' ? `Done. Email sent to ${n.to}.` : n?.state === 'demo' ? 'Done. The notification email is in the demo mailbox.' : 'Status updated.', '', 6000);
}

/* ═════════════════════════ Bindings ═════════════════════════ */

function bindClaim() {
  const c = S.c;
  $$('[data-field]').forEach(e => e.oninput = () => {
    c[e.dataset.field] = e.type === 'number' ? Number(e.value) : e.value;
    if (e.dataset.field === 'reference') { const h = $('.top h1'); if (h) h.textContent = e.value || 'New expense claim'; }
    changed();
  });
  if ($('#adminName')) $('#adminName').onchange = e => {
    c.adminName = e.target.value;
    const a = S.admins.find(x => x.name === c.adminName);
    if (a?.email) { c.adminEmail = a.email; $('[data-field="adminEmail"]').value = a.email; }
    changed();
  };
  $$('[data-row]').forEach(e => e.oninput = () => {
    const r = c.rows.find(x => x.id === e.dataset.row);
    r[e.dataset.key] = e.type === 'number' ? Number(e.value) : e.value;
    if (e.dataset.key === 'currency') {
      r.rate = r.currency === 'EUR' ? 1 : 0;
      $(`[data-row="${r.id}"][data-key="rate"]`).value = r.rate;
      if (r.currency !== 'EUR' && r.currency !== 'OTHER') fillRate(r, true);
    }
    changed();
  });
  $$('[data-remove]').forEach(e => e.onclick = () => {
    if (!confirm('Remove this expense and its receipts from the claim?')) return;
    c.rows = c.rows.filter(r => r.id !== e.dataset.remove);
    changed(); render();
  });
  if ($('#add')) $('#add').onclick = () => { c.rows.push(newRowFor(c)); changed(); render(); $$('.expense').pop()?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  if ($('#scanAdd')) $('#scanAdd').onclick = scanNew;
  if ($('#scanHere')) $('#scanHere').onclick = scanNew;
  $$('[data-shoot]').forEach(e => e.onclick = guard(async () => { const f = await captureFromCamera(); if (f) await attach(e.dataset.shoot, f); }));
  $$('[data-pick]').forEach(e => e.onclick = guard(async () => { const f = await pickFile(false); if (f) await attach(e.dataset.pick, f); }));
  $$('[data-ecb]').forEach(e => e.onclick = guard(() => fillRate(c.rows.find(r => r.id === e.dataset.ecb))));
  $$('[data-view]').forEach(e => e.onclick = guard(() => viewFile(findAtt(e.dataset.view))));
  $$('[data-unattach]').forEach(e => e.onclick = guard(async () => {
    const a = findAtt(e.dataset.unattach);
    if (!confirm(`Remove the receipt "${a.name}"?`)) return;
    if (S.dirty) await persist('save');
    mergeAttachments(await S.data.removeFile(S.c, a));
    render(); toast('Receipt removed.');
  }));
  $$('[data-apply]').forEach(e => e.onclick = () => applyOcr(e.dataset.apply));
  $$('[data-dismiss]').forEach(e => e.onclick = () => { delete S.ocr[e.dataset.dismiss]; $(`[data-ocr="${e.dataset.dismiss}"]`).innerHTML = ''; });
  if (editable()) $$('[data-box]').forEach(box => {
    box.addEventListener('dragover', e => { e.preventDefault(); box.style.outline = '2px dashed var(--cyan)'; });
    box.addEventListener('dragleave', () => { box.style.outline = ''; });
    box.addEventListener('drop', guard(async e => {
      e.preventDefault(); box.style.outline = '';
      for (const f of [...e.dataTransfer.files]) await attach(box.dataset.box, f);
    }));
  });
  $('#print').onclick = () => window.print();
  $('#csv').onclick = exportCsv;
  $('#pdf').onclick = guard(exportPdf);
}

/** New expense line: same location as the previous one, dated at the start of the period. */
function newRowFor(c) {
  const r = R.newRow(crypto.randomUUID(), c.start);
  const prev = c.rows[c.rows.length - 1];
  if (prev?.city) r.city = prev.city;
  return r;
}

const findAtt = id => S.c.rows.flatMap(r => r.attachments).find(a => a.id === id);

function mergeAttachments(res) {
  S.c.revision = res.revision; S.c.updated = res.updated;
  if (res._pending) S.c._pending = true; else delete S.c._pending;
  res.rows.forEach(r => { const mine = S.c.rows.find(x => x.id === r.id); if (mine) mine.attachments = r.attachments; });
  replaceInList(S.c);
}

function bindGlobal() {
  $('#new').onclick = newClaim;
  $('#scanNew').onclick = scanNew;
  $('#mobileScan').onclick = scanNew;
  $('#refresh').onclick = guard(async () => { await S.data.flush(); await refresh(); toast('Up to date.'); });
  $('#signOut').onclick = () => { if (S.dirty) persist('save').catch(() => {}); S.auth?.signOut(); location.reload(); };
  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (editable()) guard(() => act('save'))(); }
  });
  window.addEventListener('beforeunload', e => { if (S.dirty) { persist('save').catch(() => {}); e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') watch(); else if (S.dirty) persist('save').catch(() => {}); });
}

async function refresh() {
  S.claims = await S.data.list();
  if (S.c && !S.dirty) {
    const fresh = S.claims.find(x => x.id === S.c.id);
    if (fresh && (fresh.revision !== S.c.revision || fresh.status !== S.c.status)) setClaim(await S.data.get(S.c.id));
  }
  list();
}

/* ═════════════════════════ Receipts, scanner, rates ═════════════════════════ */

const scanNew = guard(async () => {
  const file = await captureFromCamera();
  if (!file) return;
  if (!S.c || !editable()) {
    if (S.dirty) await persist('save');
    const a = S.admins[0] || {};
    setClaim(await S.data.create({ adminName: a.name || '', adminEmail: a.email || '' }));
  }
  const row = newRowFor(S.c);
  S.c.rows.push(row);
  S.dirty = true;
  render();
  $(`[data-box="${row.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await attach(row.id, file, { autoApply: true });
});

async function attach(rowId, file, { autoApply = false } = {}) {
  if (!R.FILE_TYPES.includes(file.type)) return toast('Use a JPG, PNG or PDF file.', 'error');
  if (file.size > R.MAX_FILE_BYTES) return toast('Each receipt must be smaller than 10 MB.', 'error');
  if (S.dirty || S.c._local) await persist('save');
  toast('Uploading receipt…', '', 0);
  mergeAttachments(await S.data.upload(S.c.id, rowId, file));
  const row = S.c.rows.find(r => r.id === rowId);
  if (row?.missingReason?.startsWith('Sample data')) row.missingReason = '';
  render();
  toast(S.c._pending ? 'Receipt kept on this device. It will upload when you are online.' : 'Receipt attached.');
  if (file.type.startsWith('image/')) runOcr(rowId, file, autoApply || isBlank(row));
}

const isBlank = r => r && !r.vendor && !(Number(r.amount) > 0);

async function runOcr(rowId, file, autoApply) {
  const box = () => $(`[data-ocr="${rowId}"]`);
  const row = () => S.c?.rows.find(r => r.id === rowId);
  S.ocr[rowId] = { state: 'reading', progress: 0, status: 'Preparing the reader' };
  if (box() && row()) box().innerHTML = ocrHtml(row(), S.ocr[rowId]);
  try {
    const result = await readReceipt(file, m => {
      const o = S.ocr[rowId]; if (!o || o.state !== 'reading') return;
      o.progress = m.progress || 0;
      o.status = { 'loading tesseract core': 'Loading the reader (first time only)', 'loading language traineddata': 'Loading language data (first time only)', 'initializing api': 'Starting', 'recognizing text': 'Recognising text' }[m.status] || m.status;
      const bar = box()?.querySelector('.progress i'); if (bar) bar.style.width = Math.round(o.progress * 100) + '%';
      const st = box()?.querySelector('.ocr span'); if (st) st.textContent = o.status;
    });
    S.ocr[rowId] = { state: 'done', fields: result.fields, confidence: result.confidence };
    if (autoApply && Object.keys(result.fields).length) await applyOcr(rowId);
    else if (box() && row()) box().innerHTML = ocrHtml(row(), S.ocr[rowId]), bindOcrButtons(rowId);
  } catch (e) {
    console.error(e);
    S.ocr[rowId] = { state: 'error', message: navigator.onLine ? 'The receipt could not be read automatically. Please fill in the values.' : 'The receipt is attached. Automatic reading needs one connection to download the reader; please fill in the values for now.' };
    if (box() && row()) box().innerHTML = ocrHtml(row(), S.ocr[rowId]);
  }
}

function bindOcrButtons(rowId) {
  const b = $(`[data-ocr="${rowId}"]`);
  b?.querySelector('[data-apply]')?.addEventListener('click', () => applyOcr(rowId));
  b?.querySelector('[data-dismiss]')?.addEventListener('click', () => { delete S.ocr[rowId]; b.innerHTML = ''; });
}

async function applyOcr(rowId) {
  const o = S.ocr[rowId], r = S.c?.rows.find(x => x.id === rowId);
  if (!o || !r || !editable()) return;
  const f = o.fields;
  if (f.date) r.date = f.date;
  if (f.amount != null) r.amount = f.amount;
  if (f.vendor) r.vendor = f.vendor;
  if (f.number) r.number = f.number;
  if (f.currency && R.CURRENCIES[f.currency]) { r.currency = f.currency; r.rate = f.currency === 'EUR' ? 1 : r.rate; }
  if (r.date && !S.c.start) S.c.start = r.date;
  if (r.date && !S.c.end) S.c.end = r.date;
  if (r.date && S.c.start && r.date < S.c.start) S.c.start = r.date;
  if (r.date && S.c.end && r.date > S.c.end) S.c.end = r.date;
  o.applied = true;
  changed();
  render();
  if (r.currency !== 'EUR' && r.currency !== 'OTHER') await fillRate(r, true);
}

async function fillRate(r, quiet = false) {
  if (!r) return;
  if (r.currency === 'EUR') { r.rate = 1; changed(); render(); return; }
  try {
    const x = await ecbRate(r.currency, r.date);
    r.rate = x.rate;
    const input = $(`[data-row="${r.id}"][data-key="rate"]`);
    if (input) input.value = x.rate;
    changed();
    toast(`ECB reference rate ${x.date}: 1 ${r.currency} = €${x.rate}`);
  } catch (e) { if (!quiet) toast(e.message, 'error'); }
}

async function loadThumbs() {
  for (const el of $$('[data-thumb]')) {
    const a = findAtt(el.dataset.thumb);
    if (!a || !a.type?.startsWith('image/')) continue;
    if (S.thumbs.has(a.id)) { el.style.backgroundImage = `url(${S.thumbs.get(a.id)})`; continue; }
    S.data.file(S.c.id, a).then(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      S.thumbs.set(a.id, url);
      el.style.backgroundImage = `url(${url})`;
    }).catch(() => {});
  }
}

async function viewFile(a) {
  if (!a) return;
  toast('Opening receipt…', '', 0);
  const blob = await S.data.file(S.c.id, a);
  $('#toast').hidden = true;
  if (!blob) throw new Error('This receipt is not available on this device.');
  const url = URL.createObjectURL(blob);
  const body = a.type === 'application/pdf'
    ? `<iframe src="${url}" title="${esc(a.name)}"></iframe>`
    : `<img class="preview" src="${url}" alt="${esc(a.name)}">`;
  const close = modal(a.name, body + `<div class="actions"><a href="${url}" download="${esc(a.name)}">⤓ Download</a><a href="${url}" target="_blank" rel="noopener">Open in a new tab ↗</a></div>`);
  close.onClose = () => setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ═════════════════════════ Exports ═════════════════════════ */

function exportCsv() {
  const c = S.c;
  const data = [['Claim', 'Claimant', 'Date', 'Receipt number', 'Supplier / establishment', 'Location', 'Code', 'Category', 'Payment method', 'Original amount', 'Currency', 'EUR per unit', 'Amount EUR', 'Notes', 'Missing receipt reason', 'Receipts'],
    ...c.rows.map(r => [c.reference, c.name, r.date, r.number, r.vendor, r.city, r.category, R.CATEGORIES[r.category], r.payment, r.amount, r.currency, r.rate, R.cents(r) / 100, r.observations, r.missingReason, r.attachments.map(a => a.name).join(' | ')])];
  const csv = '﻿' + data.map(row => row.map(v => '"' + String(v ?? '').replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""') + '"').join(';')).join('\r\n');
  download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `Expense_claim_${slug(c.reference)}.csv`);
}

async function exportPdf() {
  if (S.dirty) await persist('save');
  toast('Building the PDF on this device…', '', 0);
  const { buildClaimPdf } = await import('./pdf.js');
  const blob = await buildClaimPdf(S.c, a => S.data.file(S.c.id, a), (i, n) => toast(`Adding receipts to the PDF… ${i} of ${n}`, '', 0));
  download(blob, `Expense_claim_${slug(S.c.reference)}.pdf`);
  toast('PDF ready: summary, history and every receipt in one file.');
}

/* ═════════════════════════ Network, sync, alerts, install ═════════════════════════ */

let pendingCount = 0, syncing = false;
function watchNetwork() {
  window.addEventListener('online', () => { updateNet(); toast('Back online. Syncing…'); });
  window.addEventListener('offline', () => { updateNet(); toast('You are offline. Keep working: drafts and receipts are saved on this device.', '', 7000); });
}
function updateNet() {
  const el = $('#net');
  el.classList.toggle('off', !navigator.onLine);
  el.classList.toggle('sync', syncing);
  $('#netText').textContent = S.demo ? 'Demo · on this device' : !navigator.onLine ? (pendingCount ? `Offline · ${pendingCount} to sync` : 'Offline') : pendingCount ? `${pendingCount} to sync` : 'Online · synced';
}

async function onDataEvent(type, detail) {
  if (type === 'pending') { pendingCount = detail; updateNet(); }
  if (type === 'synced') { toast(`Synced ${detail} change${detail === 1 ? '' : 's'} made offline.`); if (!S.dirty) await refresh().catch(() => {}); }
  if (type === 'sync-error') toast(`A change made offline could not be synced: ${detail.message}`, 'error', 10000);
}

let watchTimer = null;
async function watch(first = false) {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => watch(), 90000);
  if (first || !S.user || document.visibilityState !== 'visible' && !first) return;
  try {
    const before = new Map(S.claims.map(c => [c.id, c.status]));
    await refresh();
    for (const c of S.claims) {
      const todo = R.pendingFor(c, S.user);
      if (todo && before.get(c.id) !== c.status) notify(`${c.reference || 'Expense claim'}: ${todo}`, `${c.name || c.ownerEmail} · ${money(R.totals(c).total)}`, c.id);
      else if (c.ownerEmail === S.user.email && before.has(c.id) && before.get(c.id) !== c.status && c.status === 'paid') notify(`${c.reference}: settled`, 'Administration recorded the settlement.', c.id);
    }
  } catch { /* offline or signed out: try again later */ }
}

function notify(title, body, id) {
  toast(title, '', 7000);
  if (document.visibilityState === 'visible' || !('Notification' in window) || Notification.permission !== 'granted') return;
  const reg = navigator.serviceWorker?.controller ? navigator.serviceWorker.ready : null;
  const opts = { body, icon: 'icon-192.png', badge: 'icon-192.png', tag: id, data: { id } };
  if (reg) reg.then(r => r.showNotification(title, opts)); else new Notification(title, opts);
}

function setupAlerts() {
  const b = $('#alerts');
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  b.hidden = false;
  b.onclick = async () => { const p = await Notification.requestPermission(); b.hidden = true; if (p === 'granted') toast('Alerts on: you will be told when a claim needs you.'); };
}

function setupInstall() {
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installPrompt = e; $('#install').hidden = false; });
  window.addEventListener('appinstalled', () => { $('#install').hidden = true; toast('Installed. Find "Expenses" with your apps.'); });
  $('#install').onclick = async () => { if (!S.installPrompt) return; S.installPrompt.prompt(); await S.installPrompt.userChoice; S.installPrompt = null; $('#install').hidden = true; };
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker not registered', e));
  // Once online, fetch the receipt reader and PDF builder in the background for offline use.
  navigator.serviceWorker.ready.then(reg => {
    if (!navigator.onLine || navigator.connection?.saveData) return;
    const go = () => reg.active?.postMessage('warm-offline');
    'requestIdleCallback' in window ? requestIdleCallback(go, { timeout: 8000 }) : setTimeout(go, 4000);
  });
}

/* ═════════════════════════ Demo ═════════════════════════ */

function setupDemoBar() {
  $('#demoBar').hidden = false;
  const sel = $('#demoRole');
  sel.innerHTML = Object.entries(DEMO_USERS).map(([k, u]) => `<option value="${k}" ${k === S.backend.role ? 'selected' : ''}>${esc(u.label)} · ${esc(u.email)}</option>`).join('');
  sel.onchange = guard(async () => {
    if (S.dirty) await persist('save');
    S.backend.setRole(sel.value);
    S.thumbs.clear(); S.ocr = {};
    await start();
    toast(`You are now ${DEMO_USERS[sel.value].label}.`);
  });
  $('#demoMail').onclick = openMailbox;
  $('#demoReset').onclick = guard(async () => {
    if (!confirm('Delete all demo claims and emails and start again?')) return;
    await S.backend.reset(); S.thumbs.clear(); S.ocr = {};
    await start(); updateMailCount(); toast('Demo reset.');
  });
  updateMailCount();
  setInterval(updateMailCount, 3000);
}

async function updateMailCount() {
  if (!S.demo) return;
  const n = (await S.backend.mailbox()).length;
  $('#mailCount').hidden = !n; $('#mailCount').textContent = n;
}

async function openMailbox() {
  const box = await S.backend.mailbox();
  const html = box.length ? box.map((m, i) => `<button type="button" class="mail" data-mail="${i}"><b>${esc(m.subject)}</b><span>To ${esc(m.to)} · ${fmtDate(m.at)}</span></button>`).join('') +
    '<div id="mailView" style="margin-top:12px"></div>' : '<p>No emails yet. Submit, approve, return or settle a claim and the email appears here.</p>';
  modal('Demo mailbox · emails the Google service would send', html, body => {
    body.querySelectorAll('[data-mail]').forEach(b => b.onclick = () => {
      const m = box[b.dataset.mail];
      const v = body.querySelector('#mailView');
      v.innerHTML = '<iframe title="Email preview"></iframe>';
      v.querySelector('iframe').srcdoc = m.html;
      v.scrollIntoView({ behavior: 'smooth' });
    });
    body.querySelector('[data-mail]')?.click();
  });
}

boot().catch(e => { console.error(e); toast(e.message || 'The application could not start.', 'error', 0); });
