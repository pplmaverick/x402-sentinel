// SSRF protection shared by every place in this script that fetches a
// tracked/discovered URL (checkEndpoint()/probeOnce()). Mirrored in
// frontend/api/ssrf-guard.js — no shared-module convention exists between
// the oracle (standalone VPS script) and frontend (Vercel functions) deploy
// targets, so this is intentionally duplicated rather than imported across
// that boundary. Same two-part check as the frontend copy: resolve + reject
// private/loopback/link-local IPs, then pin the actual connection to that
// exact resolved IP so DNS rebinding between the check and the request
// can't be used to reach a blocked target that looked public a moment ago.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';

export class SSRFBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SSRFBlockedError';
  }
}

function ipv4ToInt(parts) {
  return (Number(parts[0]) << 24) | (Number(parts[1]) << 16) | (Number(parts[2]) << 8) | Number(parts[3]);
}

function inIpv4Range(ip, base, prefixLength) {
  const ipInt = ipv4ToInt(ip.split('.')) >>> 0;
  const baseInt = ipv4ToInt(base.split('.')) >>> 0;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

const BLOCKED_IPV4_RANGES = [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
  ['0.0.0.0', 8],
];

function isBlockedIPv4(ip) {
  return BLOCKED_IPV4_RANGES.some(([base, prefix]) => inIpv4Range(ip, base, prefix));
}

function isBlockedIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;

  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]);

  const firstGroup = lower.split(':')[0].padStart(4, '0');
  const firstByte = parseInt(firstGroup.slice(0, 2), 16);
  if ((firstByte & 0xfe) === 0xfc) return true; // fc00::/7
  if (firstGroup.slice(0, 2) === 'fe') {
    const secondNibble = parseInt(firstGroup[2], 16);
    if ((secondNibble & 0xc) === 0x8) return true; // fe80::/10
  }
  return false;
}

function isBlockedIP(ip, family) {
  return family === 6 ? isBlockedIPv6(ip) : isBlockedIPv4(ip);
}

// Resolves `urlString`'s hostname and validates it isn't a private/loopback/
// link-local address. Throws SSRFBlockedError (blocked host, or invalid
// URL/protocol) or returns the parsed URL plus the exact IP/family that was
// validated — callers must use that IP (via pinnedAgentFor below) for the
// actual request, not re-resolve the hostname themselves.
export async function resolveAndValidateHost(urlString) {
  const parsed = new URL(urlString);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SSRFBlockedError('blocked: unsupported protocol');
  }

  // URL.hostname keeps the brackets on an IPv6 literal (e.g. "[::1]"), which
  // dns.lookup() doesn't accept — it needs the bare address ("::1") to
  // recognize it as a literal instead of failing the lookup outright.
  const lookupHost = parsed.hostname.replace(/^\[|\]$/g, '');
  const { address, family } = await dns.promises.lookup(lookupHost, { family: 0 });
  if (isBlockedIP(address, family)) {
    throw new SSRFBlockedError('blocked: resolves to a private/reserved address');
  }

  return { url: parsed, hostname: parsed.hostname, ip: address, family };
}

function makePinnedLookup(ip, family) {
  return function pinnedLookup(hostname, options, callback) {
    if (options && options.all) {
      callback(null, [{ address: ip, family }]);
    } else {
      callback(null, ip, family);
    }
  };
}

// Node's http.Agent/https.Agent forward their constructor options (including
// `lookup`) to every net.connect()/tls.connect() they make, so an agent
// built with a pinned lookup is exactly what axios needs to keep using the
// validated IP for the request that follows.
export function pinnedAgentFor(protocol, ip, family) {
  const lookup = makePinnedLookup(ip, family);
  return protocol === 'https:' ? new https.Agent({ lookup }) : new http.Agent({ lookup });
}
