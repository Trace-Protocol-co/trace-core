# TRACE Protocol
> **The Authenticity Layer for the Internet — "HTTPS for Media"**

[![Live](https://img.shields.io/badge/Live-traceprotocol.co-10b981)](https://www.traceprotocol.co)
[![API](https://img.shields.io/badge/API-Live-3b82f6)](https://trace-cbvb.onrender.com/v1/health)
[![Bank](https://img.shields.io/badge/Memory%20Bank-Live-8b5cf6)](https://www.traceprotocol.co/bank)
[![Tests](https://img.shields.io/badge/Move%20Tests-29%2F29-10b981)](./tests)
[![Network](https://img.shields.io/badge/Network-Sui%20Testnet-6fbcf0)](https://suiexplorer.com)
[![Walrus](https://img.shields.io/badge/Storage-Walrus-ff6b35)](https://walrus.xyz)
[![MemWal](https://img.shields.io/badge/Memory-MemWal-3b82f6)](https://github.com/MystenLabs/memwal)
[![Seal](https://img.shields.io/badge/Privacy-Seal-ec4899)](https://seal.mystenlabs.com)

---

## What TRACE Is

TRACE is a decentralized media authenticity system built on two complementary layers:

| Layer | What It Does | Technology |
|-------|-------------|------------|
| **Provenance Protocol** | Cryptographically binds any media to its origin, timestamp, and integrity history — permanently on-chain | Sui + Walrus |
| **Collective Memory Bank** | A persistent, decentralized, growing public record of every piece of media encountered by every TRACE agent — accumulated across sessions, devices, and geographies | MemWal on Walrus |

Together: **TRACE knows both what is authentic and what has been seen.**

> HTTPS works because of three components: the protocol, the certificate authority, and the browser trust store.
> TRACE works the same way: the Provenance Protocol, the Sui/Walrus Registry, and the Collective Memory Bank.
> Without the bank, every agent starts from zero. With it, the system compounds.

---

## The Four Failures TRACE Fixes

| Failure | Consequence | TRACE Solution |
|---------|------------|----------------|
| No Origin Guarantee | Anyone can claim authorship of anything | SHA-256 + device signature anchored on Sui |
| No Integrity Guarantee | Tampered content is indistinguishable from originals | pHash similarity detection + immutable Walrus blobs |
| No Timeline Guarantee | Impossible to prove what existed before what | `sui::clock` consensus-anchored timestamps |
| No Collective Memory | Each verification runs from scratch. Spread patterns invisible. The internet forgets everything. | MemWal Collective Memory Bank on Walrus |

---

## Live Deployment

| Component | URL |
|-----------|-----|
| Frontend | https://www.traceprotocol.co |
| Backend API | https://trace-cbvb.onrender.com |
| Memory Bank Dashboard | https://www.traceprotocol.co/bank |
| Sui Explorer | https://suiexplorer.com/object/0xf1acdf7d36c4816d91ebe39f0887f163155a08bb0d435e7ea8f737b981637bdb?network=testnet |

**Contracts (Sui Testnet):**
```
Package ID:        0xf1acdf7d36c4816d91ebe39f0887f163155a08bb0d435e7ea8f737b981637bdb
Treasury ID:       0xc8297d27fe04379529cae44e58c7980224dba603e022d8822ad9e832a481c20c
BankAccessPolicy:  0x1b2343c3b4ffbf25ca5c290777c95874e1ab2ea18d8f954ff9769d3c97c29dc4
Deploy TX:         8UkQ4NFnhyyGaBjRXKwRTa35S2DweoUco3VaF7aUbf67
Modules:           media · delegation · staking · seal_policy
```

---

## Stack

```
Sui         — smart contracts, object model, zkLogin, sponsored transactions
Walrus      — decentralized blob storage for media files and bank entries
MemWal      — persistent agent memory layer (Collective Memory Bank)
Seal        — privacy-preserving anonymization of sighting records
```

---

## Why Walrus, Not Just Postgres

TRACE uses both PostgreSQL and Walrus — they serve different purposes and neither replaces the other.

| | PostgreSQL | Walrus |
|-|------------|--------|
| **Purpose** | Fast index and query cache | Tamper-evident source of truth |
| **What's stored** | MediaRecord metadata for API queries | Original media blobs + MemWal sighting records |
| **Verifiability** | Trust the server | Verify independently — blob ID is cryptographic proof |
| **Permanence** | Lives on Render — deletable | Lives on Walrus network — immutable |
| **Agent memory** | Not applicable | MemWal semantic memory — cross-session, cross-agent |

**Walrus is load-bearing, not decorative.** The Walrus blob ID is the proof of existence. The MemWal blob ID is the proof of sighting. Postgres is just the index that makes queries fast. Remove Walrus and you lose verifiability — you have a database, not a provenance system.

---

## Architecture — Three Layers

```
┌─────────────────────────────────────────────────────────────┐
│  OBSERVATION LAYER — Collective Memory Bank                  │
│  MemWal on Walrus                                            │
│  Every agent encounter → anonymized sighting record         │
│  Grows passively with every page load, every verification   │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  PROVENANCE LAYER — TRACE On-Chain Registry                  │
│  Sui + Walrus                                                │
│  Deliberately registered MediaRecord objects                │
│  Cryptographic hashes · Walrus blobs · Creator identity     │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  INTELLIGENCE LAYER — Multi-Agent System                     │
│  6 specialized agents reading from both layers               │
│  Verification · Sentinel · Spread · Anomaly · Evidence · Research │
└─────────────────────────────────────────────────────────────┘
```

---

## Verification Pipeline (F-3)

Every verification runs all 6 steps. Every step contributes to the bank.

```
Input: any media file
  ↓
Step 1: SHA-256 → exact registry match on Sui?
  YES → return MediaRecord + provenance chain + write sighting
  NO  → continue
  ↓
Step 2: Query Collective Memory Bank (MemWal)
  KNOWN → return sighting history + spread timeline + first-seen timestamp
  NEW   → continue (first encounter — will be recorded)
  ↓
Step 3: pHash similarity > 90%?
  YES → return MODIFIED verdict + parent media
  NO  → continue
  ↓
Step 4: AI generation detection (Sightengine + entropy analysis)
  ↓
Step 5: Write sighting to MemWal (ALWAYS — regardless of verdict)
  ↓
Step 6: Return verdict + bank contribution confirmation + Walrus blob ID
```

**Every verification grows the bank. The bank never forgets.**

---

## Smart Contracts — 4 Modules, 29/29 Tests

### `media.move` — Core Provenance
```move
public struct MediaRecord has key, store {
    id:               UID,
    blob_id:          String,         // Walrus blob reference
    content_hash:     vector<u8>,     // SHA-256 exact integrity
    perceptual_hash:  vector<u8>,     // pHash similarity detection
    creator:          address,        // zkLogin identity
    timestamp:        u64,            // sui::clock consensus-anchored
    ai_score:         u16,            // Synthetic probability 0-10000
    integrity:        u8,             // ORIGINAL|MODIFIED|UNVERIFIED|AI_GENERATED
    revoked:          bool,
}
```

### `delegation.move` — Organisation Trust
Newsrooms delegate signing authority to reporters. Content signed by a reporter inherits the organisation's verification. Revocation does not invalidate prior content.

### `staking.move` — Anti-Backdating Economics
Claiming timestamps older than 72 hours requires staking 50 SUI per 24-hour period. Successful challenge: 70% to challenger, 30% to Treasury. Makes timestamp fraud economically irrational. **Bank provides independent evidence** — if the bank shows prior sightings before a claimed creation date, the challenge succeeds automatically.

### `seal_policy.move` — Privacy Layer (NEW)
On-chain access control for Seal encryption of sighting records. `seal_approve()` called by Seal key servers to authorize decryption. Tiered access: PUBLIC (aggregate stats) → VERIFIER (individual sightings) → INSTITUTIONAL (full bank query).

```move
public fun seal_approve(
    credential: &VerifierCredential,
    _id:        vector<u8>,
    ctx:        &TxContext,
) {
    assert!(!credential.revoked, ENotAuthorized);
    assert!(credential.holder == ctx.sender(), ENotAuthorized);
    // Authorized — Seal key server releases decryption key
}
```

---

## Collective Memory Bank (F-9)

The bank is the fourth failure fixed. Stored in MemWal on Walrus.

### Sighting Record Schema
```json
{
  "sighting_id": "sight_ace533324c759f5c",
  "media_fingerprint": {
    "content_hash": "ad86f022c693...",
    "perceptual_hash": "f8f0e0c080808080",
    "media_type": "image"
  },
  "first_seen": {
    "timestamp": "2026-06-07T19:46:34Z",
    "platform": "web",
    "agent_verdict_at_encounter": "UNVERIFIED"
  },
  "trace_registry_status": {
    "registered": false,
    "registration_delta_hours": null
  },
  "contributed_by": "agent_anonymous_hash_xyz",
  "bank_blob_id": "AL3JP64JcZ1itHlzdzBNqhjo3SQYBHthFSv4jNjw-tw"
}
```

### What the Bank Reveals
- **First appearance** — when and where media was first seen, regardless of registration
- **Spread timeline** — how media traveled across platforms over time
- **Registration lag** — gap between first sighting and TRACE registration (large gaps are suspicious)
- **Coordinated behavior** — statistically abnormal simultaneous appearance across sources
- **Variant detection** — similar pHash across multiple hashes shows mutation as media spreads

### Verifying Walrus Blob Storage

Every registered image creates a verifiable Walrus blob. Verify any blob directly on Walruscan:

```
https://walruscan.com/testnet/blob/<blob_id>
```

Example — a real TRACE-registered media blob:
```
https://walruscan.com/testnet/blob/EK6cmxOV9yDOuDI5FjA_Yl_oiqdGypMZMyzq44yeJ4A
```

Shows: Blob sender, Sui Object ID, file size, storage epochs, certify_blob transaction, reserve_space transaction. All on-chain, all verifiable.

> Note: The raw aggregator URL (`aggregator.walrus-testnet.walrus.space/v1/<id>`) may return 404 briefly after upload due to CDN propagation delay. Use Walruscan for immediate verification.

---

## Verifying MemWal Integration
```bash
# 1. Confirm connection
curl https://trace-cbvb.onrender.com/agent/health
# → {"memwal":{"connected":true,"status":"ok","version":"0.1.0"}}

# 2. Verify an image — bank contribution confirmed
curl -X POST https://trace-cbvb.onrender.com/v1/verify -F "file=@image.jpg"
# → {"bank":{"contributed_to_bank":true,"bank_blob_id":"AL3JP64..."}}

# 3. Semantic recall — MemWal retrieves by meaning not keyword
curl "https://trace-cbvb.onrender.com/agent/recall?q=unverified+images&limit=5"
# → Real sighting records retrieved semantically

# 4. Bank dashboard
open https://www.traceprotocol.co/bank
```

---

## Multi-Agent System (F-10)

All 6 agents share one MemWal store. Adding a new agent requires no new data collection.

| Agent | Endpoint | Output |
|-------|----------|--------|
| Verification | `POST /v1/verify` | Real-time verdict drawing from both provenance and bank |
| Sentinel | `POST /agent/sentinel` | Derivative detection — updates graph with AI_AUTONOMOUS nodes |
| Spread Analysis | `GET /agent/spread/:hash` | Complete spread timeline — first appearance, platform path, mutation history |
| Anomaly Detection | `GET /agent/anomaly` | Coordinated inauthentic behavior alerts |
| Source Trust | `GET /agent/source-trust/:source` | Source track record — verified vs unverified by topic |
| Legal Evidence | `GET /agent/evidence/:id` | Court-formatted package stored as Walrus artifact |
| Research | `GET /agent/research` | Aggregate pattern analysis — academic-grade reports |

### Legal Evidence Agent Example
```bash
curl https://trace-cbvb.onrender.com/agent/evidence/0xefd1ccba...
```
```json
{
  "case_reference": "TRACE-EVIDENCE-0XEFD1CC",
  "chain_of_custody": {
    "registered_on_blockchain": true,
    "blockchain": "Sui Testnet",
    "immutable": true,
    "tamper_evident": true
  },
  "admissibility_notes": [
    "SHA-256 hash anchored on Sui blockchain — tamper-proof",
    "Consensus-anchored timestamp via sui::clock",
    "Walrus blob certificate provides storage proof",
    "Collective Memory Bank corroborates timeline"
  ]
}
```

---

## C2PA Compatibility

Every registered media exports a C2PA-compatible manifest — interoperable with Adobe, Google, Microsoft, and BBC tooling.

```bash
curl https://trace-cbvb.onrender.com/v1/media/:id/c2pa
```
```json
{
  "@context": "https://c2pa.org/assertions/v1",
  "claim_generator": "TRACE Protocol/2.0",
  "assertions": [
    { "label": "c2pa.actions" },
    { "label": "stds.schema-org.CreativeWork" },
    { "label": "trace.provenance" }
  ]
}
```

---

## Full API Reference

**Base URL:** `https://trace-cbvb.onrender.com`

All read/verify endpoints are **free, no authentication, no API key.**

### Provenance
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/verify` | Verify any media — 6-step pipeline + bank contribution |
| `GET` | `/v1/media/:id` | Full MediaRecord |
| `GET` | `/v1/media/:id/graph` | Provenance DAG |
| `GET` | `/v1/media/:id/certificate` | Legal-grade HTML certificate with bank summary |
| `GET` | `/v1/media/:id/c2pa` | C2PA-compatible manifest |
| `GET` | `/v1/explorer` | Browse registry |
| `GET` | `/v1/health` | Health + stats |

### Collective Memory Bank
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/bank/stats` | Aggregate bank statistics |
| `GET` | `/v1/bank/top-sighted` | Top media ranked by encounter count |
| `GET` | `/v1/bank/alerts` | Active anomaly alerts |

### Agents
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/agent/sentinel` | Derivative detection for registered media |
| `GET` | `/agent/spread/:hash` | Full spread timeline |
| `GET` | `/agent/anomaly` | Coordinated inauthentic behavior |
| `GET` | `/agent/source-trust/:source` | Source trust profile |
| `GET` | `/agent/evidence/:id` | Court-formatted evidence package |
| `GET` | `/agent/research` | Aggregate pattern report |
| `GET` | `/agent/recall?q=` | Semantic memory search via MemWal |
| `GET` | `/agent/health` | MemWal connection status |

---

## Browser Extension

Chrome MV3 extension. Install from `/trace-extension` folder.

**Badge states:** 🟢 VERIFIED ORIGINAL · 🟡 MODIFIED · 🔴 UNVERIFIED · 🟣 AI GENERATED · ⚪ UNKNOWN

**Hover panel (320px):** verdict · confidence · bank sighting count · first-seen timestamp · spread velocity · provenance chain depth · MemWal pulse indicator

**Memory contexts per PRD:**
- Personal memory — every encounter this agent has seen
- Collective bank — anonymized sightings shared globally via MemWal

---

## Local Development

```bash
# Backend
git clone https://github.com/Trace-Protocol-co/trace
cd trace && npm install
cp .env.example .env
npm run dev           # http://localhost:3001

# Frontend
cd trace-frontend && npm install
echo "VITE_API_URL=http://localhost:3001" > .env.local
npm run dev           # http://localhost:5173

# Contracts
cd trace
sui move test         # 29/29 passing
sui client publish --gas-budget 500000000

# Extension
# chrome://extensions → Developer mode → Load unpacked → trace-extension/
```

### Environment Variables
```env
# Backend (Render)
TRACE_PACKAGE_ID=0xf1acdf7d36c4816d91ebe39f0887f163155a08bb0d435e7ea8f737b981637bdb
TRACE_TREASURY_ID=0xc8297d27fe04379529cae44e58c7980224dba603e022d8822ad9e832a481c20c
TRACE_SEAL_POLICY_ID=0x1b2343c3b4ffbf25ca5c290777c95874e1ab2ea18d8f954ff9769d3c97c29dc4
TRACE_PRIVATE_KEY=<sui_private_key>
MEMWAL_PRIVATE_KEY=<memwal_delegate_key>
MEMWAL_ACCOUNT_ID=0x89607402e323e56b5b9f0b941e40029c5965c62486a1ed14139dc322eea090a8
DATABASE_URL=<postgresql_url>
WALRUS_PUBLISHER=https://publisher.walrus-testnet.walrus.space
WALRUS_AGGREGATOR=https://aggregator.walrus-testnet.walrus.space
SIGHTENGINE_USER=<key>
SIGHTENGINE_SECRET=<key>
```

---

## Project Structure

```
trace/                        Backend API
├── middleware/
│   ├── server.ts             All endpoints — provenance + bank + agents
│   ├── traceProcessor.ts     Sui TX builders + Walrus upload
│   ├── certificate.ts        HTML certificate with bank summary
│   └── db.ts                 PostgreSQL + file fallback
├── agent/
│   ├── sighting.ts           Sighting records — build/write/query
│   └── memwal-integration.ts MemWal client — remember/recall/health
└── move/
    ├── sources/
    │   ├── media.move         MediaRecord + EditRecord + RevocationRecord
    │   ├── delegation.move    OrgRoot + DelegationRecord
    │   ├── staking.move       StakeDeposit + Treasury + anti-backdating
    │   └── seal_policy.move   BankAccessPolicy + VerifierCredential + seal_approve
    └── tests/                 29 unit tests across all 4 modules

trace-frontend/               React + Vite + Tailwind
└── pages/
    ├── landing-page          Live protocol stats
    ├── verify-page           Verification + bank sighting history
    ├── upload-page           Register + bank pre-check
    ├── bank-page             Memory Bank dashboard
    ├── explorer-page         Registry browser
    ├── provenance-graph      Interactive DAG
    └── agent-page            Agent status

trace-extension/              Chrome MV3
├── content.js                Auto-scans images + 320px hover panel
├── background.js             TRACE API + MemWal queries
└── popup.html                Stats + history + toggle
```

---

## Why Sui + Walrus + MemWal + Seal

| Technology | Why TRACE Needs It |
|------------|-------------------|
| **Sui object model** | MediaRecord, EditRecord, Certificate are first-class objects — perfect for provenance graphs |
| **Move resource model** | Provenance objects cannot be duplicated or forged at the VM level |
| **zkLogin** | Journalists authenticate with Google — no wallet required for mainstream adoption |
| **Sponsored transactions** | Public verification is completely gas-free |
| **sui::clock** | Tamper-resistant timestamps anchored to consensus |
| **Walrus blob storage** | Media survives node failures — permanent, censorship-resistant |
| **Walrus blob certification** | Storage receipt is the cryptographic proof of existence |
| **MemWal** | Agents remember across sessions — the bank compounds |
| **Seal** | Sighting records anonymized — bank is a public good without compromising contributor privacy |

---

## Market Context

- 500+ hours of video uploaded to YouTube per minute — zero provenance attached
- Deepfakes increased 550% from 2019–2024 (Sensity AI)
- 75% of people cannot reliably detect AI-generated video (MIT Media Lab, 2023)
- EU AI Act (2026) mandates synthetic media disclosure
- C2PA (Adobe, BBC, Microsoft, Google) is the centralised standard — TRACE is the decentralised version
- Digital evidence increasingly inadmissible in court without authenticated chain of custody

**TRACE is deployed infrastructure processing real Walrus blobs and real Sui transactions. MemWal semantic recall is live — every verification writes a sighting to Walrus-backed memory, retrievable by meaning across sessions.**

---


**· Stack: Sui · Walrus · MemWal · Seal ·** License: MIT