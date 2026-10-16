// Network helpers: timeouts, JSON fetching and a guard that keeps user-supplied URLs off private networks.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class CheckError extends Error {
  // kind: 'input' (the user must fix what they submitted) or 'unavailable' (we could not verify)
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

export const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 BotchainProjectChecker/1.0';

export async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson(url, { timeoutMs = 15000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, timeoutMs);
      if (res.status === 404 || res.status === 400 || res.status === 422) return { status: res.status, data: null };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { status: res.status, data: await res.json() };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new CheckError('unavailable', `BotScan did not respond (${describeError(lastErr)}).`);
}

export function describeError(err) {
  if (!err) return 'unknown error';
  if (err.name === 'AbortError') return 'timed out';
  const code = err.cause?.code || err.code;
  if (code === 'ENOTFOUND') return 'domain not found';
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ECONNRESET') return 'connection reset';
  if (code && /CERT|SSL|TLS/i.test(code)) return 'invalid TLS certificate';
  return err.cause?.message || err.message || String(err);
}

function isPrivateIp(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateIp(mapped[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

// Throws a CheckError unless the URL is a public http(s) address.
export async function assertPublicUrl(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new CheckError('input', 'Only http and https website URLs can be checked.');
  if (process.env.CHECKER_ALLOW_PRIVATE === '1') return; // local development and tests only
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new CheckError('input', 'Local and internal addresses cannot be checked.');
  }
  let addrs;
  try {
    addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  } catch {
    throw new CheckError('unavailable', `The domain ${host} could not be found (DNS lookup failed).`);
  }
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw new CheckError('input', 'This URL points to a private network address and cannot be checked.');
  }
}
