import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const REGISTRY_ADDRESS = '0x072A3A0C04Cf8CDcaf5B4A73a4Ed4fF5A841531f';
const REGISTRY_ABI = ['function updateTrustScore(address subject, uint256 newScore) external'];

const ENDPOINTS = [
  'https://x402.org',
  'https://api.cdp.coinbase.com',
  'https://api.developer.coinbase.com',
  'https://x402-demo.vercel.app',
  'https://httpbin.org/status/402',
];

const INTERVAL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

// x402 servers advertise payTo either in the JSON body (`payTo` or `accepts[].payTo`)
// or in a WWW-Authenticate header. Try both.
function extractPayTo(response) {
  const body = response.data;
  if (body && typeof body === 'object') {
    if (typeof body.payTo === 'string') return body.payTo;
    const accept = Array.isArray(body.accepts) ? body.accepts[0] : null;
    if (accept && typeof accept.payTo === 'string') return accept.payTo;
  }

  const authHeader = response.headers?.['www-authenticate'];
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/payTo="?(0x[a-fA-F0-9]{40})"?/);
    if (match) return match[1];
  }

  return null;
}

async function checkEndpoint(url) {
  let response;
  try {
    response = await axios.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    });
  } catch (err) {
    console.log(`[${url}] connection failed: ${err.message}`);
    return { url, score: 0, status: null, subject: null };
  }

  let score = 40; // could connect
  const status = response.status;
  let subject = null;

  if (status === 402) {
    score += 30;
    const payTo = extractPayTo(response);

    if (!payTo) {
      console.log(`[${url}] no payTo found, skipping`);
    } else if (!ethers.isAddress(payTo)) {
      console.log(`[${url}] payTo "${payTo}" is not a valid address, skipping`);
    } else {
      score += 10; // payTo format valid
      const normalized = ethers.getAddress(payTo);
      if (normalized !== ethers.ZeroAddress) {
        score += 20; // payTo non-zero
        subject = normalized;
      } else {
        console.log(`[${url}] payTo is the zero address, skipping`);
      }
    }
  }

  return { url, score, status, subject };
}

async function runCycle(registry) {
  console.log(`\n=== scan cycle ${new Date().toISOString()} ===`);
  for (const url of ENDPOINTS) {
    const { score, status, subject } = await checkEndpoint(url);
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
