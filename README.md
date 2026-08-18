# x402 Sentinel

[![CI](https://github.com/pplmaverick/x402-sentinel/actions/workflows/test.yml/badge.svg)](https://github.com/pplmaverick/x402-sentinel/actions/workflows/test.yml)
![Network](https://img.shields.io/badge/Base_Mainnet-8453-blue)
![Solidity](https://img.shields.io/badge/Solidity-0.8.28-purple)
![License](https://img.shields.io/badge/license-MIT-green)

The first on-chain trust scoring layer defending against x402 Attack IV (Server-Selection Attacks) — [arXiv:2605.11781](https://arxiv.org/abs/2605.11781). Purpose-built for Base: trust scores live on-chain so any contract or agent can query them directly, with no API key and no off-chain trust broker in the loop.

## 🌐 Live Demo

https://x402-sentinel.vercel.app/

---

**Deployed on Base Mainnet**

| Field | Value |
|---|---|
| Network | Base Mainnet |
| Chain ID | 8453 |
| SentinelRegistry | [`0x072A3A0C04Cf8CDcaf5B4A73a4Ed4fF5A841531f`](https://basescan.org/address/0x072A3A0C04Cf8CDcaf5B4A73a4Ed4fF5A841531f) (verified) |
| SentinelPayment | [`0xcAC5B9d2817325E78090E3Ce4b9C299C819cF953`](https://basescan.org/address/0xcAC5B9d2817325E78090E3Ce4b9C299C819cF953) (verified) |
| Frontend | [x402-sentinel.vercel.app](https://x402-sentinel.vercel.app) |

---

## Why Base-Native

This isn't ported from another chain — every design decision here answers a real gap in how x402 services get discovered and trusted today.

| Problem | Generic approach | x402 Sentinel approach |
|---|---|---|
| Attack IV has no on-chain defense | Off-chain API key lookup | Trust scores stored on Base, queryable by any contract |
| Multi-chain x402 services return mixed payTo formats | Take `accepts[0]` blindly | Scan full `accepts[]` array, filter for EVM `0x` address |
| POST-only endpoints invisible to GET scanners | Fail silently | GET → POST → x402-list.com discovery fallback |
| Verification fee creates friction | Separate payment system | Pays via the x402 protocol itself (USDC on Base) |

---

## Architecture

```
User → Frontend (React+Wagmi)
         ↓
    /api/resolve (Vercel serverless)
    [GET → POST → x402-list.com fallback]
         ↓ payTo address
    SentinelPayment.payAndVerify()
    [USDC $0.001 → trust score lookup]
         ↓
    SentinelRegistry (on-chain scores)
         ↑
    Oracle (VPS pm2, HTTP probe → updateTrustScore)
```

---

## Core Features

### On-Chain Trust Scores
Scores are written to `SentinelRegistry` on Base, not held behind an API. Any contract — or any agent's payment logic — can call `getTrustScore(address)` directly, no key, no off-chain round trip.

### Automatic Endpoint Discovery
`/api/resolve` runs a three-stage fallback: GET the given URL, then POST it, then look the host up in the x402-list.com directory and probe its first known route. Covers base URLs whose 402 only fires on a specific POST endpoint.

### Multi-Chain Service Support
x402 services can advertise several payment options in one `accepts[]` array (Solana, Base, other EVM chains). Sentinel scans the full array and takes the first entry whose `payTo` matches `^0x[a-fA-F0-9]{40}$`, instead of assuming index 0 is the right one.

### x402-Native Payment
The $0.001 verification fee is itself paid through the x402/USDC flow it's built to police — no separate billing system, no credits ledger.

---

## Deployed Contracts

**Base Mainnet (8453)**

| Contract | Address |
|---|---|
| SentinelRegistry | [`0x072A3A0C04Cf8CDcaf5B4A73a4Ed4fF5A841531f`](https://basescan.org/address/0x072A3A0C04Cf8CDcaf5B4A73a4Ed4fF5A841531f) |
| SentinelPayment | [`0xcAC5B9d2817325E78090E3Ce4b9C299C819cF953`](https://basescan.org/address/0xcAC5B9d2817325E78090E3Ce4b9C299C819cF953) |

**Base Sepolia (84532)** — testnet dry run before the mainnet deploy

| Contract | Address |
|---|---|
| SentinelRegistry | `0x072A3A0C04Cf8CDcaf5B4A73a4Ed4fF5A841531f` |
| SentinelPayment | `0xcAC5B9d2817325E78090E3Ce4b9C299C819cF953` |

Addresses are identical across both networks — same deployer wallet, same nonce sequence, same CREATE address. `SentinelPayment` is wired as an authorized reporter on `SentinelRegistry` automatically as part of the Ignition deployment module (`setAuthorizedReporter`), no manual post-deploy step.

---

## Quick Start

**Prerequisites**
- Node.js 18+
- A funded wallet on Base (or Base Sepolia for testing)

```bash
# 1. Install contract dependencies
npm install

# 2. Configure environment
cp .env.example .env
```

| Variable | Description |
|---|---|
| `PRIVATE_KEY` | Deployer wallet private key |
| `BASESCAN_API_KEY` | For contract verification |
| `BASE_RPC_URL` | Base mainnet RPC (defaults to `https://mainnet.base.org`) |
| `BASE_SEPOLIA_RPC_URL` | Base Sepolia RPC (defaults to `https://sepolia.base.org`) |

```bash
# 3. Compile
npx hardhat compile

# 4. Run tests (Solidity + TypeScript)
npx hardhat test

# 5. Deploy to Base Sepolia (also deploys SentinelRegistry + wires the reporter)
npx hardhat ignition deploy --network baseSepolia ignition/modules/SentinelPayment.ts

# 6. Deploy to Base mainnet
npx hardhat ignition deploy --network base ignition/modules/SentinelPayment.ts
```

**Frontend**

```bash
cd frontend
npm install
npm run dev
```

**Oracle**

```bash
cd oracle
npm install
pm2 start reporter.js --name x402-oracle
```

---

## Contract Interface

```solidity
// SentinelPayment
function payAndVerify(address subject) external returns (bool passed)
function withdraw(address to, uint256 amount) external onlyOwner
function usdcBalance() external view returns (uint256)

// SentinelRegistry
function verify(address subject) external onlyAuthorizedReporter returns (bool passed)
function submitReport(address subject, string calldata reason) external onlyAuthorizedReporter
function getTrustScore(address subject) external view returns (uint256)
function isBlacklisted(address subject) external view returns (bool)
function updateTrustScore(address subject, uint256 newScore) external onlyOwner
function setAuthorizedReporter(address reporter, bool authorized) external onlyOwner
```

---

## Fees & Security

**Fees**
- Verification fee: 0.001 USDC per `payAndVerify` call, paid straight to `SentinelPayment`

**Security**
- Zero-address checks on every address-typed parameter (constructor args, `subject`, `owner`, `reporter`, `withdraw` recipient)
- `onlyOwner`-gated admin functions: ownership transfer, fee withdrawal, blacklist management, trust score updates, reporter authorization
- `onlyAuthorizedReporter` gate on `SentinelRegistry.verify()` / `submitReport()` — only `SentinelPayment` (or the registry owner) can write verification receipts
- `usdc` and `registry` addresses are `immutable` in `SentinelPayment`, set once at construction
- Both contracts are Basescan-verified

---

## Implementation Notes

**POST-only endpoint discovery**
GETing a service's base URL doesn't trigger a 402 when the challenge only lives on a specific POST route (e.g. `stable-deepline.dev`). `/api/resolve` now falls back to POSTing the base URL, then to querying x402-list.com's directory (`https://x402-list.com/api/v1/services?q={domain}` — note the real API lives under `/api/v1/`, not `/api/`) for a known endpoint path to probe. The `?q=` param is a general text search, not an exact domain filter, so the result is re-checked against the hit's own `base_url` hostname before it's trusted.

**Multi-chain `accepts[]` handling**
Some x402 services list several payment options in one 402 challenge — Solana, Base, other EVM chains — in the same `accepts[]` array. Taking `accepts[0]` blindly can grab a non-EVM `payTo` (discovered via `glim.sh`, which lists a Solana offer first). Fixed by scanning the full array for the first `payTo` matching `^0x[a-fA-F0-9]{40}$`.

**RPC propagation delay**
After a USDC `approve`, the app confirms the receipt against its own configured RPC (`mainnet.base.org`) before calling `payAndVerify`. The connected wallet does its own pre-flight gas estimation against its own RPC node, which can occasionally lag behind and see a stale (zero) allowance — causing it to flag the follow-up call as "will revert" and block it client-side. A 2-second delay after the approve confirmation before submitting `payAndVerify` gives the wallet's own node time to catch up.

---

## Stack

| Layer | Technology |
|---|---|
| Smart contract | Solidity ^0.8.28 |
| Development | Hardhat 3 (Ignition deployments, Mocha + ethers.js tests) |
| Frontend | React + Vite + wagmi v2.19.5 + ConnectKit |
| Oracle | Node.js + axios + ethers.js, pm2-managed on VPS |
| Payment asset | USDC on Base (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) |

---

## Roadmap

**✅ W1 — Foundation**
- Contract design, unit tests, Base Sepolia deployment
- Base Mainnet deployment + Basescan verification
- Real USDC e2e test

**✅ W2 — Oracle + Frontend**
- Node.js oracle with HTTP probe + VPS pm2 deployment
- React frontend with wagmi v2 + ConnectKit
- `/api/resolve` with 3-stage endpoint discovery fallback
- Multi-chain `accepts[]` EVM address filtering

**⬜ W3 — Community Layer**
- Blacklist mechanism
- Community report UI
- Oracle upgrade: pull from x402-list.com live endpoints

**⬜ W4 — Integration**
- x402 Sentinel as a security layer for AI agent payment flows
- Smart contract queryable trust score interface

---

## Developer

GitHub: [pplmaverick](https://github.com/pplmaverick)
Wallet: `0xed2B...78F5`

## License

MIT
