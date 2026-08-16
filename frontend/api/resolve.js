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

// Pulls payTo out of an x402 challenge object, whether it came from the JSON
// body or a decoded header (both use the same {payTo} / {accepts:[{payTo}]} shape).
function payToFromChallenge(challenge) {
  if (!challenge || typeof challenge !== 'object') return null
  if (typeof challenge.payTo === 'string') return challenge.payTo
  const accept = Array.isArray(challenge.accepts) ? challenge.accepts[0] : null
  if (accept && typeof accept.payTo === 'string') return accept.payTo
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

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response
  try {
    response = await fetch(parsed.toString(), { signal: controller.signal })
  } catch (err) {
    clearTimeout(timeout)
    res.status(200).json({ url, status: null, subject: null, error: `connection failed: ${err.message}` })
    return
  }
  clearTimeout(timeout)

  const status = response.status
  let body = null
  try {
    body = await response.clone().json()
  } catch {
    // Non-JSON body is fine — we still check the WWW-Authenticate header below.
  }

  const payTo = extractPayTo(body, response.headers)
  const isZeroAddress = typeof payTo === 'string' && payTo.toLowerCase() === ZERO_ADDRESS

  if (!payTo || !ADDRESS_RE.test(payTo) || isZeroAddress) {
    res.status(200).json({
      url,
      status,
      subject: null,
      error:
        status === 402
          ? isZeroAddress
            ? 'endpoint returned the zero address as payTo — skipping'
            : 'endpoint returned 402 but no valid payTo address was found'
          : 'endpoint did not return an x402 402 challenge',
    })
    return
  }

  res.status(200).json({ url, status, subject: payTo, error: null })
}
