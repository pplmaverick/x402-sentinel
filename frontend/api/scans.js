// Vercel serverless function (Node runtime).
//
// Backs the shared "Recent Scans" feed. Trust score, subject address, and
// pass/fail always come straight from SentinelRegistry's on-chain `receipts`
// array — callers never get to supply those. The only thing this endpoint
// accepts from the outside is a free-text endpoint label (the URL a user
// typed, which the contracts have no concept of), and only after confirming
// the submitted txHash actually contains a Verified event for the claimed
// receiptId — so a label can't be attached to a receipt the caller didn't
// actually pay for.
//
// Label storage is a single Redis hash (receiptId -> label), pruned back to
// DISPLAY_LIMIT on every write since nothing beyond the visible window is
// ever read.

import { createPublicClient, http, decodeEventLog } from 'viem'
import { base } from 'viem/chains'
import { Redis } from '@upstash/redis'

const SENTINEL_REGISTRY_ADDRESS = '0x072A3A0C04Cf8CDcaf5B4A73a4Ed4fF5A841531f'
const SENTINEL_PAYMENT_ADDRESS = '0xcAC5B9d2817325E78090E3Ce4b9C299C819cF953'
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org'

const DISPLAY_LIMIT = 25
const MAX_LABEL_LENGTH = 200
const LABELS_KEY = 'x402-sentinel:scan-labels'
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/

const VERIFIED_EVENT = {
  type: 'event',
  name: 'Verified',
  inputs: [
    { name: 'subject', type: 'address', indexed: true },
    { name: 'reporter', type: 'address', indexed: true },
    { name: 'passed', type: 'bool', indexed: false },
    { name: 'trustScore', type: 'uint256', indexed: false },
    { name: 'receiptId', type: 'uint256', indexed: false },
  ],
}

const REGISTRY_ABI = [
  VERIFIED_EVENT,
  {
    type: 'function',
    name: 'receiptCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'receipts',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [
      { name: 'subject', type: 'address' },
      { name: 'passed', type: 'bool' },
      { name: 'trustScoreAtVerification', type: 'uint256' },
      { name: 'timestamp', type: 'uint256' },
    ],
  },
]

const client = createPublicClient({ chain: base, transport: http(BASE_RPC_URL) })
const redis = Redis.fromEnv()

// Returns the ids of the latest `DISPLAY_LIMIT` receipts, newest first.
async function latestReceiptIds() {
  const count = await client.readContract({
    address: SENTINEL_REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: 'receiptCount',
  })

  if (count === 0n) return []

  const start = count > BigInt(DISPLAY_LIMIT) ? count - BigInt(DISPLAY_LIMIT) : 0n
  const ids = []
  for (let i = count - 1n; i >= start; i--) ids.push(i)
  return ids
}

async function fetchReceipts(ids) {
  if (ids.length === 0) return []

  const results = await client.multicall({
    contracts: ids.map((id) => ({
      address: SENTINEL_REGISTRY_ADDRESS,
      abi: REGISTRY_ABI,
      functionName: 'receipts',
      args: [id],
    })),
    allowFailure: false,
  })

  return ids.map((id, i) => {
    const [subject, passed, trustScoreAtVerification, timestamp] = results[i]
    return {
      receiptId: id.toString(),
      subject,
      passed,
      score: Number(trustScoreAtVerification),
      timestamp: Number(timestamp),
    }
  })
}

// Drops any stored label whose receiptId has aged out of the display window.
async function pruneLabels(keepIds) {
  const fields = await redis.hkeys(LABELS_KEY)
  const keep = new Set(keepIds)
  const stale = fields.filter((f) => !keep.has(f))
  if (stale.length) await redis.hdel(LABELS_KEY, ...stale)
}

// The frontend posts the label right after its own RPC confirms the tx, but
// our RPC (mainnet.base.org) can lag a beat behind — getTransactionReceipt
// throws "not found" until it catches up, not because the tx is invalid.
// Same class of propagation race as the approve->payAndVerify delay above;
// retry a few times before concluding it really doesn't exist.
async function getReceiptWithRetry(txHash, attempts = 5, delayMs = 1500) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await client.getTransactionReceipt({ hash: txHash })
    } catch (err) {
      if (i === attempts - 1) throw err
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

// Confirms `txHash` is a mined call into SentinelPayment that produced a
// Verified event matching `receiptId`, so the label can be trusted.
async function verifyReceiptTx(txHash, receiptId) {
  let receipt
  try {
    receipt = await getReceiptWithRetry(txHash)
  } catch {
    return false
  }
  if (receipt.status !== 'success') return false
  if (receipt.to?.toLowerCase() !== SENTINEL_PAYMENT_ADDRESS.toLowerCase()) return false

  return receipt.logs.some((log) => {
    if (log.address.toLowerCase() !== SENTINEL_REGISTRY_ADDRESS.toLowerCase()) return false
    try {
      const decoded = decodeEventLog({ abi: [VERIFIED_EVENT], data: log.data, topics: log.topics })
      return decoded.eventName === 'Verified' && decoded.args.receiptId === receiptId
    } catch {
      return false
    }
  })
}

async function handleGet(res) {
  const ids = await latestReceiptIds()
  const receipts = await fetchReceipts(ids)

  let labels = null
  if (ids.length) {
    try {
      labels = await redis.hmget(LABELS_KEY, ...ids.map((id) => id.toString()))
    } catch {
      // Label lookup is best-effort — fall back to showing addresses only.
    }
  }

  const scans = receipts.map((r) => ({ ...r, endpointLabel: labels?.[r.receiptId] || null }))
  res.status(200).json({ scans })
}

async function handlePost(req, res) {
  const { txHash, receiptId, endpointLabel } = req.body || {}

  if (typeof txHash !== 'string' || !TX_HASH_RE.test(txHash)) {
    res.status(400).json({ error: 'Invalid txHash' })
    return
  }

  let id
  try {
    id = BigInt(receiptId)
    if (id < 0n) throw new Error('negative')
  } catch {
    res.status(400).json({ error: 'Invalid receiptId' })
    return
  }

  if (typeof endpointLabel !== 'string' || !endpointLabel.trim()) {
    res.status(400).json({ error: 'Missing endpointLabel' })
    return
  }
  const label = endpointLabel.trim().slice(0, MAX_LABEL_LENGTH)

  const isReal = await verifyReceiptTx(txHash, id)
  if (!isReal) {
    res.status(422).json({ error: 'txHash does not contain a matching Verified event' })
    return
  }

  const idKey = id.toString()
  try {
    await redis.hset(LABELS_KEY, { [idKey]: label })
  } catch {
    res.status(502).json({ error: 'Failed to store label' })
    return
  }

  try {
    const keepIds = await latestReceiptIds()
    await pruneLabels(keepIds.map((i) => i.toString()))
  } catch {
    // Pruning is best-effort; a slightly oversized label hash is harmless.
  }

  res.status(200).json({ ok: true })
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      await handleGet(res)
      return
    }
    if (req.method === 'POST') {
      await handlePost(req, res)
      return
    }
    res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    console.error(err)
    res.status(502).json({ error: 'Failed to reach chain or store' })
  }
}
