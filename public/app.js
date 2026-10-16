// Botchain Project Checker: form handling and result rendering.
const $ = (sel) => document.querySelector(sel);
const form = $('#form');
const submit = $('#submit');
const results = $('#results');
const formError = $('#form-error');

const STATUS_TEXT = { PASS: 'PASS', FAIL: 'FAIL', UNABLE: 'UNABLE TO VERIFY' };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Tiny element builder; all text goes in as text nodes, never as HTML.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const tag = (status) => h('span', { class: `tag is-${status}` }, STATUS_TEXT[status]);
const fmt = (n) => (n == null ? '–' : Number(n).toLocaleString('en-US'));
const shortAddr = (a) => (a && a.length > 20 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

// Shows code-like fixes (an <a href> snippet) as real code, the rest as text.
function fixText(text) {
  const parts = String(text).split(/(<a href="[^"]*">[^<]*<\/a>)/);
  return parts.map((p, i) => (i % 2 ? h('code', {}, p) : p));
}

function summary(data) {
  const total = data.failures.length;
  if (data.status === 'PASS') return 'Both checks passed. This project meets every requirement.';
  if (data.status === 'FAIL') {
    const extra = data.unverified.length ? ' One check could not be verified either.' : '';
    return `${total} requirement${total === 1 ? '' : 's'} not met. Each one is explained below with the fix.${extra}`;
  }
  return 'A check could not be completed, so this project cannot be marked as passing yet.';
}

function metric(label, value, required, complete = true) {
  const met = value != null && value >= required;
  const ratio = value == null ? 0 : Math.min(value / required, 1);
  return h('div', { class: 'metric' },
    h('div', { class: 'metric-row' },
      h('span', { class: 'metric-label' }, label),
      h('span', { class: 'metric-value' }, `${fmt(value)}${complete ? '' : '+'}`, h('small', {}, ` / ${required} needed`)),
    ),
    h('div', { class: `meter${met ? ' met' : ''}`, role: 'img', 'aria-label': `${fmt(value)} of ${required} required` }, h('span', { 'data-v': ratio })),
  );
}

function contractPanel(c) {
  const body = [];
  body.push(h('div', { class: 'check-head' }, h('h3', {}, 'Contract activity'), tag(c.status)));
  if (c.wallets != null || c.transactions != null) {
    body.push(metric('Unique wallets', c.wallets, c.required.wallets, c.walletsComplete));
    body.push(metric('Transactions', c.transactions, c.required.transactions));
  }
  if (c.status === 'UNABLE') body.push(h('p', {}, c.error));
  const notes = [];
  if (c.name) notes.push(`Contract name on BotScan: ${c.name}. `);
  if (!c.walletsComplete) notes.push('Unique wallets were counted over the latest 1,000 transactions. ');
  if (c.explorerUrl) notes.push(h('a', { href: c.explorerUrl, target: '_blank', rel: 'noopener' }, 'Open on BotScan'));
  if (notes.length) body.push(h('p', { class: 'note' }, notes));
  return h('article', { class: 'check', 'data-step': '', style: '--i:2' }, body);
}

function websitePanel(w) {
  const body = [h('div', { class: 'check-head' }, h('h3', {}, 'Website footer'), tag(w.status))];
  if (w.links.length) {
    body.push(h('div', { class: 'links' }, w.links.map((l) =>
      h('div', { class: 'link-row' },
        h('div', {}, h('h4', {}, l.label), h('p', { class: 'expected' }, `Must link to ${l.expected}`)),
        tag(l.status),
        h('p', { class: 'detail' }, l.status === 'PASS' && l.found ? `Found ${l.found}` : l.detail),
      ))));
  }
  if (w.status === 'UNABLE') body.push(h('p', {}, w.error));
  const how = { rendered: 'Checked in a real browser', static: 'Checked from the page HTML', source: 'Checked by reading the footer from the site’s JavaScript' }[w.method] || null;
  if (how) {
    const where = w.footerMethod === 'element' ? ', using the page’s footer element.' : ', using the bottom of the page (no footer element was found).';
    body.push(h('p', { class: 'note' }, how + where, w.finalUrl && w.finalUrl !== w.url ? ` The site redirected to ${w.finalUrl}.` : ''));
  }
  return h('article', { class: 'check', 'data-step': '', style: '--i:3' }, body);
}

function fixesSection(data) {
  const items = [
    ...data.failures.map((f) =>
      h('li', { class: 'fix' },
        h('p', { class: 'fix-check' }, `${f.check} · Failed`),
        h('h4', {}, f.requirement),
        h('dl', { class: 'fix-compare' },
          h('div', {}, h('dt', {}, 'Current result'), h('dd', {}, f.current)),
          h('div', {}, h('dt', {}, 'Expected'), h('dd', {}, f.expected))),
        h('p', {}, f.reason),
        h('p', { class: 'fix-action' }, 'Fix: ', fixText(f.fix)),
      )),
    ...data.unverified.map((u) =>
      h('li', { class: 'fix' },
        h('p', { class: 'fix-check' }, `${u.check} · Unable to verify`),
        h('h4', {}, `${u.check} could not be checked`),
        h('p', {}, u.reason),
        h('p', { class: 'fix-action' }, u.check === 'Website footer'
          ? 'Fix: make sure the website is public and loads without a login or bot challenge, then run the check again.'
          : 'Fix: BotScan may be busy. Wait a moment and run the check again.'),
      )),
  ];
  if (!items.length) return null;
  return h('div', { class: 'fixes', 'data-step': '', style: '--i:4' },
    h('div', {},
      h('h3', {}, 'What to fix'),
      h('p', { class: 'fixes-intro' }, 'Every failed or unverified requirement, with the current result, what is expected, and the action that resolves it.')),
    h('ol', { class: 'fix-list' }, items));
}

function render(data) {
  const verdictText = {
    PASS: 'Every requirement is met.',
    FAIL: 'At least one requirement is not met.',
    UNABLE: 'A required check could not be completed.',
  }[data.status];

  const productSub = data.product.identified ? ` (from ${data.product.source})` : ' (no reliable name on the website)';
  results.replaceChildren(...[
    h('div', { class: 'r-top' },
      h('div', { 'data-step': '', style: '--i:0' },
        h('h2', { class: `r-name${data.product.identified ? '' : ' unknown'}` }, data.product.name),
        h('dl', { class: 'r-meta' },
          h('dt', {}, 'Product name'), h('dd', {}, data.product.name, h('span', {}, productSub)),
          h('dt', {}, 'Website'), h('dd', {}, data.website.url
            ? h('a', { href: data.website.url, target: '_blank', rel: 'noopener noreferrer' }, data.website.url)
            : data.website.input || '–'),
          h('dt', {}, 'Contract'), h('dd', {}, data.contract.explorerUrl
            ? h('a', { href: data.contract.explorerUrl, target: '_blank', rel: 'noopener', title: data.contract.address }, shortAddr(data.contract.address))
            : data.contract.input || '–', h('span', {}, ' · BOT Chain mainnet')),
          h('dt', {}, 'Checked'), h('dd', {}, new Date(data.checkedAt).toLocaleString()),
        )),
      h('div', { class: `verdict is-${data.status}`, 'data-step': '', style: '--i:1' },
        h('p', { class: 'verdict-label' }, 'Overall status'),
        h('p', { class: 'verdict-value' }, STATUS_TEXT[data.status]),
        h('p', { class: 'verdict-note' }, verdictText, ' ', summary(data))),
    ),
    h('div', { class: 'checks' }, contractPanel(data.contract), websitePanel(data.website)),
    fixesSection(data),
    h('div', { class: 'again', 'data-step': '', style: '--i:5' },
      h('a', { class: 'button', href: '#check' }, 'Check another project')),
  ].filter(Boolean));
  results.hidden = false;
  results.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  // Fill the meters after they are on screen.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    results.querySelectorAll('.meter span').forEach((s) => s.style.setProperty('--v', s.dataset.v));
  }));
}

function renderError(message) {
  results.replaceChildren(
    h('div', { class: 'r-top' },
      h('div', {},
        h('h2', { class: 'r-name unknown' }, 'Check not completed'),
        h('p', { style: 'margin-top:1rem;max-width:50ch' }, message)),
      h('div', { class: 'verdict is-UNABLE' },
        h('p', { class: 'verdict-label' }, 'Overall status'),
        h('p', { class: 'verdict-value' }, STATUS_TEXT.UNABLE))),
  );
  results.hidden = false;
  results.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
}

function setLoading(on) {
  submit.disabled = on;
  submit.textContent = on ? 'Checking…' : 'Run the check';
  $('#progress').hidden = !on;
  $('#loading-bar').hidden = !on;
  form.setAttribute('aria-busy', on ? 'true' : 'false');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const contract = form.contract.value.trim();
  const website = form.website.value.trim();
  form.contract.setAttribute('aria-invalid', String(!contract));
  form.website.setAttribute('aria-invalid', String(!website));
  if (!contract || !website) {
    formError.textContent = 'Enter both the contract address and the website URL.';
    formError.hidden = false;
    (contract ? form.website : form.contract).focus();
    return;
  }
  formError.hidden = true;
  setLoading(true);
  try {
    const res = await fetch('/api/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contract, website }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.error) throw new Error(data?.error || `The checker returned an error (HTTP ${res.status}).`);
    render(data);
  } catch (err) {
    renderError(err.message === 'Failed to fetch'
      ? 'The checker could not be reached. Check your connection and try again.'
      : err.message);
  } finally {
    setLoading(false);
  }
});

for (const input of [form.contract, form.website]) {
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
}

// Section entrances, once each.
const io = new IntersectionObserver((entries) => {
  for (const en of entries) if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); }
}, { threshold: 0.15 });
document.querySelectorAll('[data-reveal]').forEach((el) => io.observe(el));
