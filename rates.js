// Official ECB reference rates (via the free Frankfurter API), cached on the device.
// Returns the rate as "EUR per one unit of currency", which is what the claim uses.
import { store } from './store.js';

const ENDPOINTS = ['https://api.frankfurter.app', 'https://api.frankfurter.dev/v1'];

export async function ecbRate(currency, date) {
  if (!currency || currency === 'EUR') return { rate: 1, date, source: 'EUR' };
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : 'latest';
  const key = `rate:${currency}:${day}`;
  const hit = await store.get('kv', key);
  if (hit) return hit;
  let lastError;
  for (const base of ENDPOINTS) {
    try {
      const r = await fetch(`${base}/${day}?from=EUR&to=${encodeURIComponent(currency)}`);
      if (!r.ok) throw new Error('Rate not available');
      const j = await r.json();
      const perEuro = j.rates?.[currency];
      if (!perEuro) throw new Error(`The ECB does not publish a rate for ${currency}.`);
      const out = { rate: Math.round((1 / perEuro) * 1e6) / 1e6, date: j.date, source: 'ECB reference rate' };
      if (day !== 'latest') await store.put('kv', out, key);
      return out;
    } catch (e) { lastError = e; }
  }
  throw new Error(navigator.onLine ? (lastError?.message || 'The exchange rate could not be retrieved.') : 'Connect to the internet to look up the exchange rate.');
}
