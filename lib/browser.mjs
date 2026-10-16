// Minimal headless Chrome driver over the DevTools protocol (Node 22 built-in WebSocket, no dependencies).
// Used so footers that are built by JavaScript are checked the way a visitor sees them.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BROWSER_UA } from './net.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
// Must match the @sparticuz/chromium version in package.json.
const CHROMIUM_PACK_URL = 'https://github.com/Sparticuz/chromium/releases/download/v152.0.0/chromium-v152.0.0-pack.x64.tar';

// On Vercel there is no system Chrome: use the serverless build from @sparticuz/chromium.
// That package only unpacks the shared libraries Chrome needs (al2023.tar.br: libnss3 and friends) when it sees
// AWS Lambda's environment variables, which Vercel does not set, so we declare the runtime ourselves.
async function resolveChrome() {
  if (SERVERLESS && !process.env.CHROME_PATH) {
    process.env.AWS_LAMBDA_JS_RUNTIME ||= `nodejs${process.versions.node.split('.')[0]}.x`;
    const { default: chromium, inflate } = await import('@sparticuz/chromium');
    let exe;
    try {
      if (process.env.CHROMIUM_FROM_RELEASE === '1') throw new Error('CHROMIUM_FROM_RELEASE=1');
      exe = await chromium.executablePath();
    } catch (err) {
      // Bundled Chrome files missing from the deployment: download the same build from its GitHub release.
      console.error(`[browser] bundled Chromium unavailable (${err.message}); downloading ${CHROMIUM_PACK_URL}`);
      exe = await chromium.executablePath(CHROMIUM_PACK_URL);
    }
    // executablePath() returns early when /tmp/chromium is cached, so make sure the libraries are unpacked too.
    const libDir = join(tmpdir(), 'al2023', 'lib');
    if (!existsSync(libDir)) {
      const binDir = join(dirname(fileURLToPath(import.meta.resolve('@sparticuz/chromium'))), '..', 'bin');
      const archive = [join(binDir, 'al2023.tar.br'), join(tmpdir(), 'chromium-pack', 'al2023.tar.br')].find(existsSync);
      if (archive) await inflate(archive);
    }
    if (!(process.env.LD_LIBRARY_PATH || '').includes(libDir)) {
      process.env.LD_LIBRARY_PATH = [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    }
    return { exe, args: chromium.args.filter((a) => !a.startsWith('--remote-debugging')) };
  }
  const exe = findChrome();
  return exe ? { exe, args: ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage'] } : null;
}

export function findChrome() {
  const env = process.env.CHROME_PATH;
  if (env && existsSync(env)) return env;
  const fixed = [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/snap/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of fixed) if (existsSync(p)) return p;
  // Browsers downloaded by Puppeteer or Playwright, newest first.
  const caches = [
    [join(homedir(), '.cache/puppeteer/chrome'), 'chrome-linux64/chrome'],
    [join(homedir(), '.cache/ms-playwright'), 'chrome-linux64/chrome', /^chromium-\d+$/],
  ];
  for (const [dir, exe, filter] of caches) {
    if (!existsSync(dir)) continue;
    const versions = readdirSync(dir).filter((d) => !filter || filter.test(d)).sort().reverse();
    for (const v of versions) if (existsSync(join(dir, v, exe))) return join(dir, v, exe);
  }
  return null;
}

class Browser {
  static async launch() {
    const chrome = await resolveChrome();
    if (!chrome) throw new Error('No Chrome or Chromium found (set CHROME_PATH)');
    const dir = mkdtempSync(join(tmpdir(), 'botchain-checker-'));
    const args = [
      ...chrome.args, '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run',
      '--no-default-browser-check', '--mute-audio', '--window-size=1440,900', 'about:blank',
    ];
    if (process.getuid?.() === 0 && !args.includes('--no-sandbox')) args.unshift('--no-sandbox');
    const proc = spawn(chrome.exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('Chrome did not start within 20s')), 20000);
      proc.stderr.on('data', (d) => {
        buf += d;
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) { clearTimeout(t); resolve(m[1]); }
      });
      proc.on('exit', (code) => {
        clearTimeout(t);
        const why = buf.split('\n').filter((l) => /error|cannot|while loading|No such/i.test(l)).slice(-2).join(' ').slice(0, 300);
        reject(new Error(`Chrome exited during start (code ${code})${why ? `: ${why}` : ''}`));
      });
    });
    const b = new Browser();
    Object.assign(b, { proc, dir, nextId: 1, pending: new Map(), listeners: new Map(), alive: true });
    b.ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { b.ws.onopen = res; b.ws.onerror = () => rej(new Error('DevTools socket failed')); });
    b.ws.onclose = () => { b.alive = false; };
    proc.on('exit', () => { b.alive = false; });
    b.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && b.pending.has(msg.id)) {
        const { resolve, reject, timer } = b.pending.get(msg.id);
        clearTimeout(timer);
        b.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of b.listeners.get(`${msg.sessionId || ''}|${msg.method}`) || []) fn(msg.params);
      }
    };
    return b;
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  on(sessionId, method, fn) {
    const key = `${sessionId || ''}|${method}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(fn);
    return () => this.listeners.get(key).delete(fn);
  }

  close() {
    this.alive = false;
    try { this.ws.close(); } catch {}
    try { this.proc.kill(); } catch {}
    setTimeout(() => rmSync(this.dir, { recursive: true, force: true }), 500);
  }
}

let shared = null;
let launchFailedAt = 0;
async function getBrowser() {
  if (shared && (await shared).alive) return shared;
  shared = Browser.launch();
  shared.catch((err) => {
    shared = null;
    launchFailedAt = Date.now();
    console.error(`[browser] launch failed: ${err.message}`);
  });
  return shared;
}

// Starts the browser and opens a blank tab: used by /api/check?diagnose=1 to confirm the deployment can render pages.
export async function diagnoseBrowser() {
  const started = Date.now();
  try {
    const browser = await getBrowser();
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    await browser.send('Target.closeTarget', { targetId });
    return { ok: true, ms: Date.now() - started, serverless: SERVERLESS };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, serverless: SERVERLESS, error: err.message };
  }
}

export function browserAvailable() {
  if (process.env.CHECKER_NO_BROWSER === '1') return false;
  // After a failed launch, skip the browser for a while so checks fall back to reading the site's code quickly.
  if (Date.now() - launchFailedAt < 5 * 60_000) return false;
  return SERVERLESS || Boolean(findChrome());
}

// Opens the URL in a fresh tab, waits for it to settle, scrolls to the bottom (lazy footers), then runs `fn` in the page.
export async function renderAndEvaluate(url, fn, { timeoutMs = 25000 } = {}) {
  const browser = await getBrowser();
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p, t) => browser.send(m, p, sessionId, t);
  const offs = [];
  try {
    await send('Page.enable');
    await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    // Headless Chrome announces itself as "HeadlessChrome", which bot protection (e.g. Vercel's) answers with 403.
    await send('Network.setUserAgentOverride', { userAgent: BROWSER_UA, acceptLanguage: 'en-US,en;q=0.9' });
    offs.push(browser.on(sessionId, 'Page.javascriptDialogOpening', () => send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {})));

    let docStatus = null;
    offs.push(browser.on(sessionId, 'Network.responseReceived', (p) => {
      if (p.type === 'Document') docStatus = p.response.status; // the latest page load (after any challenge redirect)
    }));
    const loaded = new Promise((r) => offs.push(browser.on(sessionId, 'Page.loadEventFired', r)));
    const nav = await send('Page.navigate', { url }, timeoutMs);
    if (nav.errorText) throw new Error(nav.errorText.replace(/^net::/, ''));
    await Promise.race([loaded, sleep(timeoutMs)]);
    await sleep(1500);
    // Bot challenges (Vercel Security Checkpoint, Cloudflare "Just a moment") clear themselves in a real browser.
    const CHALLENGE = /security checkpoint|just a moment|attention required|checking your browser/i;
    for (let waited = 0; waited < 8000; waited += 1000) {
      const t = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }).catch(() => null);
      if (!CHALLENGE.test(t?.result?.value || '')) break;
      await sleep(1000);
    }
    await send('Runtime.evaluate', { expression: 'window.scrollTo(0, document.documentElement.scrollHeight)' });
    await sleep(1500);
    const r = await send('Runtime.evaluate', {
      expression: `(${fn.toString()})()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error('page script failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return { status: docStatus, value: r.result.value };
  } finally {
    offs.forEach((off) => off());
    browser.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

export function closeBrowser() {
  if (shared) shared.then((b) => b.close()).catch(() => {});
}
