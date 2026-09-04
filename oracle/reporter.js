import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const REGISTRY_ADDRESS = '0x072A3A0C04Cf8CDcaf5B4A73a4Ed4fF5A841531f';
const REGISTRY_ABI = ['function updateTrustScore(address subject, uint256 newScore) external'];

const INTERVAL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

const X402_LIST_BASE = 'https://x402-list.com/api/v1';
const DISCOVERY_TIMEOUT_MS = 8000;
const DISCOVERY_TARGET = 8; // final candidate list size (5-10 per spec)
const DISCOVERY_SCAN_LIMIT = 20; // how many listed services we're willing to look at to fill that list

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// Hand-verified with curl on 2026-09-04 — each of these currently returns a real
// x402 402 challenge with a usable payTo (mix of body-based and header-based
// challenges, GET and POST). Used only when x402-list.com discovery fails or
// comes back empty, so the oracle still has something live to score.
const FALLBACK_ENDPOINTS = [
  { url: 'https://api.prismnetwork.tech/inference/v1/batch', method: 'GET' },
  { url: 'https://hype.fortknoxx.pro/hype/spikes', method: 'GET' },
  { url: 'https://grokzilla.shop/api/skills/json-flatten', method: 'POST' },
  { url: 'https://api.openzoo.fun/v1/chat/completions', method: 'POST' },
  { url: 'https://sentinel.rootstuff.io/x402/check', method: 'GET' },
  { url: 'https://cloudmaxi0x.com/v1/data/ohlcv', method: 'GET' },
  { url: 'https://bluskyscamdetector.onrender.com/api/x402/analyze-contract', method: 'GET' },
];

// Pulls payTo out of an x402 challenge object, whether it came from the JSON
// body or a decoded header (both use the same {payTo} / {accepts:[{payTo}]}
// shape). accepts[] can list multiple networks (e.g. Solana before Base) —
// scan all of them for the first EVM-shaped payTo rather than assuming index 0.
function payToFromChallenge(challenge) {
  if (!challenge || typeof challenge !== 'object') return null;
  if (typeof challenge.payTo === 'string' && ADDRESS_RE.test(challenge.payTo)) return challenge.payTo;
  if (Array.isArray(challenge.accepts)) {
    for (const accept of challenge.accepts) {
      if (accept && typeof accept.payTo === 'string' && ADDRESS_RE.test(accept.payTo)) {
        return accept.payTo;
      }
    }
  }
  return null;
}

// Some x402 servers put the challenge in a PAYMENT-REQUIRED / X-PAYMENT-REQUIRED
// header as base64-encoded JSON instead of (or in addition to) the response body.
function decodeHeaderChallenge(headers, headerName) {
  const raw = headers?.[headerName];
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

// x402 servers advertise payTo either in the JSON body (`payTo` or
// `accepts[].payTo`), a base64 PAYMENT-REQUIRED-style header, or a
// WWW-Authenticate header. Try all three, mirroring frontend/api/resolve.js.
function extractPayTo(response) {
  const fromBody = payToFromChallenge(response.data);
  if (fromBody) return fromBody;

  for (const headerName of ['payment-required', 'x-payment-required']) {
    const fromHeader = payToFromChallenge(decodeHeaderChallenge(response.headers, headerName));
    if (fromHeader) return fromHeader;
  }

  const authHeader = response.headers?.['www-authenticate'];
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/payTo="?(0x[a-fA-F0-9]{40})"?/);
    if (match) return match[1];
  }

  return null;
}

// Requests `url` with `method` and scores the result. Never throws — connection
// failures just come back as a zero score with no subject.
async function probeOnce(url, method) {
  let response;
  try {
    response = await axios.request({
      url,
      method,
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    });
  } catch (err) {
    return { connected: false, status: null, subject: null, score: 0, error: err.message };
  }

  let score = 40; // could connect
  const status = response.status;
  let subject = null;

  if (status === 402) {
    score += 30;
    const payTo = extractPayTo(response);

    if (!payTo) {
      console.log(`[${method} ${url}] no payTo found`);
    } else if (!ethers.isAddress(payTo)) {
      console.log(`[${method} ${url}] payTo "${payTo}" is not a valid address`);
    } else {
      score += 10; // payTo format valid
      const normalized = ethers.getAddress(payTo);
      if (normalized !== ethers.ZeroAddress) {
        score += 20; // payTo non-zero
        subject = normalized;
      } else {
        console.log(`[${method} ${url}] payTo is the zero address`);
      }
    }
  }

  return { connected: true, status, subject, score };
}

// Probes `candidate` (a discovered/fallback {url, method} entry), preferring its
// declared method first, falling back to the other of GET/POST if that attempt
// didn't yield a usable payTo (mirrors resolve.js's GET-then-POST fallback).
async function checkEndpoint(candidate) {
  const { url, method } = candidate;
  const primary = (method || 'GET').toUpperCase();
  const secondary = primary === 'GET' ? 'POST' : 'GET';

  const first = await probeOnce(url, primary);
  if (!first.connected) {
    console.log(`[${url}] connection failed: ${first.error}`);
    return { url, score: 0, status: null, subject: null };
  }

  let best = first;
  if (!first.subject) {
    const second = await probeOnce(url, secondary);
    if (second.connected && (second.subject || second.score > first.score)) {
      best = second;
    }
  }

  return { url, score: best.score, status: best.status, subject: best.subject };
}

// Builds a candidate probe list from x402-list.com's live directory: online,
// payment-ready services, resolved to one active endpoint path each (mirrors
// frontend/api/resolve.js's resolveViaX402List). Falls back to a small
// hand-verified list if the directory call fails or yields nothing usable.
async function fetchActiveEndpoints() {
  let services;
  try {
    const res = await axios.get(`${X402_LIST_BASE}/services`, { timeout: DISCOVERY_TIMEOUT_MS });
    services = Array.isArray(res.data?.data) ? res.data.data : [];
  } catch (err) {
    console.log(`x402-list.com discovery failed: ${err.message} — using fallback endpoint list`);
    return FALLBACK_ENDPOINTS;
  }

  const candidates = services.filter((s) => s.status === 'online' && s.payment_ready === true);

  const results = [];
  for (const svc of candidates.slice(0, DISCOVERY_SCAN_LIMIT)) {
    if (results.length >= DISCOVERY_TARGET) break;
    if (!svc.slug || typeof svc.base_url !== 'string') continue;

    let detail;
    try {
      detail = await axios.get(`${X402_LIST_BASE}/services/${encodeURIComponent(svc.slug)}`, {
        timeout: DISCOVERY_TIMEOUT_MS,
      });
    } catch {
      continue;
    }

    const endpoints = Array.isArray(detail.data?.data?.endpoints) ? detail.data.data.endpoints : [];
    const endpoint = endpoints.find((e) => e.is_active) || endpoints[0];
    if (!endpoint?.path) continue;

    try {
      const basePath = svc.base_url.replace(/\/+$/, '');
      const suffix = endpoint.path.startsWith('/') ? endpoint.path : `/${endpoint.path}`;
      const url = new URL(basePath + suffix).toString();
      results.push({ url, method: (endpoint.method || 'GET').toUpperCase() });
    } catch {
      continue;
    }
  }

  if (results.length === 0) {
    console.log('x402-list.com discovery returned no usable endpoints — using fallback endpoint list');
    return FALLBACK_ENDPOINTS;
  }
  return results;
}

async function runCycle(registry) {
  console.log(`\n=== scan cycle ${new Date().toISOString()} ===`);
  const endpoints = await fetchActiveEndpoints();

  for (const candidate of endpoints) {
    const { url, score, status, subject } = await checkEndpoint(candidate);
    console.log(`[${url}] status=${status ?? 'n/a'} score=${score} subject=${subject ?? 'none'}`);

    if (!subject) continue;

    try {
      const tx = await registry.updateTrustScore(subject, score);
      console.log(`[${url}] updateTrustScore tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`[${url}] confirmed in block ${receipt.blockNumber}`);
    } catch (err) {
      console.log(`[${url}] on-chain update failed: ${err.message}`);
    }
  }
}

async function main() {
  const rpcUrl = process.env.RPC_URL;
  const privateKey = process.env.PRIVATE_KEY;
  if (!rpcUrl || !privateKey) {
    throw new Error('Missing RPC_URL or PRIVATE_KEY in oracle/.env');
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const registry = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, wallet);

  console.log(`oracle wallet: ${wallet.address}`);
  console.log(`registry: ${REGISTRY_ADDRESS}`);

  await runCycle(registry);
  setInterval(() => {
    runCycle(registry).catch((err) => console.error('cycle error:', err));
  }, INTERVAL_MS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
