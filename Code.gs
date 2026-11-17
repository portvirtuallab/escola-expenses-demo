/**
 * Escola Europea · Expense Claims — Google Apps Script backend.
 *
 * Storage : one Google Sheet (Claims · Expenses · History) + one Drive folder for receipts.
 * Email   : Gmail (MailApp), sent as the account that deploys this script.
 * Identity: Google Sign-In ID tokens, verified on every request (audience + domain).
 * Rules   : Rules.gs — the same rules engine the web app uses (js/rules.js).
 *
 * First time: set the Script Properties GOOGLE_CLIENT_ID, ALLOWED_DOMAINS and APP_URL,
 * run setup() once from the editor, then Deploy → New deployment → Web app.
 */

var VERSION = '2.0.0';
var CLAIM_HEADERS = ['Claim ID', 'Reference', 'Claimant', 'Claimant email', 'Status', 'Total EUR', 'Manager', 'Administration',
  'Administration email', 'Period start', 'Period end', 'Updated', 'Revision', 'Receipts folder', 'Data (JSON · do not edit)'];
var EXPENSE_HEADERS = ['Claim ID', 'Reference', 'Claimant', 'Status', 'Date', 'Receipt no.', 'Supplier', 'Location', 'Code',
  'Category', 'Payment', 'Amount', 'Currency', 'EUR per unit', 'Amount EUR', 'Notes', 'Missing receipt reason', 'Receipts'];
var HISTORY_HEADERS = ['Timestamp', 'Claim ID', 'Reference', 'Event', 'By', 'Comment', 'Status'];
var JSON_CELL_LIMIT = 45000;

/* ───────────────────────── HTTP entry points ───────────────────────── */

function doGet() {
  return json_({ ok: true, service: 'Escola Europea · Expense Claims API', version: VERSION });
}

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var user = authenticate_(req.token);
    return json_({ ok: true, data: route_(req, user) });
  } catch (err) {
    if (!err.status) console.error(err && err.stack || err);
    return json_({ ok: false, status: err.status || 500, error: err.status ? err.message : 'The operation could not be completed. Please try again.' });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function prop_(k, d) { var v = PropertiesService.getScriptProperties().getProperty(k); return v == null || v === '' ? d : v; }

/* ───────────────────────── Identity ───────────────────────── */

function authenticate_(token) {
  if (!token) Rules.fail('Sign in with your Escola Europea Google account.', 401);
  var clientId = prop_('GOOGLE_CLIENT_ID');
  if (!clientId) Rules.fail('The service is not configured yet (GOOGLE_CLIENT_ID).', 503);
  var cache = CacheService.getScriptCache();
  var key = 'tok_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)).slice(0, 40);
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) Rules.fail('Your session has expired. Sign in again.', 401);
  var t = JSON.parse(res.getContentText());
  var expMs = Number(t.exp) * 1000;
  if (t.aud !== clientId || ['accounts.google.com', 'https://accounts.google.com'].indexOf(t.iss) < 0 || expMs < Date.now()) {
    Rules.fail('Your session is not valid for this application. Sign in again.', 401);
  }
  if (String(t.email_verified) !== 'true') Rules.fail('Your Google email address is not verified.', 403);
  var email = Rules.email(t.email);
  var domains = String(prop_('ALLOWED_DOMAINS', '')).split(',').map(function (d) { return d.trim().toLowerCase(); }).filter(String);
  if (domains.length && domains.indexOf(email.split('@')[1]) < 0) {
    Rules.fail('Use your ' + domains.join(' or ') + ' account to sign in.', 403);
  }
  var user = { id: t.sub, email: email, name: t.name || '' };
  var ttl = Math.min(600, Math.floor((expMs - Date.now()) / 1000) - 30);
  if (ttl > 30) cache.put(key, JSON.stringify(user), ttl);
  return user;
}

/* ───────────────────────── Router ───────────────────────── */

function route_(req, user) {
  var now = new Date().toISOString();
  switch (req.action) {
    case 'me':
      return { user: user, mail: prop_('MAIL_ENABLED', 'true') === 'true', version: VERSION, administrators: administrators_() };

    case 'list':
      return allClaims_().filter(function (c) { return Rules.canAccess(c, user); })
        .sort(function (a, b) { return b.updated.localeCompare(a.updated); });

    case 'get':
      return loadFor_(req.id, user).claim;

    case 'create':
      return withLock_(function () {
        var id = Rules.isUuid(req.id) ? req.id : Utilities.getUuid();
        var existing = findClaim_(id);
        if (existing) {
          if (!Rules.canAccess(existing.claim, user)) Rules.fail('This identifier is already in use.', 409);
          return existing.claim; // idempotent retry from the offline outbox
        }
        var claim = Rules.newClaim(id, user, now, req.defaults || {});
        writeClaim_(claim, null);
        logHistory_(claim, claim.history[0]);
        return claim;
      });

    case 'save':
      return withLock_(function () {
        var found = loadFor_(req.id, user);
        var out = Rules.applyAction(found.claim, req.claim, user, req.op, req.comment, now);
        var c = out.claim;
        if (out.notify) c.notification = sendMail_(c, out.notify);
        writeClaim_(c, found.row);
        writeExpenses_(c);
        var last = c.history[c.history.length - 1];
        if (out.event !== 'Draft saved') logHistory_(c, last);
        return c;
      });

    case 'upload':
      return withLock_(function () {
        var found = loadFor_(req.id, user);
        var c = found.claim;
        var bytes = Utilities.base64Decode(String(req.data || ''));
        var file = { name: String(req.name || 'receipt').slice(0, 180), type: req.type, size: bytes.length };
        Rules.checkUpload(c, user, req.row, file);
        if (!Rules.signatureMatches(file.type, bytes)) Rules.fail('The file content does not match its type.');
        var folder = claimFolder_(c);
        var driveFile = folder.createFile(Utilities.newBlob(bytes, file.type, file.name));
        driveFile.setDescription('Expense claim ' + c.reference + ' · ' + c.id + ' · uploaded by ' + user.email);
        file.id = driveFile.getId();
        Rules.addAttachment(c, req.row, file, user, now);
        writeClaim_(c, found.row);
        writeExpenses_(c);
        return c;
      });

    case 'removeFile':
      return withLock_(function () {
        var found = loadFor_(req.id, user);
        var removed = Rules.removeAttachment(found.claim, user, req.fileId, now);
        try { DriveApp.getFileById(removed.id).setTrashed(true); } catch (e) { console.warn('Could not trash ' + removed.id); }
        writeClaim_(found.claim, found.row);
        writeExpenses_(found.claim);
        return found.claim;
      });

    case 'file':
      var c = loadFor_(req.id, user).claim;
      var att = Rules.findAttachment(c, req.fileId);
      if (!att) Rules.fail('Receipt not found.', 404);
      var blob = DriveApp.getFileById(att.id).getBlob();
      return { name: att.name, type: att.type, data: Utilities.base64Encode(blob.getBytes()) };

    default:
      Rules.fail('Unknown action.', 400);
  }
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) Rules.fail('The service is busy. Try again in a few seconds.', 503);
  try { return fn(); } finally { lock.releaseLock(); }
}

function loadFor_(id, user) {
  if (!Rules.isUuid(id)) Rules.fail('Expense claim not found.', 404);
  var found = findClaim_(id);
  if (!found) Rules.fail('Expense claim not found.', 404);
  if (!Rules.canAccess(found.claim, user)) Rules.fail('You do not have access to this expense claim.', 403);
  return found;
}

function administrators_() {
  try { return JSON.parse(prop_('ADMINISTRATORS', '[]')); } catch (e) { return []; }
}

/* ───────────────────────── Storage: Sheets ───────────────────────── */

function book_() {
  var id = prop_('SPREADSHEET_ID');
  if (!id) Rules.fail('The service is not configured yet. Run setup() in Apps Script.', 503);
  return SpreadsheetApp.openById(id);
}
function sheet_(name) { return book_().getSheetByName(name); }

function allClaims_() {
  var sh = sheet_('Claims');
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, CLAIM_HEADERS.length, n, 1).getValues()
    .map(function (r) { return r[0] ? parseClaimCell_(r[0]) : null; })
    .filter(Boolean);
}

function findClaim_(id) {
  var sh = sheet_('Claims');
  if (sh.getLastRow() < 2) return null;
  var cell = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(id).matchEntireCell(true).findNext();
  if (!cell) return null;
  var row = cell.getRow();
  return { row: row, claim: parseClaimCell_(sh.getRange(row, CLAIM_HEADERS.length).getValue()) };
}

function parseClaimCell_(v) {
  v = String(v);
  if (v.indexOf('drive:') === 0) v = DriveApp.getFileById(v.slice(6)).getBlob().getDataAsString();
  return Rules.normalise(JSON.parse(v));
}

function writeClaim_(c, row) {
  var sh = sheet_('Claims');
  var t = Rules.totals(c);
  var data = JSON.stringify(c);
  if (data.length > JSON_CELL_LIMIT) {
    // Very large claims are stored as a JSON file in the claim folder; the cell keeps a pointer.
    var folder = claimFolder_(c);
    var name = 'claim-data.json';
    var files = folder.getFilesByName(name);
    var f = files.hasNext() ? files.next() : folder.createFile(name, '{}', 'application/json');
    f.setContent(data);
    data = 'drive:' + f.getId();
  }
  var values = [c.id, c.reference, c.name, c.ownerEmail, Rules.STATUS[c.status], t.total, c.responsible, c.adminName, c.adminEmail,
    c.start, c.end, new Date(c.updated), c.revision, c.folderId ? 'https://drive.google.com/drive/folders/' + c.folderId : '', data];
  if (row) sh.getRange(row, 1, 1, values.length).setValues([values]);
  else sh.appendRow(values);
}

/** Keeps a flat, human-friendly copy of every expense line for administration and reporting. */
function writeExpenses_(c) {
  var sh = sheet_('Expenses');
  var last = sh.getLastRow();
  var keep = last > 1 ? sh.getRange(2, 1, last - 1, EXPENSE_HEADERS.length).getValues().filter(function (r) { return r[0] !== c.id; }) : [];
  var mine = c.rows.map(function (r) {
    return [c.id, c.reference, c.name, Rules.STATUS[c.status], r.date, r.number, r.vendor, r.city, r.category, Rules.CATEGORIES[r.category],
      r.payment, r.amount, r.currency, r.rate, Rules.cents(r) / 100, r.observations, r.missingReason,
      r.attachments.map(function (a) { return 'https://drive.google.com/file/d/' + a.id + '/view'; }).join('\n')];
  });
  var rows = keep.concat(mine);
  if (last > 1) sh.getRange(2, 1, last - 1, EXPENSE_HEADERS.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, EXPENSE_HEADERS.length).setValues(rows);
}

function logHistory_(c, h) {
  sheet_('History').appendRow([new Date(h.at), c.id, c.reference, h.text, h.by, h.comment || '', Rules.STATUS[c.status]]);
}

/* ───────────────────────── Storage: Drive ───────────────────────── */

function claimFolder_(c) {
  if (c.folderId) {
    try { return DriveApp.getFolderById(c.folderId); } catch (e) { /* recreated below */ }
  }
  var root = DriveApp.getFolderById(prop_('ROOT_FOLDER_ID'));
  var name = (c.reference || 'Expense claim').replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) + ' · ' + c.id.slice(0, 8).toUpperCase();
  var folder = root.createFolder(name);
  c.folderId = folder.getId();
  return folder;
}

/* ───────────────────────── Email ───────────────────────── */

function sendMail_(c, kind) {
  var appUrl = prop_('APP_URL', '');
  var msg = Rules.notification(c, kind, appUrl, appUrl ? appUrl.replace(/\/?$/, '/') + 'mark_white.png' : '');
  if (!msg || !msg.to) return { state: 'skipped', kind: kind };
  if (prop_('MAIL_ENABLED', 'true') !== 'true') return { state: 'manual', kind: kind, to: msg.to, subject: msg.subject, body: msg.text };
  try {
    MailApp.sendEmail({
      to: msg.to, subject: msg.subject, body: msg.text, htmlBody: msg.html,
      name: prop_('MAIL_SENDER_NAME', 'Escola Europea · Expense Claims'),
      replyTo: kind === 'review' ? c.ownerEmail : kind === 'admin' ? c.responsible : kind === 'returned' ? c.responsible : c.adminEmail
    });
    return { state: 'sent', kind: kind, to: msg.to, at: new Date().toISOString() };
  } catch (e) {
    console.error('Mail failed: ' + e);
    return { state: 'failed', kind: kind, to: msg.to, subject: msg.subject, body: msg.text };
  }
}

/* ───────────────────────── One-time setup ───────────────────────── */

/**
 * Run once from the Apps Script editor (select "setup" → Run).
 * Creates the data spreadsheet and the receipts folder, and stores their IDs.
 * Safe to run again: existing resources are kept.
 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var ssId = props.getProperty('SPREADSHEET_ID');
  var ss = ssId ? SpreadsheetApp.openById(ssId) : SpreadsheetApp.create('Escola Europea · Expense Claims (data)');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  [['Claims', CLAIM_HEADERS], ['Expenses', EXPENSE_HEADERS], ['History', HISTORY_HEADERS]].forEach(function (spec, i) {
    var sh = ss.getSheetByName(spec[0]) || (i === 0 && ss.getSheets()[0].getName() === 'Sheet1' ? ss.getSheets()[0].setName(spec[0]) : ss.insertSheet(spec[0]));
    sh.getRange(1, 1, 1, spec[1].length).setValues([spec[1]])
      .setFontWeight('bold').setFontColor('#ffffff').setBackground('#0b4ea2');
    sh.setFrozenRows(1);
  });
  ss.getSheetByName('Claims').hideColumns(CLAIM_HEADERS.length);

  var folderId = props.getProperty('ROOT_FOLDER_ID');
  var folder = folderId ? DriveApp.getFolderById(folderId) : DriveApp.createFolder('Escola Europea · Expense Claims (receipts)');
  props.setProperty('ROOT_FOLDER_ID', folder.getId());
  if (!props.getProperty('MAIL_ENABLED')) props.setProperty('MAIL_ENABLED', 'true');

  var missing = ['GOOGLE_CLIENT_ID', 'APP_URL'].filter(function (k) { return !props.getProperty(k); });
  console.log('Spreadsheet: ' + ss.getUrl());
  console.log('Receipts folder: ' + folder.getUrl());
  console.log(missing.length ? 'Still to set in Project Settings → Script properties: ' + missing.join(', ') : 'Configuration complete.');
  // Touch the services once so the authorisation screen asks for every scope now.
  UrlFetchApp.getRequest('https://oauth2.googleapis.com/tokeninfo');
  MailApp.getRemainingDailyQuota();
}

/** Sends yourself a sample email to check delivery and appearance. */
function sendTestEmail() {
  var me = Session.getEffectiveUser().getEmail();
  var now = new Date().toISOString();
  var c = Rules.newClaim(Utilities.getUuid(), { id: 'test', email: me, name: 'Test claimant' }, now);
  c.reference = 'Test claim'; c.start = now.slice(0, 10); c.end = c.start; c.responsible = me; c.status = 'review';
  var r = sendMail_(c, 'review');
  console.log(JSON.stringify(r));
}
