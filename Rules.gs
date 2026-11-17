// GENERATED from js/rules.js by tools/build-gas.mjs — edit js/rules.js, not this file.
/*
 * Escola Europea · Expense Claims — shared rules engine.
 *
 * This single file is used unchanged by:
 *   - the browser (loaded as a classic script → window.Rules), for the demo
 *     backend, offline drafts and instant feedback;
 *   - Google Apps Script (copied as Rules.gs by tools/build-gas.mjs), where it
 *     is the authority for validation, permissions and workflow transitions.
 *
 * Keep it dependency-free ES2019 so both runtimes can execute it.
 */
var Rules = (function () {
  'use strict';

  var STATUS = {
    draft: 'Open draft',
    review: 'Awaiting approval',
    returned: 'Changes requested',
    admin: 'With administration',
    paid: 'Settled'
  };
  var CATEGORIES = { L: 'Travel', M: 'Meals', O: 'Other' };
  var PAYMENTS = { Cash: 'Cash', VISA: 'VISA' };
  var CURRENCIES = {
    EUR: 'EUR · Euro', TRY: 'TRY · Turkish lira', USD: 'USD · US dollar', GBP: 'GBP · Pound sterling',
    CHF: 'CHF · Swiss franc', MAD: 'MAD · Moroccan dirham', RON: 'RON · Romanian leu', PLN: 'PLN · Polish zloty',
    DKK: 'DKK · Danish krone', SEK: 'SEK · Swedish krona', NOK: 'NOK · Norwegian krone', OTHER: 'Other currency'
  };
  var FILE_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
  var MAX_FILE_BYTES = 10 * 1024 * 1024;
  var MAX_ROWS = 150;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  function RuleError(message, status) {
    var e = new Error(message);
    e.status = status || 400;
    e.isRuleError = true;
    return e;
  }
  function fail(message, status) { throw RuleError(message, status); }

  function email(x) { return String(x || '').trim().toLowerCase(); }
  function str(x, max) { return String(x == null ? '' : x).slice(0, max || 200); }
  function num(x) { var n = Number(x); return isFinite(n) ? n : 0; }
  function isUuid(x) { return UUID_RE.test(String(x || '')); }
  function isDate(x) { return /^\d{4}-\d{2}-\d{2}$/.test(String(x || '')); }

  /** Amount in euro cents for one expense line (rounded per line before summing). */
  function cents(row) { return Math.round(Number((num(row.amount) * num(row.rate) * 100).toPrecision(12))) || 0; }

  function totals(claim) {
    var rows = claim.rows || [];
    var by = {}, cash = 0, visa = 0;
    Object.keys(CATEGORIES).forEach(function (c) { by[c] = { Cash: 0, VISA: 0 }; });
    rows.forEach(function (r) {
      var c = cents(r);
      if (by[r.category]) by[r.category][r.payment === 'VISA' ? 'VISA' : 'Cash'] += c;
      if (r.payment === 'VISA') visa += c; else cash += c;
    });
    var advance = Math.round(num(claim.advance) * 100);
    return {
      total: (cash + visa) / 100,
      cash: cash / 100,
      visa: visa / 100,
      advance: advance / 100,
      balance: (cash - advance) / 100,
      byCategory: Object.keys(by).reduce(function (o, k) { o[k] = { Cash: by[k].Cash / 100, VISA: by[k].VISA / 100 }; return o; }, {}),
      withReceipt: rows.filter(function (r) { return (r.attachments || []).length; }).length,
      lines: rows.length
    };
  }

  function newClaim(id, user, now, defaults) {
    defaults = defaults || {};
    return {
      id: id,
      owner: user.id,
      ownerEmail: email(user.email),
      name: str(user.name || '', 120),
      reference: '',
      start: '',
      end: '',
      responsible: '',
      adminName: defaults.adminName || '',
      adminEmail: email(defaults.adminEmail || ''),
      advance: 0,
      rows: [],
      status: 'draft',
      revision: 1,
      created: now,
      updated: now,
      history: [{ at: now, by: email(user.email), text: 'Draft created' }]
    };
  }

  function newRow(id, start) {
    return {
      id: id, date: start || '', number: '', vendor: '', city: '', category: 'L', payment: 'Cash',
      amount: 0, currency: 'EUR', rate: 1, observations: '', missingReason: '', attachments: []
    };
  }

  /** Upgrades records written by older versions. */
  function normalise(claim) {
    (claim.rows || []).forEach(function (r) {
      if (r.payment === 'Efectivo') r.payment = 'Cash';
      if (!r.attachments) r.attachments = [];
    });
    if (!claim.history) claim.history = [];
    return claim;
  }

  function editable(claim) { return claim.status === 'draft' || claim.status === 'returned'; }

  function roles(claim, user) {
    var e = email(user.email);
    return {
      owner: claim.owner === user.id || (!!claim.ownerEmail && claim.ownerEmail === e && !claim.owner),
      manager: !!claim.responsible && email(claim.responsible) === e,
      admin: !!claim.adminEmail && email(claim.adminEmail) === e
    };
  }
  function canAccess(claim, user) {
    var r = roles(claim, user);
    return r.owner || r.manager || r.admin;
  }
  function canEdit(claim, user) { return roles(claim, user).owner && editable(claim); }

  /** What the signed-in user is expected to do next with this claim (for badges / alerts). */
  function pendingFor(claim, user) {
    var r = roles(claim, user);
    if (r.owner && claim.status === 'returned') return 'Make the requested changes';
    if (r.manager && !r.owner && claim.status === 'review') return 'Approve or request changes';
    if (r.admin && claim.status === 'admin') return 'Record settlement';
    return '';
  }

  /** Copies the claimant-editable fields from untrusted input onto a stored claim. */
  function applyClaimantFields(stored, input) {
    stored.name = str(input.name, 120);
    stored.reference = str(input.reference, 160);
    stored.start = isDate(input.start) ? input.start : '';
    stored.end = isDate(input.end) ? input.end : '';
    stored.responsible = email(input.responsible).slice(0, 160);
    stored.adminName = str(input.adminName, 60);
    stored.adminEmail = email(input.adminEmail).slice(0, 160);
    stored.advance = Math.max(0, num(input.advance));
    if (!Array.isArray(input.rows)) fail('The expense list is missing.');
    if (input.rows.length > MAX_ROWS) fail('A claim can contain up to ' + MAX_ROWS + ' expenses.');
    var existing = {};
    (stored.rows || []).forEach(function (r) { existing[r.id] = r; });
    stored.rows = input.rows.map(function (r) {
      var id = isUuid(r.id) ? r.id : null;
      if (!id) fail('Each expense needs a valid identifier.');
      return {
        id: id,
        date: isDate(r.date) ? r.date : '',
        number: str(r.number, 100),
        vendor: str(r.vendor, 200),
        city: str(r.city, 200),
        category: CATEGORIES[r.category] ? r.category : 'O',
        payment: PAYMENTS[r.payment] ? r.payment : 'Cash',
        currency: CURRENCIES[r.currency] ? r.currency : 'OTHER',
        amount: Math.round(num(r.amount) * 100) / 100,
        rate: Math.round(num(r.rate) * 1e6) / 1e6,
        observations: str(r.observations, 2000),
        missingReason: str(r.missingReason, 2000),
        // Attachments are server-managed: keep what is stored, never trust the client list.
        attachments: existing[id] ? existing[id].attachments || [] : []
      };
    });
    return stored;
  }

  function validateForSubmit(c) {
    if (!c.name.trim() || !c.reference.trim() || !c.start || !c.end) fail('Enter your name, reference and reporting period.');
    if (c.start > c.end) fail('The end date must be on or after the start date.');
    if (!EMAIL_RE.test(c.responsible)) fail('Enter the manager\'s email address.');
    if (!EMAIL_RE.test(c.adminEmail)) fail('Choose administration and enter its email address.');
    if (c.responsible === c.ownerEmail) fail('The manager must be a different person from the claimant.');
    if (!c.rows.length) fail('Add at least one expense.');
    c.rows.forEach(function (r, i) {
      var n = 'Expense ' + (i + 1) + ': ';
      if (!r.date || r.date < c.start || r.date > c.end) fail(n + 'the date must be inside the reporting period.');
      if (!r.vendor.trim() || !r.city.trim()) fail(n + 'enter the supplier and the location.');
      if (!(r.amount > 0)) fail(n + 'enter an amount greater than zero.');
      if (!(r.rate > 0)) fail(n + 'enter the exchange rate (EUR per currency unit).');
      if (!r.attachments.length && !r.missingReason.trim()) fail(n + 'attach a receipt or explain why it is missing.');
    });
  }

  /**
   * Applies a workflow action. Returns { claim, event, notify } where notify is
   * the kind of email to send ('review' | 'admin' | 'returned' | 'paid' | null).
   * `stored` is mutated and returned as `claim`.
   */
  function applyAction(stored, input, user, action, comment, now) {
    action = action || 'save';
    comment = str(comment, 2000).trim();
    if (!input || input.revision !== stored.revision) {
      fail('Someone else has updated this claim. Refresh to see the latest version.', 409);
    }
    var r = roles(stored, user), event, notify = null;
    if (action === 'save' || action === 'submit') {
      if (!r.owner || !editable(stored)) fail('Only the claimant can edit a draft.', 403);
      applyClaimantFields(stored, input);
      event = 'Draft saved';
      if (action === 'submit') {
        validateForSubmit(stored);
        stored.status = 'review';
        event = 'Submitted for manager approval';
        notify = 'review';
      }
    } else if (action === 'approve' || action === 'return') {
      if (stored.status !== 'review' || !r.manager || r.owner) fail('Only the designated manager can review this claim.', 403);
      if (action === 'return' && !comment) fail('Describe the changes required.');
      stored.status = action === 'approve' ? 'admin' : 'returned';
      event = action === 'approve' ? 'Approved by the manager and forwarded to administration' : 'Returned for changes';
      notify = action === 'approve' ? 'admin' : 'returned';
    } else if (action === 'paid') {
      if (stored.status !== 'admin' || !r.admin) fail('Only the designated administrator can record settlement.', 403);
      stored.status = 'paid';
      event = 'Settlement recorded';
      notify = 'paid';
    } else {
      fail('Action not available.');
    }
    stored.revision += 1;
    stored.updated = now;
    // Consecutive plain saves collapse into one history line to keep the log readable.
    var last = stored.history[stored.history.length - 1];
    if (action === 'save' && last && last.text === 'Draft saved' && last.by === email(user.email)) {
      last.at = now;
    } else {
      stored.history.push({ at: now, by: email(user.email), text: event, comment: comment });
    }
    return { claim: stored, event: event, notify: notify };
  }

  function checkUpload(claim, user, rowId, file) {
    if (!canEdit(claim, user)) fail('Receipts can only be added while the claim is a draft.', 403);
    if (!(claim.rows || []).some(function (r) { return r.id === rowId; })) fail('Save the expense before attaching a receipt.');
    if (!file || FILE_TYPES.indexOf(file.type) < 0) fail('Upload a JPG, PNG or PDF file.');
    if (!(file.size > 0) || file.size > MAX_FILE_BYTES) fail('Each receipt must be smaller than 10 MB.');
  }

  /** Checks magic bytes so that a renamed file cannot pretend to be a receipt. */
  function signatureMatches(type, bytes) {
    var b = function (i) { return bytes[i] & 255; };
    if (type === 'image/jpeg') return b(0) === 0xff && b(1) === 0xd8;
    if (type === 'image/png') return b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47;
    if (type === 'application/pdf') return b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46;
    return false;
  }

  function addAttachment(claim, rowId, att, user, now) {
    var row = claim.rows.filter(function (r) { return r.id === rowId; })[0];
    row.attachments.push({ id: att.id, name: str(att.name, 180), type: att.type, size: att.size, at: now });
    claim.revision += 1;
    claim.updated = now;
    return claim;
  }

  function removeAttachment(claim, user, fileId, now) {
    if (!canEdit(claim, user)) fail('Receipts can only be removed while the claim is a draft.', 403);
    var found = null;
    claim.rows.forEach(function (r) {
      r.attachments = r.attachments.filter(function (a) { if (a.id === fileId) { found = a; return false; } return true; });
    });
    if (!found) fail('Receipt not found.', 404);
    claim.revision += 1;
    claim.updated = now;
    return found;
  }

  function findAttachment(claim, fileId) {
    var out = null;
    (claim.rows || []).forEach(function (r) { (r.attachments || []).forEach(function (a) { if (a.id === fileId) out = a; }); });
    return out;
  }

  function money(v) {
    var n = Math.round(num(v) * 100) / 100, neg = n < 0;
    var parts = Math.abs(n).toFixed(2).split('.');
    return (neg ? '−' : '') + '€' + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + parts[1];
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** Builds the email for a workflow event. Plain text + branded HTML. */
  function notification(claim, kind, appUrl, logoUrl) {
    var t = totals(claim);
    var link = String(appUrl || '').replace(/\/?$/, '/') + '?claim=' + claim.id;
    var spec = {
      review: { to: claim.responsible, title: 'An expense claim is waiting for your approval', cta: 'Review the claim', accent: '#f9b233' },
      admin: { to: claim.adminEmail, title: 'An approved expense claim is ready for administration', cta: 'Open the claim', accent: '#009fe3' },
      returned: { to: claim.ownerEmail, title: 'Your expense claim needs changes', cta: 'Update the claim', accent: '#e84e1b' },
      paid: { to: claim.ownerEmail, title: 'Your expense claim has been settled', cta: 'View the claim', accent: '#12866b' }
    }[kind];
    if (!spec) return null;
    var lastComment = '';
    for (var i = claim.history.length - 1; i >= 0; i--) { if (claim.history[i].comment) { lastComment = claim.history[i].comment; break; } }
    var subject = 'Expense claim ' + (claim.reference || claim.id.slice(0, 8)) + ' · ' + STATUS[claim.status];
    var text = [
      'Hello,', '',
      spec.title + '.', '',
      'Claim: ' + claim.reference,
      'Claimant: ' + claim.name + ' (' + claim.ownerEmail + ')',
      'Period: ' + claim.start + ' to ' + claim.end,
      'Total: ' + money(t.total) + ' · ' + t.lines + ' expenses',
      'Status: ' + STATUS[claim.status]
    ].concat(lastComment ? ['Comment: ' + lastComment] : []).concat(['', spec.cta + ': ' + link, '', 'Escola Europea – Intermodal Transport']).join('\n');
    var row = function (k, v) { return '<tr><td style="padding:6px 0;color:#65758a;width:120px">' + k + '</td><td style="padding:6px 0;color:#10233d;font-weight:600">' + esc(v) + '</td></tr>'; };
    var html = '<div style="background:#f5f8fb;padding:28px 12px;font-family:Inter,Segoe UI,Arial,sans-serif">' +
      '<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #dfe7ef;border-collapse:separate">' +
      '<tr><td style="background:#062f66;padding:20px 28px">' + (logoUrl ? '<img src="' + esc(logoUrl) + '" alt="Escola Europea" height="40" style="display:block;height:40px">' : '<b style="color:#fff;font-size:16px">Escola Europea</b>') + '</td></tr>' +
      '<tr><td style="height:4px;background:' + spec.accent + '"></td></tr>' +
      '<tr><td style="padding:28px">' +
      '<div style="font-size:11px;letter-spacing:1.6px;color:#0b4ea2;font-weight:700;text-transform:uppercase">Expense claims</div>' +
      '<h1 style="margin:8px 0 18px;font-size:22px;color:#062f66">' + esc(spec.title) + '</h1>' +
      '<table role="presentation" style="font-size:14px;border-collapse:collapse;width:100%">' +
      row('Claim', claim.reference) + row('Claimant', claim.name + ' · ' + claim.ownerEmail) + row('Period', claim.start + ' → ' + claim.end) +
      row('Total', money(t.total) + ' (' + t.lines + ' expenses)') + row('Status', STATUS[claim.status]) + (lastComment ? row('Comment', lastComment) : '') +
      '</table>' +
      '<a href="' + esc(link) + '" style="display:inline-block;margin-top:22px;background:#0b4ea2;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700">' + spec.cta + ' →</a>' +
      '<p style="margin:22px 0 0;font-size:12px;color:#65758a">Receipts are not attached to this email. Open the claim to see them.</p>' +
      '</td></tr><tr><td style="padding:16px 28px;background:#f5f8fb;font-size:11px;color:#65758a">Escola Europea – Intermodal Transport · Train and sea with us</td></tr></table></div>';
    return { to: email(spec.to), subject: subject, text: text, html: html, kind: kind };
  }

  return {
    STATUS: STATUS, CATEGORIES: CATEGORIES, PAYMENTS: PAYMENTS, CURRENCIES: CURRENCIES,
    FILE_TYPES: FILE_TYPES, MAX_FILE_BYTES: MAX_FILE_BYTES, MAX_ROWS: MAX_ROWS,
    RuleError: RuleError, fail: fail, email: email, isUuid: isUuid, cents: cents, totals: totals,
    newClaim: newClaim, newRow: newRow, normalise: normalise, editable: editable, roles: roles,
    canAccess: canAccess, canEdit: canEdit, pendingFor: pendingFor, applyAction: applyAction,
    validateForSubmit: validateForSubmit, checkUpload: checkUpload, signatureMatches: signatureMatches,
    addAttachment: addAttachment, removeAttachment: removeAttachment, findAttachment: findAttachment,
    notification: notification, money: money, esc: esc
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Rules;
