// Vercel serverless function (Node runtime).
//
// SentinelPayment.payAndVerify(address subject) takes an on-chain address, not a URL —
// there is no endpoint->address mapping in the contracts. x402 servers advertise their
// payTo address in the 402 response body or WWW-Authenticate header, so this resolves
// a scanned endpoint URL to that address server-side (mirrors oracle/reporter.js's
// extractPayTo), avoiding the CORS failures a browser-side fetch would hit against
// arbitrary third-party APIs.

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const REQUEST_TIMEOUT_MS = 6000
const X402_LIST_BASE = 'https://x402-list.com/api/v1'

// Pulls payTo out of an x402 challenge object, whether it came from the JSON
// body or a decoded header (both use the same {payTo} / {accepts:[{payTo}]} shape).
// accepts[] can list multiple networks (e.g. Solana before Base) — scan all of
// them for the first EVM-shaped payTo rather than assuming index 0 is ours.
function payToFromChallenge(challenge) {
  if (!challenge || typeof challenge !== 'object') return null
  if (typeof challenge.payTo === 'string' && ADDRESS_RE.test(challenge.payTo)) return challenge.payTo
  if (Array.isArray(challenge.accepts)) {
    for (const accept of challenge.accepts) {
      if (accept && typeof accept.payTo === 'string' && ADDRESS_RE.test(accept.payTo)) {
        return accept.payTo
      }
    }
  }
  return null
}

// Some x402 servers (e.g. PocketFactory) put the challenge in a
// PAYMENT-REQUIRED / X-PAYMENT-REQUIRED header as base64-encoded JSON instead
// of (or in addition to) the response body.
function decodeHeaderChallenge(headers, headerName) {
  const raw = headers.get(headerName)
  if (!raw) return null
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'))
  } catch {
    return null
  }
}

function extractPayTo(body, headers) {
  const fromBody = payToFromChallenge(body)
  if (fromBody) return fromBody

  for (const headerName of ['payment-required', 'x-payment-required']) {
    const fromHeader = payToFromChallenge(decodeHeaderChallenge(headers, headerName))
    if (fromHeader) return fromHeader
  }

  const authHeader = headers.get('www-authenticate')
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/payTo="?(0x[a-fA-F0-9]{40})"?/)
    if (match) return match[1]
  }

  return null
}

function isUsablePayTo(payTo) {
  return typeof payTo === 'string' && ADDRESS_RE.test(payTo) && payTo.toLowerCase() !== ZERO_ADDRESS
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

// Requests `url` with `method` and extracts a payTo from whatever comes back.
// Never throws — connection failures just surface as a null payTo.
async function probe(url, method) {
  let response
  try {
    response = await fetchWithTimeout(url, { method })
  } catch (err) {
    return { status: null, payTo: null, error: `connection failed: ${err.message}` }
  }

  const status = response.status
  let body = null
  try {
    body = await response.clone().json()
  } catch {
    // Non-JSON body is fine — we still check the WWW-Authenticate header below.
  }

  return { status, payTo: extractPayTo(body, response.headers), error: null }
}

// Base URLs (e.g. https://stable-deepline.dev) commonly 402 only on a specific
// POST route, not on GET /. When direct probing finds nothing, look the host up
// in the x402-list.com directory and probe the first endpoint route it lists.
async function resolveViaX402List(parsed) {
  const domain = parsed.hostname

  let searchRes
  try {
    searchRes = await fetchWithTimeout(`${X402_LIST_BASE}/services?q=${encodeURIComponent(domain)}`)
  } catch {
    return null
  }
  if (!searchRes.ok) return null

  let searchBody
  try {
    searchBody = await searchRes.json()
  } catch {
    return null
  }

  // ?q= is a general text search (name/description match too), so confirm the
  // hit's own base_url hostname actually matches before trusting its endpoints.
  const services = Array.isArray(searchBody?.data) ? searchBody.data : []
  const match = services.find((svc) => {
    try {
      return new URL(svc.base_url).hostname === domain
    } catch {
      return false
    }
  })
  if (!match?.slug) return null

  let detailRes
  try {
    detailRes = await fetchWithTimeout(`${X402_LIST_BASE}/services/${encodeURIComponent(match.slug)}`)
  } catch {
    return null
  }
  if (!detailRes.ok) return null

  let detailBody
  try {
    detailBody = await detailRes.json()
  } catch {
    return null
  }

  const endpoints = Array.isArray(detailBody?.data?.endpoints) ? detailBody.data.endpoints : []
  const endpoint = endpoints.find((e) => e.is_active) || endpoints[0]
  if (!endpoint?.path) return null

  // endpoint.path (e.g. "/onchain/networks/{id}/trending_pools") is a suffix to
  // append to base_url's own path, not a path relative to the origin — base_url
  // routes commonly have their own prefix (e.g. "/api/v3/x402"), and resolving
  // via `new URL(path, base_url)` silently drops that prefix whenever path
  // starts with "/" (standard relative-URL resolution treats a leading "/" as
  // origin-relative), landing on the wrong route entirely.
  let target
  try {
    const basePath = match.base_url.replace(/\/+$/, '')
    const suffix = endpoint.path.startsWith('/') ? endpoint.path : `/${endpoint.path}`
    target = new URL(basePath + suffix).toString()
  } catch {
    return null
  }

  return probe(target, (endpoint.method || 'POST').toUpperCase())
}

export default async function handler(req, res) {
  const url = req.query?.url

  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'Missing "url" query parameter' })
    return
  }

  let parsed
  try {
    parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported protocol')
    }
  } catch {
    res.status(400).json({ error: 'Invalid endpoint URL' })
    return
  }

  const target = parsed.toString()

  let result = await probe(target, 'GET')
  if (!isUsablePayTo(result.payTo)) {
    result = await probe(target, 'POST')
  }
  if (!isUsablePayTo(result.payTo)) {
    const viaList = await resolveViaX402List(parsed)
    if (viaList && isUsablePayTo(viaList.payTo)) {
      result = viaList
    }
  }

  const isZeroAddress = typeof result.payTo === 'string' && result.payTo.toLowerCase() === ZERO_ADDRESS

  if (!isUsablePayTo(result.payTo)) {
    res.status(200).json({
      url,
      status: result.status,
      subject: null,
      error:
        result.status === 402
          ? isZeroAddress
            ? 'endpoint returned the zero address as payTo — skipping'
            : 'endpoint returned 402 but no valid payTo address was found'
          : 'endpoint did not return an x402 402 challenge (GET/POST) and no known endpoint was found via x402-list.com',
    })
    return
  }

  res.status(200).json({ url, status: result.status, subject: result.payTo, error: null })
}
