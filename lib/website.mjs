// Check 2: the website footer must link to the Botchain website and to BotScan.
// Also identifies the product name from the same page.
import { browserAvailable, renderAndEvaluate } from './browser.mjs';
import { BROWSER_UA, CheckError, assertPublicUrl, describeError, fetchWithTimeout } from './net.mjs';
import { botchainLinksIn, chunkUrls, scanBundleForFooter, scriptUrls } from './source-scan.mjs';

export const REQUIRED_LINKS = [
  {
    id: 'botchain',
    label: 'Botchain website',
    expected: 'https://botchain.ai/',
    // botchain.ai redirects to www.botchain.ai/en/, so those are the same destination.
    matches: (u) => /^(www\.)?botchain\.ai$/.test(u.hostname) && /^\/?([a-z]{2}(-[a-z]{2})?\/?)?$/i.test(u.pathname),
    sameSite: (u) => /^(www\.)?botchain\.ai$/.test(u.hostname),
    relatedText: (t) => /bot\s*chain/i.test(t) && !/bot\s*scan|scan\.botchain/i.test(t),
    relatedHost: (u) => /(^|\.)(botchain\.ai|bohr\.life)$/.test(u.hostname) && !/^scan\./.test(u.hostname),
  },
  {
    id: 'botscan',
    label: 'BotScan',
    expected: 'https://scan.botchain.ai/',
    matches: (u) => u.hostname === 'scan.botchain.ai' && /^\/?$/.test(u.pathname),
    sameSite: (u) => u.hostname === 'scan.botchain.ai',
    relatedText: (t) => /bot\s*scan|scan\.botchain/i.test(t),
    relatedHost: (u) => /^scan\./.test(u.hostname) && /(botchain\.ai|bohr\.life)$/.test(u.hostname),
  },
];

// ---------- page extraction ----------

// Runs inside the rendered page. Must be self-contained.
function extractInPage() {
  const FOOTER = 'footer, [role="contentinfo"], [id*="footer" i], [class*="footer" i]';
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const meta = (sel) => clean(document.querySelector(sel)?.getAttribute('content'));
  const footers = [...document.querySelectorAll(FOOTER)].filter((el) => !el.parentElement?.closest(FOOTER));
  
  const anchors = [...document.querySelectorAll('a')].map((a) => {
    const style = getComputedStyle(a);
    return {
      rawHref: a.getAttribute('href'),
      href: a.href || '',
      text: clean(a.innerText || a.textContent || a.getAttribute('aria-label') || a.title || a.querySelector('img')?.alt),
      inFooter: footers.length ? Boolean(a.closest(FOOTER)) : true, // no footer element: the whole page is checked
      visible: a.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none',
    };
  });

  let footerPlainText = '';
  const regions = footers.length ? footers : [];
  for (const f of regions) {
    const copy = f.cloneNode(true);
    copy.querySelectorAll('a, script, style').forEach((n) => n.remove());
    footerPlainText += ' ' + clean(copy.textContent);
  }
  if (!footers.length) {
    // No footer element: take the visible text of the whole page.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.parentElement?.closest('a, script, style')) continue;
      footerPlainText += ' ' + clean(n.textContent);
    }
  }

  const jsonLdNames = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent);
      const items = [].concat(data['@graph'] || data);
      for (const it of items) {
        const type = [].concat(it['@type'] || []).join(' ');
        if (/Organization|WebSite|SoftwareApplication|Product|Brand|Corporation/i.test(type) && typeof it.name === 'string') jsonLdNames.push(clean(it.name));
      }
    } catch {}
  }

  const logoTexts = [];
  const header = document.querySelector('header, nav, [class*="header" i]');
  if (header) {
    for (const img of header.querySelectorAll('img[alt], svg[aria-label]')) logoTexts.push(clean(img.getAttribute('alt') || img.getAttribute('aria-label')));
    for (const a of header.querySelectorAll('a[href="/"], a[aria-label]')) logoTexts.push(clean(a.getAttribute('aria-label') || a.innerText));
  }

  return {
    finalUrl: location.href,
    title: clean(document.title),
    metas: {
      ogSiteName: meta('meta[property="og:site_name"]'),
      applicationName: meta('meta[name="application-name"]'),
      appleTitle: meta('meta[name="apple-mobile-web-app-title"]'),
    },
    jsonLdNames,
    logoTexts: logoTexts.filter(Boolean).slice(0, 6),
    brandTexts: [...new Set([...document.querySelectorAll('header *, nav *, body *')].slice(0, 400)
      .map((el) => clean(el.textContent)).filter((t) => t.length >= 2 && t.length <= 40))].slice(0, 150),
    footerMethod: footers.length ? 'element' : 'bottom',
    footerPlainText: clean(footerPlainText),
    anchors,
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s) =>
  (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z#0-9]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m);
const stripTags = (s) => decode((s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decode(m[2] ?? m[3] ?? m[4]) : null;
};

// Fallback when no browser is available: read the static HTML.
function extractFromHtml(html, pageUrl) {
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  const body = html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, '');
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  const metaContent = (key, val) => {
    const tag = metaTags.find((t) => (attr(t, key) || '').toLowerCase() === val);
    return tag ? (attr(tag, 'content') || '').trim() : '';
  };

  const footerStart = body.search(/<footer\b|<[a-z0-9]+\b[^>]*(role\s*=\s*["']contentinfo["']|(id|class)\s*=\s*["'][^"']*footer)/i);
  const footerMethod = footerStart >= 0 ? 'element' : 'bottom';
  const regionStart = footerStart >= 0 ? footerStart : 0; // no footer element: the whole page
  const region = body.slice(regionStart);

  const anchors = [];
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const rawHref = attr(m[1], 'href');
    let href = '';
    try { href = rawHref ? new URL(rawHref, pageUrl).href : ''; } catch {}
    const imgAlt = (m[2].match(/<img\b[^>]*>/i) || [''])[0];
    anchors.push({
      rawHref,
      href,
      text: stripTags(m[2]) || attr(m[1], 'aria-label') || attr(m[1], 'title') || attr(imgAlt, 'alt') || '',
      inFooter: m.index >= regionStart,
      visible: true,
    });
  }

  const jsonLdNames = [];
  for (const m of html.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]);
      for (const it of [].concat(data['@graph'] || data)) {
        const type = [].concat(it['@type'] || []).join(' ');
        if (/Organization|WebSite|SoftwareApplication|Product|Brand|Corporation/i.test(type) && typeof it.name === 'string') jsonLdNames.push(it.name.trim());
      }
    } catch {}
  }

  const header = (body.match(/<header\b[\s\S]*?<\/header>/i) || [''])[0];
  const logoTexts = (header.match(/<img\b[^>]*>/gi) || []).map((t) => attr(t, 'alt')).filter(Boolean).slice(0, 6);

  return {
    finalUrl: pageUrl,
    title: stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]),
    metas: {
      ogSiteName: metaContent('property', 'og:site_name'),
      applicationName: metaContent('name', 'application-name'),
      appleTitle: metaContent('name', 'apple-mobile-web-app-title'),
    },
    jsonLdNames,
    logoTexts,
    brandTexts: [...new Set([...body.slice(0, 80_000).matchAll(/>([^<>]{2,40})</g)].map((m) => decode(m[1]).trim()).filter(Boolean))].slice(0, 150),
    footerMethod,
    footerPlainText: stripTags(region.replace(/<a\b[\s\S]*?<\/a>/gi, ' ')),
    anchors,
  };
}

async function fetchStatic(url) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicUrl(current);
    let res;
    try {
      res = await fetchWithTimeout(current, { redirect: 'manual', headers: { 'user-agent': BROWSER_UA, accept: 'text/html,*/*' } }, 20000);
    } catch (err) {
      throw new CheckError('unavailable', `The website could not be reached (${describeError(err)}).`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).href;
      continue;
    }
    if (res.status >= 400) {
      const body = (await res.text().catch(() => '')).slice(0, 20000);
      const firewall = (body.match(/<title>\s*(Vercel Security Checkpoint|Just a moment|Attention Required|Access denied)[^<]*/i) || [])[1];
      if (firewall) {
        throw new CheckError('unavailable', `The website's firewall ("${firewall}") blocked the automated check, so its links could not be read. The site owner can allow it by turning off bot protection or attack-challenge mode for the homepage, then run the check again.`);
      }
      throw new CheckError('unavailable', `The website returned HTTP ${res.status}, so its links could not be read.`);
    }
    const html = (await res.text()).slice(0, 5_000_000);
    return { ...extractFromHtml(html, current), html };
  }
  throw new CheckError('unavailable', 'The website redirected too many times.');
}

const NET_ERRORS = { NAME_NOT_RESOLVED: 'domain not found', CONNECTION_REFUSED: 'connection refused', TIMED_OUT: 'timed out', CERT: 'invalid TLS certificate', SSL: 'TLS error' };

async function loadPage(url) {
  let browserError = null;
  if (browserAvailable()) {
    // Two attempts: a cold serverless start or a crashed shared browser usually recovers on the second.
    const started = Date.now();
    for (let attempt = 1; attempt <= 2 && (attempt === 1 || Date.now() - started < 20000); attempt++) {
      try {
        const { status, value } = await renderAndEvaluate(url, extractInPage);
        await assertPublicUrl(value.finalUrl); // the page may have redirected
        if (status && status >= 400) {
          // Often bot protection aimed at browsers: the plain HTML request below may still get through.
          browserError = `the browser received HTTP ${status}`;
          break;
        }
        if (!value.anchors.length && !value.footerPlainText) {
          browserError = 'the page rendered empty in the browser';
          break;
        }
        return { ...value, method: 'rendered' };
      } catch (err) {
        if (err instanceof CheckError) throw err;
        const hit = Object.keys(NET_ERRORS).find((k) => err.message.includes(k));
        if (hit) throw new CheckError('unavailable', `The website could not be reached (${NET_ERRORS[hit]}).`);
        browserError = err.message;
        console.error(`[website] browser attempt ${attempt} failed for ${url}: ${err.message}`);
      }
    }
  }
  // Browser trouble: fall back to the static HTML.
  const page = { ...(await fetchStatic(url)), method: 'static', browserError };
  // A page with no scripts cannot build a footer later, so its HTML is the final answer.
  page.hasScripts = /<script\b(?![^>]*ld\+json)[^>]*(\bsrc\s*=|>\s*[^<\s])/i.test(page.html);
  // Server-rendered pages carry their content in the HTML, so the bottom of the HTML is the bottom of the page.
  const visibleText = page.html.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  page.serverRendered = visibleText.trim().length > 80; // an app shell like <div id="root"></div> has almost none
  if (page.footerMethod === 'element' || !page.hasScripts || page.serverRendered) return page;
  // No footer in the HTML: the site is probably a single-page app. Read the footer from its JavaScript instead.
  const fromSource = await readFooterFromScripts(page.html, page.finalUrl);
  page.brandTexts = [...(page.brandTexts || []), ...(fromSource.brandTexts || [])];
  if (!fromSource.found) {
    if (!fromSource.scriptsRead) return page;
    // No footer component in the code: report what the code links to, without claiming a footer.
    return { ...page, method: 'source', footerMethod: 'none', anchors: fromSource.otherLinks, footerPlainText: '' };
  }
  return {
    ...page,
    method: 'source',
    footerMethod: 'element',
    anchors: [...page.anchors.map((a) => ({ ...a, inFooter: false })), ...fromSource.anchors],
    footerPlainText: fromSource.plainText,
  };
}

const MAX_SCRIPTS = 25;
const MAX_SCRIPT_BYTES = 4_000_000;

async function fetchScript(url) {
  try {
    await assertPublicUrl(url);
    const res = await fetchWithTimeout(url, { headers: { 'user-agent': BROWSER_UA, accept: '*/*' } }, 12000);
    if (!res.ok) return null;
    return (await res.text()).slice(0, MAX_SCRIPT_BYTES);
  } catch {
    return null;
  }
}

// Downloads the site's own scripts (and the chunks they load) and looks for the footer component in them.
async function readFooterFromScripts(html, pageUrl) {
  const queue = scriptUrls(html, pageUrl);
  const seen = new Set();
  const merged = { anchors: [], plainText: '', brandTexts: [], otherLinks: [], scriptsRead: 0 };
  let found = false;
  while (queue.length && seen.size < MAX_SCRIPTS) {
    const batch = queue.splice(0, 6).filter((u) => !seen.has(u));
    batch.forEach((u) => seen.add(u));
    const bodies = await Promise.all(batch.map(fetchScript));
    bodies.forEach((body, i) => {
      if (!body) return;
      merged.scriptsRead++;
      merged.otherLinks.push(...botchainLinksIn(body, pageUrl));
      const scan = scanBundleForFooter(body, pageUrl);
      if (scan.found) {
        found = true;
        merged.anchors.push(...scan.anchors);
        merged.plainText += scan.plainText;
      }
      if (merged.brandTexts.length < 3000) {
        for (const m of body.matchAll(/children\s*:\s*["']([^"'\\]{2,40})["']/g)) merged.brandTexts.push(m[1]);
      }
      for (const u of chunkUrls(body, batch[i], pageUrl)) if (!seen.has(u) && !queue.includes(u)) queue.push(u);
    });
  }
  return { ...merged, found };
}

// ---------- analysis ----------

export function normalizeWebsite(raw) {
  const input = String(raw || '').trim();
  if (!input) throw new CheckError('input', 'Enter your project website URL.');
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new CheckError('input', 'This is not a valid website URL. Use a full address such as https://yourproject.xyz');
  }
  if (!/^https?:$/.test(u.protocol)) throw new CheckError('input', 'The website URL must start with http:// or https://.');
  if (!u.hostname.includes('.') || /\s/.test(input)) throw new CheckError('input', 'This is not a valid website URL. Use a full address such as https://yourproject.xyz');
  return u.href;
}

const parseHref = (href) => {
  try { return new URL(href); } catch { return null; }
};

function evaluateLink(spec, page) {
  const out = { id: spec.id, label: spec.label, expected: spec.expected, status: 'FAIL', found: null, detail: '', fix: '' };
  // Sites with a footer element are checked in the footer; sites without one are checked across the whole page.
  const wholePage = page.footerMethod !== 'element';
  const footerAnchors = wholePage ? page.anchors : page.anchors.filter((a) => a.inFooter);
  const isClickable = (a) => a.rawHref && !/^\s*(#\s*$|javascript:)/i.test(a.rawHref) && parseHref(a.href);

  const correct = footerAnchors.filter((a) => isClickable(a) && spec.matches(parseHref(a.href)) && parseHref(a.href).protocol === 'https:');
  if (correct.some((a) => a.visible)) {
    out.status = 'PASS';
    out.found = correct.find((a) => a.visible).href;
    out.detail = wholePage
      ? 'Present on the page, clickable, and points to the correct URL. (The site has no footer element, so the whole page was checked.)'
      : 'Present in the footer, clickable, and points to the correct URL.';
    return out;
  }
  if (correct.length) {
    out.found = correct[0].href;
    out.detail = 'The correct link is in the footer HTML but is hidden, so visitors cannot see or click it.';
    out.fix = `Make the ${spec.label} link visible in the footer (check display, visibility and responsive breakpoints).`;
    return out;
  }

  // Links that are clearly meant to be this one, ignoring links that are correct for the other requirement.
  const others = REQUIRED_LINKS.filter((s) => s !== spec);
  const related = footerAnchors.filter((a) => {
    const u = parseHref(a.href);
    if (u && others.some((o) => o.sameSite(u))) return false;
    return (u && spec.relatedHost(u)) || spec.relatedText(a.text);
  });
  const unresolved = related.find((a) => a.dynamic);
  const notClickable = related.find((a) => !isClickable(a) && !a.dynamic);
  const wrong = related.find((a) => isClickable(a));
  if (wrong) {
    const u = parseHref(wrong.href);
    out.found = wrong.href;
    if (spec.matches(u) && u.protocol === 'http:') out.detail = `The footer link uses http:// (${wrong.href}) instead of https://.`;
    else if (/bohr\.life$/.test(u.hostname)) out.detail = `The footer link points to the testnet (${wrong.href}), not mainnet.`;
    else if (spec.sameSite(u)) out.detail = `The footer link points to a subpage (${wrong.href}) instead of ${spec.expected}`;
    else out.detail = `The footer link labelled "${wrong.text || spec.label}" points to ${wrong.href} instead of ${spec.expected}`;
    out.fix = `Change the href of the ${spec.label} footer link to ${spec.expected}`;
    return out;
  }
  if (unresolved && !notClickable) {
    out.status = 'UNABLE';
    out.detail = `A "${unresolved.text || spec.label}" link is in the footer, but its address is computed while the page runs and could not be read.`;
    out.fix = `Make sure it links to ${spec.expected}, then run the check again.`;
    return out;
  }
  if (notClickable) {
    out.found = notClickable.rawHref || null;
    out.detail = `"${notClickable.text}" appears in the footer as a link element with no real destination (href is ${notClickable.rawHref ? `"${notClickable.rawHref}"` : 'missing'}), so it does nothing when clicked.`;
    out.fix = `Give it a real destination: <a href="${spec.expected}">${spec.label}</a>`;
    return out;
  }

  const elsewhere = page.anchors.find((a) => !a.inFooter && isClickable(a) && spec.matches(parseHref(a.href)));
  const mentioned = spec.relatedText(page.footerPlainText) || (spec.id === 'botchain' ? /(?<!scan\.)botchain\.ai/i : /scan\.botchain\.ai/i).test(page.footerPlainText);
  if (mentioned) {
    out.detail = `${spec.label} is mentioned in the footer as plain text, not as a clickable link.`;
    out.fix = `Wrap the text in a link: <a href="${spec.expected}">${spec.label}</a>`;
  } else if (elsewhere) {
    out.found = elsewhere.href;
    out.detail = `A correct ${spec.label} link exists on the page, but not in the footer.`;
    out.fix = `Add <a href="${spec.expected}">${spec.label}</a> to the footer as well.`;
  } else if (wholePage) {
    out.detail = `No ${spec.label} link was found anywhere on the website.`;
    out.fix = `Add <a href="${spec.expected}">${spec.label}</a> to the site footer.`;
  } else {
    out.detail = `No ${spec.label} link was found in the footer.`;
    out.fix = `Add <a href="${spec.expected}">${spec.label}</a> to the site footer.`;
  }
  return out;
}

const HOSTING_SUFFIXES = ['vercel.app', 'netlify.app', 'github.io', 'pages.dev', 'web.app', 'firebaseapp.com', 'onrender.com', 'herokuapp.com', 'railway.app', 'fly.dev', 'surge.sh', 'glitch.me', 'replit.app', 'bolt.host', 'lovable.app', 'gitbook.io', 'webflow.io', 'framer.website', 'wixsite.com'];
const GENERIC_NAMES = /^(home|homepage|home page|welcome|index|untitled|document|loading\.*|app|dapp|dashboard|login|sign in|404|not found|page not found|coming soon|react app|vite( \+ react)?( \+ ts)?|next\.?js( app)?|create next app|svelte ?kit|nuxt|my app|website|landing( page)?|error|just a moment\.*|vite \+ react \+ ts|vite \+ vue|react \+ vite)$/i;
const SEPARATORS = /\s+[|\-–—:·•»]\s+|\s*[|–—·•»]\s*/;
const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function identifyProductName(page) {
  const host = (() => { try { return new URL(page.finalUrl).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const labels = host.split('.');
  const hosted = HOSTING_SUFFIXES.some((suffix) => host.endsWith(`.${suffix}`));
  const domainLabel = squash(hosted ? labels[0] : labels.length >= 2 ? labels[labels.length - 2] : labels[0] || '');
  const ok = (s) => s && s.length >= 2 && s.length <= 60 && !GENERIC_NAMES.test(s.trim());
  const matchesDomain = (s) => {
    const q = squash(s);
    return q.length >= 3 && domainLabel.length >= 3 && (q.includes(domainLabel) || domainLabel.includes(q));
  };

  for (const [value, source] of [
    [page.metas.ogSiteName, 'site metadata (og:site_name)'],
    [page.metas.applicationName, 'site metadata (application-name)'],
    [page.jsonLdNames[0], 'structured data (JSON-LD)'],
    [page.metas.appleTitle, 'site metadata (apple-mobile-web-app-title)'],
  ]) {
    if (ok(value)) return { name: value.trim(), source };
  }

  const segments = (page.title || '').split(SEPARATORS).map((s) => s.trim()).filter(ok);
  const byDomain = segments.find(matchesDomain);
  if (byDomain) return { name: byDomain, source: 'homepage title' };
  const logo = page.logoTexts.find((t) => ok(t) && (matchesDomain(t) || segments.some((s) => squash(s) === squash(t))));
  if (logo) return { name: logo.replace(/\s+logo$/i, ''), source: 'brand logo' };
  if (segments.length === 1 && segments[0] === page.title && segments[0].split(/\s+/).length <= 3) {
    return { name: segments[0], source: 'homepage title' };
  }
  // The site's own domain name used as a visible brand ("bountio.vercel.app" shows "Bountio").
  if (domainLabel.length >= 4) {
    const brands = (page.brandTexts || []).filter((t) => squash(t) === domainLabel);
    const best = brands.find((t) => /[a-z]/.test(t) && /[A-Z]/.test(t)) || brands[0];
    if (best) return { name: best, source: 'brand name on the page' };
  }
  return { name: null, source: null };
}

export async function checkWebsite(rawInput) {
  const result = {
    input: String(rawInput || '').trim(),
    url: null,
    finalUrl: null,
    status: 'UNABLE',
    method: null,
    footerMethod: null,
    product: { name: null, source: null },
    links: [],
    failures: [],
    error: null,
  };
  try {
    result.url = normalizeWebsite(rawInput);
    await assertPublicUrl(result.url);
    const page = await loadPage(result.url);
    result.finalUrl = page.finalUrl;
    result.method = page.method;
    result.browserError = page.browserError || null;
    result.footerMethod = page.footerMethod;
    result.product = identifyProductName(page);

    if (/^(just a moment|attention required|access denied|security check)/i.test(page.title) && page.anchors.length < 3) {
      throw new CheckError('unavailable', 'The website is behind a bot-protection challenge, so its footer could not be read.');
    }
    // Only an app shell whose scripts could not be read is unknowable: everything else has been seen in full.
    if (page.method === 'static' && page.footerMethod === 'bottom' && page.hasScripts && !page.serverRendered) {
      throw new CheckError('unavailable', 'The website\'s content is built by JavaScript files that could not be downloaded, so its links could not be checked. Please run the check again in a minute.');
    }
    if (page.method !== 'source' && !page.anchors.length && !page.footerPlainText) {
      throw new CheckError('unavailable', 'The website returned an empty page, so its footer could not be read.');
    }

    result.links = REQUIRED_LINKS.map((spec) => evaluateLink(spec, page));
    for (const link of result.links.filter((l) => l.status === 'FAIL')) {
      result.failures.push({
        requirement: `Footer links to ${link.label} (${link.expected})`,
        current: link.found ? `Found: ${link.found}` : 'Not found as a clickable footer link',
        expected: `A clickable footer link to ${link.expected}`,
        reason: link.detail,
        fix: link.fix,
      });
    }
    const unresolvedLinks = result.links.filter((l) => l.status === 'UNABLE');
    result.status = result.failures.length ? 'FAIL' : unresolvedLinks.length ? 'UNABLE' : 'PASS';
    if (result.status === 'UNABLE') result.error = unresolvedLinks.map((l) => l.detail).join(' ');
  } catch (err) {
    if (err instanceof CheckError && err.kind === 'input') {
      result.status = 'FAIL';
      result.failures.push({
        requirement: 'Valid, public website URL',
        current: result.input || 'Nothing entered',
        expected: 'A public http(s) address, e.g. https://yourproject.xyz',
        reason: err.message,
        fix: 'Enter the full public address of your project website.',
      });
    } else {
      result.status = 'UNABLE';
      result.error = err instanceof CheckError ? err.message : `Unexpected error while reading the website: ${describeError(err)}`;
    }
  }
  return result;
}
