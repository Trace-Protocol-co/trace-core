# TRACE Protocol

> **"HTTPS for Media"** — Decentralized cryptographic provenance infrastructure built on Sui + Walrus.

[![Live](https://img.shields.io/badge/Live-traceprotocol.co-10b981)](https://www.traceprotocol.co)
[![API](https://img.shields.io/badge/API-Render-3b82f6)](https://trace-cbvb.onrender.com/v1/health)
[![Tests](https://img.shields.io/badge/Move%20Tests-19%2F19-10b981)](./move)
[![Network](https://img.shields.io/badge/Network-Sui%20Testnet-6fbcf0)](https://suiexplorer.com)

---

## Problem

**3.5 billion images** are shared online every day. Deepfakes increased **900% in 2023**. By 2026 synthetic media will be indistinguishable to the human eye. There is no open, decentralised way to answer:

> *"Who created this media, when, and has it been modified?"*

Adobe's C2PA standard exists but is **centralized** — companies can alter or revoke records. TRACE anchors provenance on **Sui blockchain**: immutable, permissionless, and verifiable by anyone forever.

---

## What TRACE Does

TRACE is a four-layer protocol:

```
Layer 1 — REGISTRATION      Anchor media hash + metadata on Sui blockchain
Layer 2 — VERIFICATION      Anyone can verify any file against the registry (free)
Layer 3 — PROVENANCE        Full edit chain graph — who modified what and when
Layer 4 — ECONOMICS         Staking to prevent backdated timestamp fraud
```

### Features

| # | Feature | Description |
|---|---------|-------------|
| F-1 | **Media Registration** | SHA-256 + pHash + device signature anchored on Sui. Blob stored on Walrus. |
| F-2 | **Provenance Graph** | Directed acyclic graph of all edits and derivatives, fully on-chain. |
| F-3 | **Verification** | Upload any file → get verdict: VERIFIED / MODIFIED / NOT IN REGISTRY / AI GENERATED |
| F-4 | **Browser Extension** | Auto-scans every image on every webpage. Trust badges. Chrome MV3. |
| F-5 | **Certificates** | Auto-generated HTML certificate with QR code per registration. |
| F-6 | **Delegation** | Newsrooms delegate signing authority to reporters. OrgRoot → DelegationRecord. |
| F-7 | **zkLogin** | No crypto wallet needed. Journalists sign in with Google. Gas sponsored by TRACE. |
| F-8 | **Temporal Staking** | Stake SUI to claim old timestamps. 7-day challenge window. Fraud is expensive. |

---

## Architecture

```
                    PRODUCERS                           CONSUMERS
              (Journalists, Creators)              (Anyone on the internet)
                       │                                     │
               Sign in with Google                    No sign-in needed
               (zkLogin — no wallet)                  Free, instant reads
                       │                                     │
              ┌────────▼─────────────────────────────▼───────┐
              │          TRACE Backend (Node.js + Express)    │
              │                                               │
              │  • SHA-256 hash computation                   │
              │  • Perceptual hash (pHash)                    │
              │  • AI score estimation                        │
              │  • Walrus blob upload                         │
              │  • Sui transaction builder + broadcaster      │
              │  • PostgreSQL registry (persistent)           │
              └────────┬─────────────────────────┬───────────┘
                       │                         │
              ┌────────▼────────┐    ┌───────────▼──────────┐
              │  Walrus Storage │    │     Sui Testnet       │
              │  (blobs)        │    │                       │
              │  Decentralised  │    │  MediaRecord (obj)    │
              │  Censorship-    │    │  EditRecord (obj)     │
              │  resistant      │    │  OrgRoot (obj)        │
              └─────────────────┘    │  DelegationRecord     │
                                     │  StakeDeposit         │
                                     │  Treasury (shared)    │
                                     └──────────────────────┘
```

---

## Smart Contracts

**Network:** Sui Testnet  
**Package:** `0x3eff0f24ece1bd96bef48ba534eb498331a87cb1fb90d30de5bf1ec940cc648e`  
**Treasury:** `0x5dcd795b9b23e0344608b92d58f2a0c0438558243ce5db9c821292f90df9a54a`  
**Deployment TX:** `7YKKSowaBdkDWHPL1xtVYao4YzXbtcqvHbJrpL82N5YQ`

### Module: `media.move`
Core provenance. Every registered file creates a `MediaRecord` object on Sui.

**MediaRecord fields:**
- `blob_id` — Walrus blob reference
- `content_hash` — SHA-256 of raw bytes (exact integrity proof)
- `perceptual_hash` — pHash for similarity detection across re-encodes
- `device_signature` — cryptographic proof of capture device identity
- `creator` — wallet address (or zkLogin identity)
- `timestamp` — `sui::clock::Clock` value (consensus-anchored, unforgeable)
- `walrus_cert` — Walrus storage certificate
- `gps` — optional, user-controlled capture location
- `ai_score` — AI generation probability at registration time (0–10,000 basis points)
- `parent` — `Option<ID>` — null for originals, parent `MediaRecord` ID for derivatives
- `edit_type` — enum: ORIGINAL / TRIM / COLOR_GRADE / SUBTITLE / AI_REMIX / CROP / MERGE / TRANSLATE
- `integrity` — enum: ORIGINAL / MODIFIED / UNVERIFIED / AI_GENERATED
- `revoked` — bool

### Module: `delegation.move`
Organisation → reporter trust hierarchy.

**Why it's needed:** BBC has 500 journalists. Each needs to sign media under the BBC brand. Without delegation, anyone could claim to be BBC. Delegation solves this:
- BBC creates one `OrgRoot` object (owns it)
- Issues `DelegationRecord` objects to each journalist
- Content signed by a journalist is traceable to BBC's root
- If a journalist leaves, BBC revokes their delegation — future registrations blocked, past content stays valid

### Module: `staking.move`
Anti-backdating economic mechanism.

**Why it's needed:** Without staking, anyone could register a deepfake today but claim the timestamp was 5 years ago ("this photo is from 2019"). Staking makes this expensive:
- 72h free window — no stake for recent media
- Beyond 72h: 50 SUI per extra day of claimed backdating
- 7-day challenge window — anyone can dispute with evidence
- Successful challenge: 70% of stake to challenger, 30% to Treasury
- Result: false timestamp claims are economically irrational

**Shared Treasury:** Accumulates protocol fees from slashed stakes.

### Test Results
```
sui move test
Running Move unit tests
[ PASS ] trace::media_tests::test_ai_integrity_boundary
[ PASS ] trace::media_tests::test_ai_score_overflow_blocked
[ PASS ] trace::media_tests::test_authorized_revocation
[ PASS ] trace::media_tests::test_clean_lifecycle
[ PASS ] trace::media_tests::test_derivative_without_parent_blocked
[ PASS ] trace::media_tests::test_double_revocation_blocked
[ PASS ] trace::media_tests::test_edit_on_revoked_parent_blocked
[ PASS ] trace::media_tests::test_revocation_unauthorized_attack
[ PASS ] trace::delegation_tests::test_double_revocation_blocked
[ PASS ] trace::delegation_tests::test_org_register_and_grant
[ PASS ] trace::delegation_tests::test_revocation_flow
[ PASS ] trace::delegation_tests::test_self_delegation_blocked
[ PASS ] trace::delegation_tests::test_unauthorized_grant_blocked
[ PASS ] trace::staking_tests::test_cannot_challenge_after_window
[ PASS ] trace::staking_tests::test_cannot_release_if_challenged
[ PASS ] trace::staking_tests::test_challenge_flow
[ PASS ] trace::staking_tests::test_deposit_and_release
[ PASS ] trace::staking_tests::test_required_stake_calculation
[ PASS ] trace::staking_tests::test_stake_not_required_for_recent
Test result: OK. Total tests: 19; passed: 19; failed: 0
```

---

## API Reference

**Base URL:** `https://trace-cbvb.onrender.com`

### Public (no auth)
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/health` | Server status, registry count, network |
| `POST` | `/v1/verify` | Verify any media file — returns verdict + provenance |
| `GET` | `/v1/media/:id` | Get MediaRecord by Sui object ID |
| `GET` | `/v1/media/:id/graph` | Get full provenance DAG |
| `GET` | `/v1/media/:id/certificate` | HTML certificate with QR code |
| `GET` | `/v1/explorer` | Browse registry (filterable, paginated) |
| `GET` | `/v1/search?hash=` | Search by SHA-256 or pHash similarity |

### Authenticated (Google zkLogin required)
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/register` | Register media on-chain (gas sponsored by TRACE) |
| `POST` | `/v1/stake` | Deposit stake for backdated timestamp claim |
| `POST` | `/v1/challenge` | File challenge against a stake deposit |
| `POST` | `/v1/org` | Register an organisation root |
| `POST` | `/v1/delegate` | Grant delegation to a sub-wallet |

### Example: Verify a file
```javascript
const fd = new FormData();
fd.append("file", mediaFile);

const res = await fetch("https://trace-cbvb.onrender.com/v1/verify", {
  method: "POST", body: fd
});
const result = await res.json();
// result.verdict: "VERIFIED_ORIGINAL" | "MODIFIED" | "UNVERIFIED" | "AI_GENERATED"
// result.confidence: 0.94
// result.origin.creator: "0x7a9f...c4d2"
// result.origin.sui_tx: "AkqZFLH..."
// result.provenance_chain: [{ node, integrity, timestamp }]
```

---

## Local Development

### Prerequisites
- Node.js 20+
- Sui CLI (`cargo install --locked --git https://github.com/MystenLabs/sui.git sui`)

### Backend
```bash
cd trace
npm install
cp .env.example .env
# Fill in TRACE_PRIVATE_KEY, TRACE_PACKAGE_ID
npm run dev
# Server at http://localhost:3001
```

### Frontend
```bash
cd trace-frontend
npm install
# Create .env.local:
echo "VITE_API_URL=http://localhost:3001" > .env.local
echo "VITE_APP_URL=http://localhost:5173" >> .env.local
npm run dev
# App at http://localhost:5173
```

### Move Contracts
```bash
cd trace/move
sui move build
sui move test
# Deploy:
sui client publish --gas-budget 300000000
```

### Browser Extension
```bash
# Load in Chrome:
# 1. chrome://extensions → enable Developer mode
# 2. Load unpacked → select trace-extension/ folder
```

---

## Environment Variables

### Backend
```env
TRACE_PACKAGE_ID=0x3eff0f24ece1bd96bef48ba534eb498331a87cb1fb90d30de5bf1ec940cc648e
TRACE_TREASURY_ID=0x5dcd795b9b23e0344608b92d58f2a0c0438558243ce5db9c821292f90df9a54a
TRACE_PRIVATE_KEY=<sui_private_key_hex>
DATABASE_URL=<postgresql_connection_string>    # optional — uses file fallback if not set
ALLOWED_ORIGINS=https://www.traceprotocol.co,http://localhost:5173
APP_URL=https://www.traceprotocol.co
WALRUS_PUBLISHER=https://publisher.walrus-testnet.walrus.space
WALRUS_AGGREGATOR=https://aggregator.walrus-testnet.walrus.space
NODE_ENV=production
```

### Frontend
```env
VITE_API_URL=https://trace-cbvb.onrender.com
VITE_APP_URL=https://www.traceprotocol.co
VITE_GOOGLE_CLIENT_ID=<google_oauth_client_id>
```

---

## Mainnet Deployment

### What changes
| Item | Change |
|------|--------|
| Contract | `sui client switch --env mainnet` → republish → update package ID |
| Walrus | Switch to `publisher.walrus.space` / `aggregator.walrus.space` |
| Database | Add PostgreSQL on Render (free tier available) |
| Google OAuth | Submit app for production verification (3-5 days) |
| Gas wallet | Fund server keypair with mainnet SUI |

### Add PostgreSQL on Render
1. Render dashboard → New → PostgreSQL
2. Copy `Internal Database URL`
3. Add as `DATABASE_URL` env var on your web service
4. `db.ts` auto-creates the schema on first boot

### Redeploy contracts to mainnet
```bash
sui client switch --env mainnet
cd trace/move
sui client publish --gas-budget 500000000
# Update TRACE_PACKAGE_ID and TRACE_TREASURY_ID in Render env vars
```

---

## Why Sui + Walrus

| Requirement | Solution |
|-------------|----------|
| Sub-second finality | Sui's ~400ms — registration feels instant |
| Cheap transactions | ~$0.001 per MediaRecord |
| No wallet for journalists | Sui zkLogin (Google sign-in) |
| Rich on-chain objects | Sui object model + Display standard |
| Decentralised media storage | Walrus erasure-coded blobs |
| Unforgeable timestamps | `sui::clock::Clock` consensus time |
| Economic anti-fraud | Staking module with treasury |

---

## Project Structure

```
trace/                    Backend
├── middleware/
│   ├── server.ts         Express API (all endpoints)
│   ├── traceProcessor.ts Sui TX builders + Walrus upload
│   ├── certificate.ts    HTML certificate generator
│   └── db.ts             PostgreSQL + file fallback
├── move/                 Sui Move smart contracts
│   ├── sources/
│   │   ├── media.move
│   │   ├── delegation.move
│   │   └── staking.move
│   └── tests/
└── scripts/

trace-frontend/           React + Vite frontend
trace-extension/          Chrome MV3 extension
```

---

## Market Context

- **3.5B images** shared daily — each a potential verification target
- **EU AI Act (2026)** — mandates synthetic media disclosure
- **C2PA** — Adobe, BBC, Microsoft, Google coalition — but centralized
- **TRACE advantage** — on-chain provenance, no company controls the truth
- **Revenue model** — free verify (adoption) · paid register (newsrooms) · enterprise delegation · protocol staking fees

Built for the **Sui Walrus Hackathon 2025**.  
License: MIT