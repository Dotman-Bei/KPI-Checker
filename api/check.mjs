// Vercel serverless function for POST /api/check. Locally, server.mjs serves the same endpoint.
import { rateLimited, runCheck } from '../lib/check.mjs';
import { diagnoseBrowser } from '../lib/browser.mjs';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  // GET /api/check?diagnose=1 confirms the deployment can start its browser.
  if (req.method === 'GET' && req.query?.diagnose) return res.status(200).json(await diagnoseBrowser());
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress;
  if (rateLimited(ip)) return res.status(429).json({ error: 'Too many checks. Wait a minute and try again.' });
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'The request could not be read.' }); }
  }
  try {
    return res.status(200).json(await runCheck(body || {}));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
  }
}
