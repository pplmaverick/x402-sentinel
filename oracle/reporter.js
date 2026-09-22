import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { Redis } from '@upstash/redis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const REGISTRY_ADDRESS = '0x072A3A0C04Cf8CDcaf5B4A73a4Ed4fF5A841531f';
const REGISTRY_ABI = ['function updateTrustScore(address subject, uint256 newScore) external'];

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h — ~$0.000454/tx on Base, 30 tracked addrs/cycle keeps this ~$1/mo
const REQUEST_TIMEOUT_MS = 5000;

// Same Redis instance frontend/api/scans.js writes to (Redis.fromEnv() reads
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN). Reliability tracking below
// keys off this so the oracle and the frontend agree on which address a URL maps to.
const redis = Redis.fromEnv();

const WINDOW_SIZE = 20; // rolling checks kept per subject
const ENDPOINT_SUBJECT_PREFIX = 'x402-sentinel:endpoint-subject:';
const RELIABILITY_HISTORY_PREFIX = 'x402-sentinel:reliability-history:';
const SEEDED_FLAG_KEY = 'x402-sentinel:seeded';

const MAX_TRACKED = 30; // total distinct subjects tracked (seed + discovery + website-scan feedback)
const SEED_COUNT = 20; // one-time initial population, only when nothing is tracked yet
const SEED_SCAN_LIMIT = 60; // listed services we're willing to look at (across pages) to find SEED_COUNT resolvable ones

// EAS (Ethereum Attestation Service) — Base predeploy, same address on every
// OP Stack network (mainnet and Sepolia both verified against the official
// eas-contracts deployment artifacts before wiring this up).
const EAS_ADDRESS = '0x4200000000000000000000000000000000000021';
// Schema: address subject, uint256 score, uint64 timestamp, bytes32 refUID —
// registered non-revocable; score updates are expressed by chaining a new
// attestation's refUID to the previous one, not by revoking. Read from env
// rather than hardcoded so the same code runs against the Sepolia schema
// during testing and the mainnet schema in production without an edit.
const EAS_SCHEMA_UID = process.env.EAS_SCHEMA_UID;
const EAS_SCHEMA_TYPES = ['address', 'uint256', 'uint64', 'bytes32'];
const EAS_ZERO_UID = '0x0000000000000000000000000000000000000000000000000000000000000000';
// Independent of INTERVAL_MS (the 6h internal-mapping cadence) — attestation
// is throttled separately per the cost analysis (30 subjects x 4/day would
// run ~10x the reasoned monthly budget). Checked once per runCycle() rather
// than on its own timer so there's only ever one place issuing on-chain txs.
const EAS_ATTEST_INTERVAL_MS = 24 * 60 * 60 * 1000;
const EAS_LAST_ATTEST_AT_KEY = 'x402-sentinel:eas-last-attest-at';
const EAS_LATEST_UID_PREFIX = 'x402-sentinel:eas-latest-uid:';

const EAS_ABI = [
  'function multiAttest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value)[] data)[] multiRequests) external payable returns (bytes32[])',
  'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schema)',
];

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

// Resolves one x402-list.com service listing to a probeable {url, method}
// candidate (base_url + its first active endpoint's path). Shared by regular
// per-cycle discovery and the one-time seed below.
async function resolveServiceEndpoint(svc) {
  if (!svc.slug || typeof svc.base_url !== 'string') return null;

  let detail;
  try {
    detail = await axios.get(`${X402_LIST_BASE}/services/${encodeURIComponent(svc.slug)}`, {
      timeout: DISCOVERY_TIMEOUT_MS,
    });
  } catch {
    return null;
  }

  const endpoints = Array.isArray(detail.data?.data?.endpoints) ? detail.data.data.endpoints : [];
  const endpoint = endpoints.find((e) => e.is_active) || endpoints[0];
  if (!endpoint?.path) return null;

  try {
    const basePath = svc.base_url.replace(/\/+$/, '');
    const suffix = endpoint.path.startsWith('/') ? endpoint.path : `/${endpoint.path}`;
    const url = new URL(basePath + suffix).toString();
    return { url, method: (endpoint.method || 'GET').toUpperCase() };
  } catch {
    return null;
  }
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
    const resolved = await resolveServiceEndpoint(svc);
    if (resolved) results.push(resolved);
  }

  if (results.length === 0) {
    console.log('x402-list.com discovery returned no usable endpoints — using fallback endpoint list');
    return FALLBACK_ENDPOINTS;
  }
  return results;
}

// Real usage signal for ranking seed candidates: x402-list.com has no direct
// "popularity"/"rank" field, but assessment.traction has actual settlement
// counts (most services sit at 0; a handful — e.g. openzoo at 2629 all-time
// tx — are clearly real traffic). All-time tx count first, then 30d tx count,
// then all-time volume as tiebreakers.
function popularityScore(svc) {
  const t = svc?.assessment?.traction || {};
  return (t.tx_count_all_time || 0) * 1_000_000 + (t.tx_count_30d || 0) * 1000 + (t.volume_usd_all_time || 0);
}

// Fetches candidates across a few pages of x402-list.com (the API ignores
// ?limit and always pages at 25), ranked by real usage, and resolves them
// through checkEndpoint() until SEED_COUNT actually yield a subject. Only
// used once, when Redis has no tracked endpoints at all — see
// seedTrackedEndpoints(). Endpoints that don't resolve are skipped, not
// counted toward SEED_COUNT.
async function fetchSeedCandidates() {
  let services = [];
  try {
    for (let page = 1; page <= 3 && services.length < SEED_SCAN_LIMIT; page++) {
      const res = await axios.get(`${X402_LIST_BASE}/services`, {
        params: { page },
        timeout: DISCOVERY_TIMEOUT_MS,
      });
      const batch = Array.isArray(res.data?.data) ? res.data.data : [];
      if (!batch.length) break;
      services.push(...batch);
    }
  } catch (err) {
    console.log(`[seed] x402-list.com discovery failed: ${err.message}`);
  }

  const candidates = services.filter((s) => s.status === 'online' && s.payment_ready === true);
  candidates.sort((a, b) => popularityScore(b) - popularityScore(a));

  const results = [];
  for (const svc of candidates.slice(0, SEED_SCAN_LIMIT)) {
    const resolved = await resolveServiceEndpoint(svc);
    if (resolved) results.push(resolved);
  }

  if (results.length === 0) {
    console.log('[seed] x402-list.com discovery returned no usable endpoints — using fallback endpoint list');
    return FALLBACK_ENDPOINTS;
  }
  return results;
}

// One-time initial population of the tracking list, gated on Redis having no
// tracked endpoints at all yet (not just on the flag, so a manually-cleared
// flag can't accidentally re-seed over real data).
async function seedTrackedEndpoints() {
  const alreadySeeded = await redis.get(SEEDED_FLAG_KEY);
  if (alreadySeeded) return;

  const existingKeys = await redis.keys(`${ENDPOINT_SUBJECT_PREFIX}*`);
  if (existingKeys.length > 0) {
    await redis.set(SEEDED_FLAG_KEY, 'true');
    return;
  }

  console.log(`[seed] no tracked endpoints yet — seeding up to ${SEED_COUNT} from x402-list.com by usage...`);
  const candidates = await fetchSeedCandidates();

  let seeded = 0;
  for (const candidate of candidates) {
    if (seeded >= SEED_COUNT) break;
    const { subject } = await checkEndpoint(candidate);
    if (!subject) continue;
    await redis.set(`${ENDPOINT_SUBJECT_PREFIX}${candidate.url}`, subject);
    seeded += 1;
    console.log(`[seed] (${seeded}/${SEED_COUNT}) ${candidate.url} -> ${subject}`);
  }

  await redis.set(SEEDED_FLAG_KEY, 'true');
  console.log(`[seed] done: ${seeded}/${SEED_COUNT} endpoints seeded`);
}

// Caps tracking at MAX_TRACKED distinct subjects, evicting the ones with the
// least accumulated reliability-history first (least established = least
// costly to drop, and the next thing to re-discover if it's still active).
// Returns the resulting set of distinct tracked subjects so callers can keep
// a running count without re-scanning Redis — runCycle() uses this both to
// gate new writes during the loop and to re-sweep once at the end, since a
// single check at the start of the cycle doesn't catch subjects added while
// the cycle's discovery/write-back loop is still running.
async function enforceTrackingCap() {
  const keys = await redis.keys(`${ENDPOINT_SUBJECT_PREFIX}*`);
  if (!keys.length) return new Set();

  const subjects = await Promise.all(keys.map((key) => redis.get(key)));
  const urlsBySubject = new Map();
  keys.forEach((key, i) => {
    const subject = subjects[i];
    if (!subject) return;
    const url = key.slice(ENDPOINT_SUBJECT_PREFIX.length);
    if (!urlsBySubject.has(subject)) urlsBySubject.set(subject, []);
    urlsBySubject.get(subject).push(url);
  });

  const distinctSubjects = [...urlsBySubject.keys()];
  if (distinctSubjects.length <= MAX_TRACKED) return new Set(distinctSubjects);

  const withHistoryLen = await Promise.all(
    distinctSubjects.map(async (subject) => ({
      subject,
      historyLen: await redis.llen(`${RELIABILITY_HISTORY_PREFIX}${subject}`),
    }))
  );
  withHistoryLen.sort((a, b) => a.historyLen - b.historyLen);

  const excess = withHistoryLen.length - MAX_TRACKED;
  const evicted = new Set();
  for (const { subject, historyLen } of withHistoryLen.slice(0, excess)) {
    const urls = urlsBySubject.get(subject);
    for (const url of urls) {
      await redis.del(`${ENDPOINT_SUBJECT_PREFIX}${url}`);
    }
    evicted.add(subject);
    console.log(`[cap] evicted subject=${subject} (history=${historyLen}, urls=${urls.join(', ')}) — over MAX_TRACKED=${MAX_TRACKED}`);
  }

  return new Set(distinctSubjects.filter((subject) => !evicted.has(subject)));
}

// Every url this oracle has ever resolved a payTo for, regardless of whether
// x402-list.com is still surfacing it this cycle — so a service that briefly
// drops out of the directory's "online" list still keeps getting checked (and
// can keep failing checks) instead of silently freezing at its last score.
async function loadTrackedEndpoints() {
  let keys;
  try {
    keys = await redis.keys(`${ENDPOINT_SUBJECT_PREFIX}*`);
  } catch (err) {
    console.log(`Redis lookup for tracked endpoints failed: ${err.message}`);
    return [];
  }
  if (!keys.length) return [];

  const subjects = await Promise.all(keys.map((key) => redis.get(key)));
  return keys
    .map((key, i) => ({ url: key.slice(ENDPOINT_SUBJECT_PREFIX.length), subject: subjects[i] }))
    .filter((e) => e.subject);
}

// Records this check's pass/fail into subject's rolling window and returns the
// Laplace-smoothed reliability score. Formula fixed for Independent Reference
// Model Testing parity: score = round((passes + 1) / (total + 2) * 100).
async function recordResult(subject, passed) {
  const key = `${RELIABILITY_HISTORY_PREFIX}${subject}`;
  await redis.lpush(key, passed ? '1' : '0');
  await redis.ltrim(key, 0, WINDOW_SIZE - 1);

  const history = await redis.lrange(key, 0, -1);
  const total = history.length;
  // @upstash/redis auto-deserializes list values, turning the "1"/"0" strings
  // we pushed into JS numbers on read — compare numerically, not by strict
  // string equality, so this isn't silently 0 against real Redis.
  const passes = history.filter((v) => Number(v) === 1).length;

  return Math.round(((passes + 1) / (total + 2)) * 100);
}

// Read-only version of recordResult's scoring half — same Laplace-smoothed
// formula, but against the history as it stands right now rather than after
// pushing a new result. EAS attestation runs on its own 24h cadence, not
// tied to a probe that just happened, so it needs "what's the subject's
// current score" independent of any single check.
async function currentScore(subject) {
  const history = await redis.lrange(`${RELIABILITY_HISTORY_PREFIX}${subject}`, 0, -1);
  const total = history.length;
  const passes = history.filter((v) => Number(v) === 1).length;
  return Math.round(((passes + 1) / (total + 2)) * 100);
}

// Every subject with at least one recorded check (sampleSize >= 1) — i.e.
// every reliability-history:* key that isn't empty. UNKNOWN subjects
// (sampleSize 0) are deliberately excluded from attestation: nothing has
// been observed about them yet, so there's nothing worth putting on chain.
async function subjectsWithSampleSize() {
  let keys;
  try {
    keys = await redis.keys(`${RELIABILITY_HISTORY_PREFIX}*`);
  } catch (err) {
    console.log(`[eas] Redis lookup for reliability-history failed: ${err.message}`);
    return [];
  }
  if (!keys.length) return [];

  const lens = await Promise.all(keys.map((key) => redis.llen(key)));
  return keys
    .map((key, i) => ({ subject: key.slice(RELIABILITY_HISTORY_PREFIX.length), sampleSize: lens[i] }))
    .filter((e) => e.sampleSize >= 1);
}

// Runs the EAS attestation pass if EAS_ATTEST_INTERVAL_MS has elapsed since
// the last one (tracked in Redis, independent of the 6h scan cadence this is
// called from). Batches every qualifying subject into a single multiAttest()
// call, chaining each subject's refUID to its own previous attestation UID
// (also in Redis) rather than revoking — see EAS_SCHEMA_UID's comment.
async function maybeRunEasAttestCycle(wallet) {
  if (!EAS_SCHEMA_UID) {
    console.log('[eas] EAS_SCHEMA_UID not set — skipping attestation pass');
    return;
  }

  const lastAttestAt = await redis.get(EAS_LAST_ATTEST_AT_KEY);
  const elapsed = lastAttestAt ? Date.now() - Number(lastAttestAt) : Infinity;
  if (elapsed < EAS_ATTEST_INTERVAL_MS) {
    console.log(`[eas] last attestation ${Math.round(elapsed / 3600_000)}h ago — waiting for 24h`);
    return;
  }

  const candidates = await subjectsWithSampleSize();
  if (!candidates.length) {
    console.log('[eas] no subjects with sampleSize >= 1 yet — skipping this pass');
    return;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();

  const subjects = [];
  const attestationData = [];
  for (const { subject } of candidates) {
    const score = await currentScore(subject);
    const refUID = (await redis.get(`${EAS_LATEST_UID_PREFIX}${subject}`)) || EAS_ZERO_UID;

    subjects.push(subject);
    attestationData.push({
      recipient: subject,
      expirationTime: 0,
      revocable: false,
      refUID,
      data: abiCoder.encode(EAS_SCHEMA_TYPES, [subject, score, timestamp, refUID]),
      value: 0,
    });
  }

  console.log(`[eas] attesting ${subjects.length} subject(s) via multiAttest`);

  const eas = new ethers.Contract(EAS_ADDRESS, EAS_ABI, wallet);
  let receipt;
  try {
    const tx = await eas.multiAttest([{ schema: EAS_SCHEMA_UID, data: attestationData }]);
    console.log(`[eas] multiAttest tx sent: ${tx.hash}`);
    receipt = await tx.wait();
    console.log(`[eas] confirmed in block ${receipt.blockNumber}`);
  } catch (err) {
    console.log(`[eas] multiAttest failed: ${err.message}`);
    return;
  }

  // Attested events fire in the same order multiAttest() processed
  // attestationData, one per entry — zip them back to `subjects` by position
  // rather than matching on-chain data, since uid isn't indexed (it's in the
  // event's non-indexed data, not a topic we could filter/match on directly).
  const iface = new ethers.Interface(EAS_ABI);
  const uids = receipt.logs
    .map((log) => {
      try {
        return iface.parseLog(log);
      } catch {
        return null;
      }
    })
    .filter((parsed) => parsed?.name === 'Attested')
    .map((parsed) => parsed.args.uid);

  if (uids.length !== subjects.length) {
    console.log(`[eas] expected ${subjects.length} Attested events, got ${uids.length} — refUID chain may be incomplete this round`);
  }

  for (let i = 0; i < uids.length; i++) {
    await redis.set(`${EAS_LATEST_UID_PREFIX}${subjects[i]}`, uids[i]);
  }
  await redis.set(EAS_LAST_ATTEST_AT_KEY, String(Date.now()));
  console.log(`[eas] recorded ${uids.length} new attestation UID(s)`);
}

async function runCycle(registry, wallet) {
  console.log(`\n=== scan cycle ${new Date().toISOString()} ===`);

  await seedTrackedEndpoints();
  // trackedSubjects is kept in sync (added to, below) as the loop writes new
  // subjects, so the MAX_TRACKED check stays accurate for the rest of this
  // cycle without re-scanning Redis on every candidate.
  const trackedSubjects = await enforceTrackingCap();

  const discovered = await fetchActiveEndpoints();
  const tracked = await loadTrackedEndpoints();

  // Merge by url, deduped. Freshly-discovered candidates keep their declared
  // method; url-only-known-from-Redis candidates fall back to checkEndpoint's
  // own GET-then-POST default since we don't persist method.
  const merged = new Map();
  for (const c of discovered) merged.set(c.url, { url: c.url, method: c.method });
  for (const t of tracked) {
    if (!merged.has(t.url)) merged.set(t.url, { url: t.url, method: undefined });
  }

  for (const candidate of merged.values()) {
    const { url, status, subject: resolvedSubject } = await checkEndpoint(candidate);

    let subject = resolvedSubject;
    let passed;

    if (subject) {
      // This check resolved a non-zero payTo — a pass, and the address this
      // url should be tracked under from now on.
      passed = true;
      const subjectKey = `${ENDPOINT_SUBJECT_PREFIX}${url}`;
      const stored = await redis.get(subjectKey);
      if (stored !== subject) {
        // A subject already in trackedSubjects (existing address, just a new
        // or changed url pointing at it) is always fine to write — it can't
        // push distinct-subject count past MAX_TRACKED. Only a brand-new
        // subject needs the cap check, since enforceTrackingCap() only ran
        // once at the top of this cycle and won't see writes made since.
        if (!trackedSubjects.has(subject) && trackedSubjects.size >= MAX_TRACKED) {
          console.log(`[cap] skipped new subject=${subject} url=${url} — already at MAX_TRACKED=${MAX_TRACKED}`);
          continue;
        }
        await redis.set(subjectKey, subject);
        trackedSubjects.add(subject);
        if (stored) {
          console.log(`[${url}] payTo changed from ${stored} to ${subject} — tracking under the new address`);
        }
      }
    } else {
      // No payTo this round. Only counts as a failure if we already know an
      // address for this url; otherwise there's nothing to attribute it to.
      passed = false;
      subject = await redis.get(`${ENDPOINT_SUBJECT_PREFIX}${url}`);
      if (!subject) {
        console.log(`[${url}] status=${status ?? 'n/a'} no known subject yet — skipping`);
        continue;
      }
    }

    const score = await recordResult(subject, passed);
    console.log(`[${url}] status=${status ?? 'n/a'} passed=${passed} subject=${subject} reliability_score=${score}`);

    try {
      const tx = await registry.updateTrustScore(subject, score);
      console.log(`[${url}] updateTrustScore tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`[${url}] confirmed in block ${receipt.blockNumber}`);
    } catch (err) {
      console.log(`[${url}] on-chain update failed: ${err.message}`);
    }
  }

  // In-loop gating above only checks trackedSubjects, which can't account for
  // concurrent writes from frontend/api/resolve.js during this cycle. Re-sweep
  // once more so the cycle never ends with more than MAX_TRACKED regardless of
  // what happened while it ran.
  await enforceTrackingCap();

  // Checked every 6h cycle but only actually attests once ~24h has elapsed —
  // see EAS_ATTEST_INTERVAL_MS. Deliberately after the mapping-update loop
  // above so a failed/slow EAS pass never blocks the existing on-chain score
  // updates that matter for every request today.
  await maybeRunEasAttestCycle(wallet);
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

  await runCycle(registry, wallet);
  setInterval(() => {
    runCycle(registry, wallet).catch((err) => console.error('cycle error:', err));
  }, INTERVAL_MS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
