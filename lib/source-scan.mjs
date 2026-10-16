// Reads a footer out of a single-page app's JavaScript bundles, for when no browser is available to render it.
// React/Vite/Vue builds compile the footer to calls like jsx("footer",{...jsx("a",{href:"…",children:"…"})}).
// We find the footer element in the code, then read the links (href and label) inside it, resolving
// URL constants such as `const SCAN="https://scan.botchain.ai"` and template strings like `${SCAN}/address/…`.

// Index of the bracket that closes the one at `open`, skipping strings, template literals and comments.
function matchBracket(s, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [pairs[s[open]]];
  for (let i = open + 1; i < s.length && i < open + 400_000; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++;
    } else if (c === '`') {
      for (i++; i < s.length && s[i] !== '`'; i++) {
        if (s[i] === '\\') i++;
        else if (s[i] === '$' && s[i + 1] === '{') i = matchBracket(s, i + 1);
        if (i < 0) return -1;
      }
    } else if (c === '/' && s[i + 1] === '*') {
      i = s.indexOf('*/', i + 2) + 1;
      if (i <= 0) return -1;
    } else if (pairs[c]) {
      stack.push(pairs[c]);
    } else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

// Reads the expression after `key:` up to the next top-level comma or closing brace.
function readValue(s, from) {
  let i = from;
  while (s[i] === ' ') i++;
  const start = i;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === ',' || c === '}' || c === ')' || c === ']') break;
    if (c === '(' || c === '[' || c === '{') { i = matchBracket(s, i); if (i < 0) return null; continue; }
    if (c === '"' || c === "'") { for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++; continue; }
    if (c === '`') {
      for (i++; i < s.length && s[i] !== '`'; i++) {
        if (s[i] === '\\') i++;
        else if (s[i] === '$' && s[i + 1] === '{') { i = matchBracket(s, i + 1); if (i < 0) return null; }
      }
      continue;
    }
  }
  return s.slice(start, i).trim();
}

const unquote = (v) => v.slice(1, -1).replace(/\\(.)/g, '$1');

// Splits `a+"b"+c` at top-level plus signs.
function splitConcat(expr) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"' || c === "'") { for (i++; i < expr.length && expr[i] !== c; i++) if (expr[i] === '\\') i++; }
    else if (c === '`') { for (i++; i < expr.length && expr[i] !== '`'; i++) if (expr[i] === '\\') i++; }
    else if (c === '(' || c === '[' || c === '{') { i = matchBracket(expr, i); if (i < 0) return [expr]; }
    else if (c === '+') { parts.push(expr.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(expr.slice(start).trim());
  return parts;
}

function resolveExpr(expr, consts) {
  if (!expr) return null;
  const parts = splitConcat(expr);
  if (parts.length > 1) {
    const resolved = parts.map((p) => resolveExpr(p, consts));
    return resolved.every((r) => r !== null) ? resolved.join('') : null;
  }
  if (/^(["'])[\s\S]*\1$/.test(expr)) return unquote(expr);
  if (/^`[\s\S]*`$/.test(expr)) {
    let ok = true;
    const out = expr.slice(1, -1).replace(/\$\{\s*([\w$.]+)\s*\}/g, (_, name) => {
      if (consts.has(name)) return consts.get(name);
      ok = ok && false;
      return `{${name}}`;
    });
    // A template that starts with a known URL is still a usable link even if its tail is dynamic.
    return ok || /^https?:\/\//.test(out) ? out : null;
  }
  if (/^[\w$.]+$/.test(expr) && consts.has(expr)) return consts.get(expr);
  return null;
}

// Props of every jsx("a",{…}) / createElement("a",{…}) / h("a",{…}) call inside `region`.
function anchorsIn(region, consts) {
  const anchors = [];
  const re = /\(\s*["']a["']\s*,\s*\{/g;
  let m;
  while ((m = re.exec(region))) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(region, open);
    if (close < 0) continue;
    const props = region.slice(open, close + 1);
    // createElement("a", {…}, "label"): the label follows the props.
    const trailing = (region.slice(close + 1, close + 200).match(/^\s*,\s*(["'`])([^"'`]{1,80})\1/) || [])[2] || '';
    const hrefAt = props.search(/[{,]\s*href\s*:/);
    const rawExpr = hrefAt >= 0 ? readValue(props, props.indexOf(':', hrefAt) + 1) : null;
    const href = resolveExpr(rawExpr, consts);
    const textMatch = props.match(/children\s*:\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/);
    const nestedText = [...props.matchAll(/children\s*:\s*["']([^"']{2,60})["']/g)].map((x) => x[1]).join(' ');
    anchors.push({
      rawHref: href ?? (rawExpr || null),
      href: href || '',
      dynamic: Boolean(rawExpr) && !href,
      text: (textMatch ? textMatch[2] : nestedText) || trailing || (props.match(/["']aria-label["']\s*:\s*["']([^"']+)/) || [])[1] || '',
      inFooter: true,
      visible: true,
    });
    re.lastIndex = close;
  }
  return anchors;
}

// Link data defined in arrays that the footer maps over: [{label:"BotScan",href:"https://…"}].map(…)
function mappedLinks(region, bundle, consts) {
  const links = [];
  for (const [, name] of region.matchAll(/([\w$]+)\.map\(/g)) {
    const def = bundle.search(new RegExp(`[\\s,;{(]${name.replace(/\$/g, '\\$')}\\s*=\\s*\\[`));
    if (def < 0) continue;
    const open = bundle.indexOf('[', def);
    const close = matchBracket(bundle, open);
    if (close < 0 || close - open > 20_000) continue;
    const arr = bundle.slice(open, close + 1);
    for (const obj of arr.matchAll(/\{[^{}]*\}/g)) {
      const o = obj[0];
      const key = o.match(/(?:href|url|link|to)\s*:/);
      if (!key) continue;
      const href = resolveExpr(readValue(o, o.indexOf(':', key.index) + 1), consts);
      if (!href) continue;
      const label = (o.match(/(?:label|name|title|text)\s*:\s*["'`]([^"'`]+)/) || [])[1] || '';
      links.push({ rawHref: href, href, text: label, inFooter: true, visible: true });
    }
  }
  return links;
}

function stringConstants(bundle) {
  const consts = new Map();
  // Short string constants (URLs, addresses, paths) that links are built from. Minified names repeat across
  // scopes, so the first URL-looking value wins over later non-URL values with the same name.
  for (const m of bundle.matchAll(/[\s,;{(]([\w$]+)\s*=\s*(["'])([^"'`\s\\]{1,200})\2/g)) {
    const [, name, , value] = m;
    if (!consts.has(name) || (/^https?:\/\//.test(value) && !/^https?:\/\//.test(consts.get(name)))) consts.set(name, value);
  }
  // Settings objects: CONFIG={EXPLORER_URL:"https://…",…} lets the footer use CONFIG.EXPLORER_URL.
  for (const m of bundle.matchAll(/[\s,;{(]([\w$]+)\s*=\s*(?:Object\.freeze\(\s*)?\{/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(bundle, open);
    if (close < 0 || close - open > 50_000) continue;
    const body = bundle.slice(open, close + 1);
    if (!/https?:\/\//.test(body)) continue;
    for (const p of body.matchAll(/[{,]\s*["']?([\w$]+)["']?\s*:\s*(["'])([^"'`\s\\]{1,200})\2/g)) {
      const key = `${m[1]}.${p[1]}`;
      if (!consts.has(key)) consts.set(key, p[3]);
    }
  }
  return consts;
}

// Finds footer regions in one bundle and returns their anchors and visible text.
// Every link in a bundle whose address or label points at BOT Chain, wherever it is (used when no footer is found).
export function botchainLinksIn(bundle, pageUrl) {
  if (!/botchain|bohr\.life|bot\s*scan/i.test(bundle)) return [];
  const consts = stringConstants(bundle);
  return anchorsIn(bundle, consts)
    .map((a) => {
      try { a.href = a.href ? new URL(a.href, pageUrl).href : ''; } catch {}
      return { ...a, inFooter: false };
    })
    .filter((a) => /botchain|bohr\.life/i.test(a.href) || /bot\s*(chain|scan)/i.test(a.text));
}

export function scanBundleForFooter(bundle, pageUrl) {
  const consts = stringConstants(bundle);
  const result = { found: false, anchors: [], plainText: '' };
  const footerStarts = [
    ...bundle.matchAll(/\(\s*["']footer["']\s*,/g),                                  // jsx("footer", …)
    ...bundle.matchAll(/\(\s*["'](?:div|section|nav)["']\s*,\s*\{[^{}]{0,200}?(?:className|class|id)\s*:\s*["'][^"']*\bfooter\b/gi),
    ...bundle.matchAll(/["']contentinfo["']/g),
  ].map((m) => m.index).sort((a, b) => a - b);

  let lastEnd = -1;
  for (const start of footerStarts) {
    if (start < lastEnd) continue;
    const close = matchBracket(bundle, start);
    if (close < 0) continue;
    lastEnd = close;
    const region = bundle.slice(start, close + 1);
    result.found = true;
    for (const a of [...anchorsIn(region, consts), ...mappedLinks(region, bundle, consts)]) {
      try { a.href = a.href ? new URL(a.href, pageUrl).href : ''; } catch {}
      result.anchors.push(a);
    }
    // Text that is not inside a link: children strings minus anchor labels.
    const labels = new Set(result.anchors.map((a) => a.text));
    const texts = [...region.matchAll(/children\s*:\s*["']([^"']{2,200})["']/g)].map((x) => x[1]).filter((t) => !labels.has(t));
    result.plainText += ' ' + texts.join(' ');
  }
  return result;
}

// Script URLs referenced by the HTML (and chunk paths referenced by those scripts), same site only.
export function scriptUrls(html, pageUrl) {
  const urls = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) urls.push(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*rel\s*=\s*["'](?:modulepreload|preload)["'][^>]*href\s*=\s*["']([^"']+\.m?js[^"']*)["']/gi)) urls.push(m[1]);
  return resolveSameSite(urls, pageUrl);
}

export function chunkUrls(bundle, bundleUrl, pageUrl) {
  const rel = [...bundle.matchAll(/["'`]((?:\.{1,2}\/|\/)[\w./-]+\.m?js)["'`]/g)].map((m) => new URL(m[1], bundleUrl).href);
  const fromRoot = [...bundle.matchAll(/["'`]((?:assets|static|_next\/static|js)\/[\w./-]+\.m?js)["'`]/g)].map((m) => new URL(`/${m[1]}`, pageUrl).href);
  return resolveSameSite([...rel, ...fromRoot], pageUrl);
}

// "app.example.co.uk" -> "example.co.uk"; good enough to keep a site's own CDN subdomains and skip third parties.
function baseDomain(host) {
  const parts = host.toLowerCase().split('.');
  const n = parts.length >= 3 && parts.at(-1).length === 2 && parts.at(-2).length <= 3 ? 3 : 2;
  return parts.slice(-n).join('.');
}

function resolveSameSite(list, pageUrl) {
  const site = baseDomain(new URL(pageUrl).hostname);
  const out = [];
  for (const u of list) {
    try {
      const abs = new URL(u, pageUrl);
      if (baseDomain(abs.hostname) === site && !out.includes(abs.href)) out.push(abs.href);
    } catch {}
  }
  return out;
}
