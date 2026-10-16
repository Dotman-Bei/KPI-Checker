// Runs both checks and combines them into one result. Shared by server.mjs (local) and api/check.mjs (Vercel).
import { checkContract } from './contract.mjs';
import { checkWebsite } from './website.mjs';

// Simple per-IP limit: each check opens a website and calls BotScan many times.
const hits = new Map();
export function rateLimited(ip) {
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

export async function runCheck({ contract: contractInput, website: websiteInput } = {}) {
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
