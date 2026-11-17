// ─────────────────────────────────────────────────────────────────────────────
//  Escola Europea · Expense Claims — configuration
//  Leave apiUrl or googleClientId empty to run in DEMO mode (everything stays on
//  this device, with switchable demo users). Fill both to use the Google backend.
// ─────────────────────────────────────────────────────────────────────────────
window.APP_CONFIG = {
  // Google Apps Script web app URL, ending in /exec (Deploy → Manage deployments).
  apiUrl: '',

  // OAuth 2.0 Client ID (type "Web application") from Google Cloud Console.
  googleClientId: '',

  // Only accounts from this Google Workspace domain can sign in.
  allowedDomain: 'escolaeuropea.eu',

  // Administration contacts offered on every claim. Add the real addresses.
  administrators: [
    { name: 'Carola', email: '' },
    { name: 'Tereza', email: '' }
  ]
};
