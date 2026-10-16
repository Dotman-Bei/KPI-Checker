// Check 1: smart contract activity on BOT Chain mainnet, read from BotScan (a Blockscout explorer).
import { CheckError, getJson } from './net.mjs';

export const MAINNET = {
  name: 'BOT Chain Mainnet',
  chainId: 677,
  explorer: 'https://scan.botchain.ai',
};
const TESTNET_HOSTS = ['scan.bohr.life', 'testnet.botchain.ai'];

export const REQUIRED_WALLETS = 5;
export const REQUIRED_TRANSACTIONS = 10;
const MAX_PAGES = 20; // 50 transactions per page: unique wallets are counted over the latest 1,000 transactions

// Accepts a bare 0x address or a link containing one. Only mainnet links are accepted.
export function parseContractInput(raw) {
  const input = String(raw || '').trim();
  if (!input) throw new CheckError('input', 'Enter a contract address or a BotScan contract link.');

  if (/^0x[0-9a-fA-F]{40}$/.test(input)) return input;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new CheckError('input', 'This is not a valid contract address. A contract address starts with 0x followed by 40 hexadecimal characters.');
  }
  const host = url.hostname.toLowerCase();
  if (TESTNET_HOSTS.includes(host)) {
    throw new CheckError('input', 'This is a testnet link. Only contracts deployed on BOT Chain mainnet (scan.botchain.ai) are accepted.');
  }
  const match = url.pathname.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/);
  if (!match) {
    throw new CheckError('input', 'No contract address was found in this link. Paste the address (0x…) or its BotScan page, e.g. https://scan.botchain.ai/address/0x…');
  }
  if (host !== 'scan.botchain.ai' && !host.endsWith('.botchain.ai')) {
    throw new CheckError('input', `Links from ${host} are not accepted. Use the address itself or its BotScan mainnet page (https://scan.botchain.ai/address/…).`);
  }
  return match[0];
}

async function countUniqueWallets(address, firstPage) {
  const self = address.toLowerCase();
  const wallets = new Set();
  let page = firstPage;
  let pagesRead = 0;
  let totalPages = 1;
  while (page) {
    pagesRead++;
    totalPages = page.total_pages ?? totalPages;
    for (const tx of page.items || []) {
      const from = tx.from?.hash?.toLowerCase();
      if (from && from !== self) wallets.add(from);
    }
    if (pagesRead >= MAX_PAGES || pagesRead >= totalPages || !(page.items || []).length) break;
    const next = await getJson(`${MAINNET.explorer}/api/v2/addresses/${address}/transactions?page=${pagesRead + 1}`);
    page = next.data;
  }
  return { count: wallets.size, complete: pagesRead >= totalPages, scannedTransactions: pagesRead * 50 };
}

export async function checkContract(rawInput) {
  const result = {
    input: String(rawInput || '').trim(),
    address: null,
    network: MAINNET.name,
    explorerUrl: null,
    name: null,
    status: 'UNABLE',
    wallets: null,
    walletsComplete: true,
    transactions: null,
    required: { wallets: REQUIRED_WALLETS, transactions: REQUIRED_TRANSACTIONS },
    failures: [],
    error: null,
  };

  try {
    const address = parseContractInput(rawInput);
    result.address = address;
    result.explorerUrl = `${MAINNET.explorer}/address/${address}`;

    const info = await getJson(`${MAINNET.explorer}/api/v2/addresses/${address}`);
    if (info.status === 404 || !info.data) {
      result.status = 'FAIL';
      result.wallets = 0;
      result.transactions = 0;
      result.failures.push({
        requirement: 'Contract deployed on BOT Chain mainnet',
        current: 'Address not found on BotScan mainnet',
        expected: 'A deployed contract on BOT Chain mainnet (chain ID 677)',
        reason: 'BotScan mainnet has no record of this address, so it has never been deployed to or used on mainnet. Testnet contracts are not accepted.',
        fix: 'Deploy the contract to BOT Chain mainnet (RPC https://rpc.botchain.ai, chain ID 677) and submit the mainnet address.',
      });
      return result;
    }
    if (!info.data.is_contract) {
      result.status = 'FAIL';
      result.failures.push({
        requirement: 'Address is a smart contract',
        current: 'Wallet address (no contract code)',
        expected: 'A deployed smart contract address',
        reason: 'This address holds no contract code on mainnet. It is a regular wallet, or the contract was never deployed here.',
        fix: 'Submit the address of your deployed contract. You can find it on BotScan in the deployment transaction under "Contract created".',
      });
      return result;
    }
    result.address = info.data.hash || address;
    result.explorerUrl = `${MAINNET.explorer}/address/${result.address}`;
    result.name = info.data.name || info.data.token?.name || null;

    const [counters, firstPage] = await Promise.all([
      getJson(`${MAINNET.explorer}/api/v2/addresses/${address}/counters`),
      getJson(`${MAINNET.explorer}/api/v2/addresses/${address}/transactions`),
    ]);
    // BotScan's counters are computed lazily and can read 0 on a cold cache; the list total is exact.
    const counts = [firstPage.data?.total_count, counters.data?.transactions_count].map(Number).filter(Number.isFinite);
    const txCount = counts.length ? Math.max(...counts) : NaN;
    if (!Number.isFinite(txCount) || !firstPage.data) {
      throw new CheckError('unavailable', 'BotScan did not return transaction data for this contract.');
    }
    const wallets = await countUniqueWallets(address, firstPage.data);
    result.transactions = txCount;
    result.wallets = wallets.count;
    result.walletsComplete = wallets.complete;

    if (wallets.count < REQUIRED_WALLETS) {
      const short = REQUIRED_WALLETS - wallets.count;
      result.failures.push({
        requirement: `At least ${REQUIRED_WALLETS} unique wallets`,
        current: `${wallets.count} unique wallet${wallets.count === 1 ? '' : 's'}`,
        expected: `${REQUIRED_WALLETS} or more unique wallets`,
        reason: `Only ${wallets.count} different wallet${wallets.count === 1 ? ' has' : 's have'} sent a transaction to this contract.`,
        fix: `Get ${short} more different wallet${short === 1 ? '' : 's'} to send a transaction to the contract (call one of its functions on mainnet).`,
      });
    }
    if (txCount < REQUIRED_TRANSACTIONS) {
      const short = REQUIRED_TRANSACTIONS - txCount;
      result.failures.push({
        requirement: `At least ${REQUIRED_TRANSACTIONS} transactions`,
        current: `${txCount} transaction${txCount === 1 ? '' : 's'}`,
        expected: `${REQUIRED_TRANSACTIONS} or more transactions`,
        reason: `The contract has ${txCount} transaction${txCount === 1 ? '' : 's'} on mainnet.`,
        fix: `Make ${short} more transaction${short === 1 ? '' : 's'} with the contract on mainnet.`,
      });
    }
    result.status = result.failures.length ? 'FAIL' : 'PASS';
  } catch (err) {
    if (err instanceof CheckError && err.kind === 'input') {
      result.status = 'FAIL';
      result.failures.push({
        requirement: 'Valid mainnet contract address',
        current: result.input || 'Nothing entered',
        expected: 'A 0x address or a scan.botchain.ai contract link',
        reason: err.message,
        fix: 'Paste your mainnet contract address (0x followed by 40 characters) or its BotScan page link.',
      });
    } else {
      result.status = 'UNABLE';
      result.error = err instanceof CheckError ? err.message : `Unexpected error while reading BotScan: ${err.message}`;
    }
  }
  return result;
}
