# Security Audit Notes

## Methodology

This is a self-audit of x402 Sentinel's own codebase (contracts, oracle,
and frontend API) — not a third-party engagement. It ran in two stages
on 2026-09-22: a **Recon** pass (full structural read of every
external/public contract function, access-control matrix, fund-flow
mapping, and Redis/input-validation review across `oracle/reporter.js`
and `frontend/api/*.js`), followed by a **Deep-Audit** pass that picked
the two highest-signal findings out of Recon and verified them
concretely rather than reasoning about them in the abstract.

Scope: `contracts/SentinelRegistry.sol`, `contracts/SentinelPayment.sol`,
`oracle/reporter.js`, `frontend/api/resolve.js`, `frontend/api/scans.js`,
and the EAS attestation code added the same week.

Every finding below is labeled with how it was established:

- **CONFIRMED** — verified against a live system (a real network request
  hit an isolated test listener and its log was inspected; a value was
  read directly from mainnet via `cast call`; etc.), not inferred from
  reading code alone.
- **PLAUSIBLE-NOT-CONFIRMED** — the code path has no protection and the
  underlying mechanism is real, but the specific black-box test needed
  to observe it directly wasn't achievable safely (e.g. distinguishing
  "blocked" from "connection refused" when the only visible signal is an
  identically-worded error message, with no access to the execution
  environment's own internals to check directly).

No proof-of-concept exploit code was written against this project's own
production infrastructure beyond what was needed to observe pass/fail —
isolated test listeners on unused ports, cleaned up immediately after
each verification.

---

## Fixed

### SSRF in `/api/resolve` and oracle discovery replay (CONFIRMED, FIXED)

**The problem.** `/api/resolve` is an anonymous, unauthenticated public
endpoint. It accepted any caller-supplied URL, validated only that it
was a parseable `http`/`https` URL, and then made a real server-side
GET and POST request to it — with no host allowlist, denylist, or
private/loopback/link-local IP check of any kind. This was confirmed
live: an isolated test HTTP listener was stood up on an unused port on
our own VPS, and calling the deployed `/api/resolve` with that
listener's address produced real inbound GET and POST requests from
Vercel's own outbound IP range, landing in the listener's access log.

The same URL is subsequently written to Redis and replayed later by
`oracle/reporter.js`'s scheduled discovery cycle, running on our VPS.
On that VPS, loopback-interface traffic (`127.0.0.1`) unconditionally
bypasses the firewall's default-deny policy (`ufw`'s `ufw-before-input`
chain accepts everything on `lo` before any other rule is evaluated),
and two other services on that host (an n8n instance and an unrelated
oracle process) listen on ports bound to all interfaces — so a URL that
reaches the oracle's replay path has an unobstructed path to those
services' loopback-facing ports, confirmed by reading `ss -tlnp` and
`iptables -S` output directly (no requests were sent to those live
services to verify this — the firewall rule that would allow such a
request was read, not exercised).

**The fix.** Both `frontend/api/resolve.js` and `oracle/reporter.js` now
resolve the target hostname via DNS before making any request, and
reject it if the resolved address falls in `127.0.0.0/8`, `10.0.0.0/8`,
`172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `0.0.0.0/8`, `::1`,
`fc00::/7`, or `fe80::/10` (including IPv4-mapped IPv6 addresses). To
close the DNS-rebinding gap — where a hostname's DNS record could be
changed between the validation check and the actual request — the
validated IP is pinned for the connection itself via a custom DNS
`lookup` (an `undici` `Agent` for `resolve.js`'s `fetch`, and a Node
`http.Agent`/`https.Agent` for `reporter.js`'s `axios`), so the real
request can never re-resolve the hostname and land somewhere different
than what was checked.

**How the fix was verified.** After deploying, the exact same
methodology used to confirm the original bug was repeated against the
live endpoint: a fresh isolated test listener, same unused port. A
request for a legitimate public target still reached the listener
(GET then POST, from Vercel's outbound IP) — confirming the fix didn't
break normal operation. A request for `http://127.0.0.1:<port>/`
against the same listener produced **zero** log entries — confirming
the request was blocked before any connection was attempted. The test
listener and firewall rule were torn down immediately after.

One deployment-specific bug surfaced during this verification and was
fixed in a follow-up commit: Vercel's Node runtime backs the global
`fetch()` with its own internal `undici` instance, distinct from the
`undici` npm package the pinned dispatcher is built from — passing that
dispatcher to the global `fetch` threw on every request in production.
`resolve.js` now imports `fetch` from the `undici` package directly so
both come from the same instance.

**Commits:** `25833f3` (the SSRF fix itself), `6de1681` (the
undici-instance-mismatch correction found during live verification).

---

## Known Limitations (Not Yet Fixed)

### Oracle hot wallet is also the contract owner (CONFIRMED)

Known limitation: the oracle hot wallet is also the SentinelRegistry
contract owner.

The wallet that runs the automated 6-hour scoring cycle and the EAS
attestation pass (0xed2B5717c9b936ecC76d75401026A99143e278F5) is not a
scoped, limited-permission reporter — it is the owner of SentinelRegistry
on Base mainnet, verified on-chain via owner(). updateTrustScore() is
gated by onlyOwner, not the more limited onlyAuthorizedReporter role
that exists in the contract specifically for this purpose.

Impact if this private key is compromised: an attacker gains full
administrative control of SentinelRegistry, not merely the ability to
alter a trust score. Concretely, they could: arbitrarily blacklist or
un-blacklist any address; grant authorizedReporter status to any wallet
of their choosing (including one they control, bypassing the oracle
entirely); set any trust score for any subject; and transfer ownership
of the contract away permanently, locking the legitimate team out. This
is complete contract takeover, not a bounded data-integrity issue.

Current mitigations: the private key is stored in a .env file on the
VPS with 600 permissions (root-only read/write) — no other unprivileged
system user can read it. There is no additional isolation beyond that:
the VPS runs several unrelated processes under the same root account,
so this is host-level protection only, not process-level or
secrets-manager-level isolation. There is no HSM, no key rotation, and
no multisig on this key today.

Recommended long-term fix (not yet implemented): separate the two
roles the contract was already designed to distinguish. Move
SentinelRegistry ownership to a multisig (or at minimum a cold wallet
used only for infrequent admin actions), and grant the existing hot
wallet only the authorizedReporter role it actually needs for
day-to-day updateTrustScore()/verify() calls. This confines a hot-key
compromise to score manipulation within existing bounds, rather than
full contract takeover. This is flagged here as a known, unresolved
architectural limitation — it has not been fixed, and no interim
compensating control beyond file permissions exists today.

---

## Scope Not Covered

This audit was not exhaustive. Specifically not deep-dived:

- **`SentinelPayment.withdraw()`'s fund control.** It's `onlyOwner`-gated
  with no timelock or multisig logic in the contract itself — whether
  the actual owner address is a multisig is an off-chain fact about
  that wallet, not something the contract enforces or this audit
  independently verified.
- **Unbounded Redis key growth.** `frontend/api/resolve.js` writes an
  `endpoint-subject:{url}` key for every new subject up to the existing
  `MAX_TRACKED` cap, but there's no length limit on the URL itself, and
  no cap on how many distinct URLs can map to the same already-tracked
  subject. Observed during Recon, not carried into the Deep-Audit pass.
- **EAS attester authenticity.** The registered schema has no resolver,
  so EAS itself places no restriction on who can publish an attestation
  under it — the only thing that makes a trust-score attestation
  trustworthy is checking `attester == oracle wallet address`, which
  isn't documented or enforced anywhere a downstream consumer would see
  it before trusting an attestation read directly from EAS (as opposed
  to via Sentinel's own `/api/scans`, which only ever surfaces UIDs the
  oracle itself wrote). Flagged during Deep-Audit as medium priority,
  not investigated further this round.
