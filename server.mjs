// Botchain Project Checker: serves the interface and the POST /api/check endpoint.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkContract } from './lib/contract.mjs';
import { checkWebsite } from './lib/website.mjs';
import { closeBrowser } from './lib/browser.mjs';

const PORT = Number(process.env.PORT) || 4300;
const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

// Simple per-IP limit: each check opens a website and calls BotScan many times.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 10;
}

function overall(contract, website) {
  const statuses = [contract.status, website.status];
  if (statuses.includes('FAIL')) return 'FAIL';
  if (statuses.includes('UNABLE')) return 'UNABLE';
  return 'PASS';
}

async function runCheck({ contract: contractInput, website: websiteInput }) {
  const [contract, website] = await Promise.all([checkContract(contractInput), checkWebsite(websiteInput)]);
  const status = overall(contract, website);
  const unverified = [
    contract.status === 'UNABLE' && { check: 'Contract activity', reason: contract.error },
    website.status === 'UNABLE' && { check: 'Website footer', reason: website.error },
  ].filter(Boolean);
  return {
    checkedAt: new Date().toISOString(),
    product: {
      name: website.product.name || 'Unknown Product Name',
      identified: Boolean(website.product.name),
      source: website.product.source,
    },
    status,
    contract,
    website,
    failures: [
      ...contract.failures.map((f) => ({ check: 'Contract activity', ...f })),
      ...website.failures.map((f) => ({ check: 'Website footer', ...f })),
    ],
    unverified,
  };
}

async function readBody(req, limit = 10_000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('Request too large');
  }
  return JSON.parse(body || '{}');
}

function send(res, code, payload, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(payload) : payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/check') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
      if (rateLimited(ip)) return send(res, 429, { error: 'Too many checks. Wait a minute and try again.' });
      let body;
      try {
        body = await readBody(req);
      } catch {
        return send(res, 400, { error: 'The request could not be read.' });
      }
      return send(res, 200, await runCheck(body));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
    const path = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC_DIR, path);
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 404, 'Not found', 'text/plain');
    const data = await readFile(file).catch(() => null);
    if (!data) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'Something went wrong on the server. Try again.' });
  }
});

// If the port is busy (another app on this machine), try the next few instead of crashing.
let port = PORT;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && port < PORT + 20) {
    console.log(`Port ${port} is in use, trying ${port + 1}…`);
    server.listen(++port);
  } else {
    console.error(`Could not start the server: ${err.message}`);
    process.exit(1);
  }
});
server.on('listening', () => console.log(`Botchain Project Checker running at http://localhost:${port}`));
server.listen(port);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { closeBrowser(); process.exit(0); });
