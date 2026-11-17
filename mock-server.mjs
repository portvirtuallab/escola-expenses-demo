// Test server: exposes the emulated Apps Script backend over HTTP like script.google.com does.
import http from 'node:http';
import { loadBackend, fakeToken } from './gas-emulator.mjs';
const g = await loadBackend();
const port = Number(process.argv[2] || 8766);
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (req.method === 'POST' && url.pathname === '/exec') {
    let raw = ''; for await (const c of req) raw += c;
    return send(200, g.ctx.doPost({ postData: { contents: raw } }).getContent());
  }
  if (url.pathname === '/__token') return send(200, fakeToken(url.searchParams.get('email'), { name: url.searchParams.get('name') || '' }), 'text/plain');
  if (url.pathname === '/__state') return send(200, { claims: g.post({ action: 'list', token: fakeToken(url.searchParams.get('email')) }).data, mails: g.mails.map(m => ({ to: m.to, subject: m.subject })), files: g.files.size });
  send(404, { error: 'not found' });
}).listen(port, '127.0.0.1', () => console.log('mock apps script on ' + port));
