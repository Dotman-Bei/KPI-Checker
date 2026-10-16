# Botchain Project Checker

Checks whether a Botchain project meets two requirements and shows PASS, FAIL or UNABLE TO VERIFY, with the product name, the reason for each failure and how to fix it.

1. **Contract activity (BOT Chain mainnet only):** at least 5 unique wallets and at least 10 transactions.
2. **Website footer:** clickable links to `https://botchain.ai/` and `https://scan.botchain.ai/`.

## Run

Requires Node 22+. Locally no `npm install` is needed. The one dependency is only used on Vercel.

```bash
npm start            # http://localhost:4300  (PORT=8080 npm start to change; the next free port is used if busy)
```

For the footer check the server uses a local Chrome/Chromium in headless mode, so footers built by JavaScript are seen the way a visitor sees them. It finds Chrome in the usual system paths or in Puppeteer/Playwright caches; set `CHROME_PATH` to point at one explicitly. If the browser is missing or fails to start, the checker reads the static HTML instead. If the footer isn't in the HTML (single-page apps built with React, Vite or Vue), it downloads the site's own JavaScript files and reads the footer component from the code (`lib/source-scan.mjs`). It resolves link addresses built from constants, templates and link arrays. A footer link whose address is only computed while the page runs is reported as UNABLE TO VERIFY, never as a pass. Set `CHECKER_NO_BROWSER=1` to force this mode.

## Deploy to Vercel

The repo is ready for Vercel: `public/` is served as static files and `api/check.mjs` runs as a serverless function (settings in `vercel.json`). On Vercel the footer check uses the serverless Chrome build from `@sparticuz/chromium`. When importing the project, keep Root Directory `./` and the defaults. No build command or environment variables are needed.

After deploying, open `https://<your-app>.vercel.app/api/check?diagnose=1`. It should return `"ok": true`, which means the deployment can start its browser. If it returns an error, that error is also written to the function logs.

## How each check works

**Contract.** The checker accepts a `0x…` address or a `scan.botchain.ai` link and rejects testnet links (`scan.bohr.life`). It reads BotScan's Blockscout API (`/api/v2/addresses/{address}`, `/counters` and `/transactions`):

- **Transactions:** the total that BotScan reports for the contract.
- **Unique wallets:** the distinct senders (`from`) of the contract's transactions, counted over the latest 1,000 transactions. The UI shows `+` when there are more.
- **Automatic FAIL:** an address with no contract code, or one that does not exist on mainnet.
- **UNABLE TO VERIFY:** BotScan is unreachable or returns an error.

**Website.** The checker loads the page and treats links inside `<footer>`, `[role=contentinfo]` or any element whose id or class contains "footer" as footer links. If the site has no footer element, it checks the links across the whole page. If a site's firewall (for example Vercel Security Checkpoint or Cloudflare) blocks automated visitors, the result is UNABLE TO VERIFY with an explanation; the checker does not try to get around bot protection. For each required link it reports one of these outcomes:

- correct and visible
- hidden
- wrong URL (http, testnet explorer, a subpage, or another domain)
- not clickable (`href="#"` or no href)
- plain text only
- present on the page but not in the footer
- missing

The checker treats `https://www.botchain.ai/en/` as the Botchain homepage because `https://botchain.ai/` redirects there. UNABLE TO VERIFY is reported for DNS or network failures, HTTP errors and bot-protection challenges.

**Product name.** The checker takes the name from `og:site_name`, `application-name` or JSON-LD first. Next it tries a homepage title segment that matches the domain, then a header logo's alt text. If none of these gives a reliable name, it shows **Unknown Product Name**.

**Overall.** FAIL if any requirement fails; otherwise UNABLE TO VERIFY if any check could not complete; PASS only when both checks pass.

## API

`POST /api/check` with `{"contract": "0x…", "website": "https://…"}` returns the full result as JSON.

## Notes

- Websites pointing to private or local network addresses are refused. Set `CHECKER_ALLOW_PRIVATE=1` only for local testing.
- Each client IP is limited to 10 checks per minute.
