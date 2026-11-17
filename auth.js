// Google Sign-In (Google Identity Services). Produces short-lived ID tokens that the
// Apps Script backend verifies on every request. No passwords are stored by this app.
const KEY = 'escola-expenses:idtoken';

function decode(jwt) {
  try {
    const p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(p))));
  } catch { return null; }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`) && globalThis.google?.accounts?.id) return resolve();
    const s = document.createElement('script');
    s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error('Google Sign-In could not be loaded. Check your connection.'));
    document.head.appendChild(s);
  });
}

export class GoogleAuth {
  constructor(config) {
    this.clientId = config.googleClientId;
    this.domain = config.allowedDomain || '';
    this.credential = null;
    this.waiters = [];
    try { this.credential = sessionStorage.getItem(KEY); } catch { /* ignore */ }
    if (!this.valid()) this.credential = null;
  }

  get profile() { return this.credential ? decode(this.credential) : null; }
  valid(marginSec = 120) { const p = this.profile; return !!p && p.exp * 1000 > Date.now() + marginSec * 1000; }

  async init() {
    await loadScript('https://accounts.google.com/gsi/client');
    google.accounts.id.initialize({
      client_id: this.clientId,
      callback: r => this.accept(r.credential),
      auto_select: true,
      cancel_on_tap_outside: false,
      itp_support: true,
      ...(this.domain ? { hd: this.domain } : {})
    });
  }

  accept(credential) {
    this.credential = credential;
    try { sessionStorage.setItem(KEY, credential); } catch { /* ignore */ }
    const w = this.waiters; this.waiters = [];
    w.forEach(fn => fn(credential));
    this.onChange?.(this.profile);
  }

  renderButton(el) {
    google.accounts.id.renderButton(el, { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with', width: 280 });
    google.accounts.id.prompt();
  }

  /** Resolves with a valid ID token, asking Google silently (One Tap) when the current one is about to expire. */
  token() {
    if (this.valid()) return Promise.resolve(this.credential);
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve);
      try { google.accounts.id.prompt(n => { if (n.isNotDisplayed?.() || n.isSkippedMoment?.()) this.onNeedsButton?.(); }); }
      catch (e) { reject(e); }
    });
  }

  expire() { this.credential = null; try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } }

  signOut() {
    this.expire();
    try { google.accounts.id.disableAutoSelect(); } catch { /* ignore */ }
  }
}
