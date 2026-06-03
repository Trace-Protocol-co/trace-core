import "dotenv/config";
/**
 * TRACE — REST API Server v2
 * Endpoints: register, verify, media, graph, search, health,
 *            certificate, explorer, stake, challenge, org, delegate
 */

import express, { Request, Response, NextFunction } from "express";
import multer from "multer";
import cors from "cors";
import crypto from "crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  registerMedia,
  sha256,
  computePerceptualHash,
  EditType,
  EditTypeValue,
  getSuiClient,
  CONFIG,
  signAndBroadcast,
  buildGrantDelegationTx,
  buildRegisterOrgTx,
  buildDepositStakeTx,
  buildFilChallengeTx,
} from "./traceProcessor";
import { generateCertificateHTML, CertificateData } from "./certificate";
import {
  dbInit, dbSave, dbGetByHash, dbGetById, dbList, dbCount,
  dbGetMemRegistry, dbGetMemRegistryById,
  type RegistryEntry,
} from "./db";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173,http://localhost:3000")
  .split(",").map((o) => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin) return cb(null, true);
    // Allow Chrome extensions
    if (origin.startsWith("chrome-extension://")) return cb(null, true);
    // Allow moz-extension for Firefox
    if (origin.startsWith("moz-extension://")) return cb(null, true);
    if (ALLOWED_ORIGINS.some((o) => origin.startsWith(o))) return cb(null, true);
    cb(new Error(`CORS: ${origin} not allowed`));
  },
  credentials: true,
}));
app.use(express.json());

// ============================================================================
// Registry — backed by PostgreSQL (with in-memory + file fallback)
// ============================================================================

// ============================================================================
// Registry — backed by PostgreSQL (with in-memory + file fallback)
// ============================================================================

// Initialize DB on startup
dbInit().catch(console.error);

// Convenience accessors (use in-memory cache for fast reads)
const registry     = { get: dbGetByHash,    set: async (k: string, v: RegistryEntry) => dbSave(v) };
const registryById = { get: dbGetById,      set: async (k: string, v: RegistryEntry) => dbSave(v) };

// In-memory staking and org records
interface StakeRecord {
  depositId: string;
  mediaId: string;
  creator: string;
  claimedTimestamp: number;
  stakeAmount: number;
  challengeDeadline: number;
  challenged: boolean;
  settled: boolean;
  suiTx: string;
  createdAt: number;
}

interface OrgRecord {
  orgId: string;
  name: string;
  authority: string;
  suiTx: string;
  delegateCount: number;
  createdAt: number;
}

const stakes = new Map<string, StakeRecord>(); // key: depositId
const orgs   = new Map<string, OrgRecord>();   // key: orgId

// ============================================================================
// Helpers
// ============================================================================

function getKeypair(): Ed25519Keypair {
  const privKey = process.env.TRACE_PRIVATE_KEY;
  if (privKey) {
    try {
      return Ed25519Keypair.fromSecretKey(Buffer.from(privKey, "hex"));
    } catch {
      // fall through to default
    }
  }
  return new Ed25519Keypair();
}

function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return 999;
  let dist = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) dist++;
  return dist;
}

function pHashSimilarity(a: string, b: string): number {
  const dist = hammingDistance(a, b);
  return Math.max(0, 1 - dist / Math.max(a.length, 1));
}

function buildProvenanceChain(mediaId: string): object[] {
  const chain: object[] = [];
  let current = registryById.get(mediaId);
  while (current) {
    chain.unshift({
      mediaId: current.mediaId,
      node: current.mediaId,
      type: current.editType,
      integrity: current.integrity,
      creator: current.creator,
      timestamp: new Date(current.timestamp).toISOString(),
      revoked: current.revoked,
    });
    current = current.parentId ? registryById.get(current.parentId) : undefined;
  }
  return chain;
}

function estimateAiScore(bytes: Uint8Array): number {
  const sample = bytes.slice(0, Math.min(1024, bytes.length));
  const freq = new Array(256).fill(0);
  sample.forEach((b) => freq[b]++);
  let entropy = 0;
  for (const count of freq) {
    if (count > 0) {
      const p = count / sample.length;
      entropy -= p * Math.log2(p);
    }
  }
  return Math.round((entropy / 8) * 5000);
}

// ============================================================================
// POST /v1/register
// ============================================================================

app.post("/v1/register", upload.single("file"), async (req: Request, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const {
      description = req.file.originalname,
      parent_id: parentId,
      edit_type: editTypeStr = "0",
      ai_score: aiScoreStr = "0",
      creator_address,   // zkLogin address from frontend — who is actually registering
      creator_email,     // display identity (e.g. john@channelstv.com)
    } = req.body;

    // Require creator identity for registration (Producer side must authenticate)
    if (!creator_address) {
      return res.status(401).json({
        error: "Authentication required. Please sign in with Google to register media.",
        code: "UNAUTHENTICATED",
      });
    }

    const editType = parseInt(editTypeStr, 10) as EditTypeValue;
    const aiScore  = Math.min(10000, Math.max(0, parseInt(aiScoreStr, 10)));

    // Server keypair pays gas (sponsored transactions pattern)
    // The creator_address is stored as the identity anchor — WHO registered this
    const keypair = getKeypair();

    const result = await registerMedia(
      { blob: { bytes: new Uint8Array(req.file.buffer), mimeType: req.file.mimetype, filename: req.file.originalname }, parentId, editType, aiScore, description },
      keypair,
    );

    const { raw: contentHash } = sha256(new Uint8Array(req.file.buffer));
    const pHash = computePerceptualHash(new Uint8Array(req.file.buffer));
    const contentHashHex = Buffer.from(contentHash).toString("hex");
    const pHashHex = Buffer.from(pHash).toString("hex");

    const integrity = editType === EditType.AI_REMIX || aiScore >= 7500 ? 3
                    : editType !== EditType.ORIGINAL ? 1 : 0;

    // Use the zkLogin address as creator — not the server keypair address
    const creatorIdentity = creator_address || keypair.getPublicKey().toSuiAddress();

    const entry: RegistryEntry = {
      mediaId: result.mediaId,
      blobId: result.blobId,
      contentHash: contentHashHex,
      perceptualHash: pHashHex,
      creator: creatorIdentity,
      timestamp: result.timestamp,
      suiTx: result.suiTx,
      editType,
      integrity,
      aiScore,
      parentId,
      revoked: false,
      certificateUrl: result.certificateUrl,
      description,
    };

    await dbSave(entry);

    res.json({
      media_id: result.mediaId,
      walrus_blob: result.blobId,
      certificate_url: result.certificateUrl,
      sui_tx: result.suiTx,
      timestamp: result.timestamp,
    });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ============================================================================
// POST /v1/verify
// ============================================================================

app.post("/v1/verify", upload.single("file"), async (req: Request, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    const bytes = new Uint8Array(req.file.buffer);
    const { raw: contentHash } = sha256(bytes);
    const pHash = computePerceptualHash(bytes);
    const contentHashHex = Buffer.from(contentHash).toString("hex");
    const pHashHex = Buffer.from(pHash).toString("hex");

    // Step 1 — exact hash match
    const exact = await dbGetByHash(contentHashHex);
    if (exact) {
      return res.json({
        verdict: "VERIFIED_ORIGINAL",
        confidence: 1.0,
        origin: { first_seen: new Date(exact.timestamp).toISOString(), creator: exact.creator, sui_tx: exact.suiTx, walrus_blob: exact.blobId },
        provenance_chain: buildProvenanceChain(exact.mediaId),
        similarity_matches: [],
        flags: exact.revoked ? ["REVOKED"] : [],
      });
    }

    // Step 2 — perceptual similarity (use in-memory cache)
    let bestMatch: { entry: RegistryEntry; similarity: number } | null = null;
    for (const entry of dbGetMemRegistry().values()) {
      const sim = pHashSimilarity(pHashHex, entry.perceptualHash);
      if (sim > 0.9 && (!bestMatch || sim > bestMatch.similarity)) {
        bestMatch = { entry, similarity: sim };
      }
    }

    if (bestMatch) {
      return res.json({
        verdict: "MODIFIED",
        confidence: bestMatch.similarity,
        origin: { first_seen: new Date(bestMatch.entry.timestamp).toISOString(), creator: bestMatch.entry.creator, sui_tx: bestMatch.entry.suiTx, walrus_blob: bestMatch.entry.blobId },
        provenance_chain: buildProvenanceChain(bestMatch.entry.mediaId),
        similarity_matches: [{ blob_id: bestMatch.entry.blobId, similarity: bestMatch.similarity, relationship: "PARENT" }],
        flags: ["UNANCHORED_EDIT_DETECTED"],
      });
    }

    // Step 3 — unknown
    const aiScore = estimateAiScore(bytes);
    res.json({
      verdict: aiScore >= 7500 ? "AI_GENERATED" : "UNVERIFIED",
      confidence: aiScore / 10000,
      origin: null,
      provenance_chain: [],
      similarity_matches: [],
      flags: aiScore >= 7500 ? ["AI_GENERATED_ESTIMATE"] : ["NOT_IN_REGISTRY"],
    });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ============================================================================
// GET /v1/media/:id
// ============================================================================

app.get("/v1/media/:id", async (req: Request, res: Response) => {
  const entry = await dbGetById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Not found" });
  res.json(entry);
});

// ============================================================================
// GET /v1/media/:id/graph
// ============================================================================

app.get("/v1/media/:id/graph", async (req: Request, res: Response) => {
  const nodes: RegistryEntry[] = [];
  const edges: { from: string; to: string; type: string }[] = [];
  const memById = dbGetMemRegistryById();

  function collect(id: string) {
    const node = memById.get(id);
    if (!node || nodes.find((n) => n.mediaId === id)) return;
    nodes.push(node);
    if (node.parentId) {
      edges.push({ from: node.parentId, to: id, type: "DECLARED" });
      collect(node.parentId);
    }
    for (const other of memById.values()) {
      if (other.parentId === id) collect(other.mediaId);
    }
  }

  collect(req.params.id);
  if (nodes.length === 0) return res.status(404).json({ error: "Not found" });
  res.json({ nodes, edges });
});

// ============================================================================
// GET /v1/media/:id/certificate  — F-5: HTML certificate with QR code
// ============================================================================

app.get("/v1/media/:id/certificate", async (req: Request, res: Response) => {
  try {
    const entry = await dbGetById(req.params.id);
    if (!entry) return res.status(404).json({ error: "Media not found" });

    const certData: CertificateData = {
      mediaId:     entry.mediaId,
      blobId:      entry.blobId,
      suiTx:       entry.suiTx,
      creator:     entry.creator,
      timestamp:   entry.timestamp,
      integrity:   entry.integrity,
      editType:    entry.editType,
      aiScore:     entry.aiScore,
      description: entry.description,
      contentHash: entry.contentHash,
      revoked:     entry.revoked,
    };

    const html = await generateCertificateHTML(certData);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(html);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ============================================================================
// GET /v1/explorer  — searchable registry table
// ============================================================================

app.get("/v1/explorer", async (req: Request, res: Response) => {
  const {
    creator, integrity, edit_type, from_date, to_date, q,
    sort = "timestamp", order = "desc", page = "1", limit = "20",
  } = req.query as Record<string, string>;

  try {
    const result = await dbList({
      creator, integrity: integrity !== undefined ? parseInt(integrity) : undefined,
      editType: edit_type !== undefined ? parseInt(edit_type) : undefined,
      fromDate: from_date ? new Date(from_date).getTime() : undefined,
      toDate: to_date ? new Date(to_date).getTime() : undefined,
      q, sort, order,
      page: Math.max(1, parseInt(page)),
      limit: Math.min(100, parseInt(limit)),
    });
    const limitNum = Math.min(100, parseInt(limit));
    res.json({
      items: result.items, total: result.total,
      page: Math.max(1, parseInt(page)),
      pages: Math.ceil(result.total / limitNum),
      limit: limitNum,
    });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ============================================================================
// GET /v1/search
// ============================================================================

app.get("/v1/search", async (req: Request, res: Response) => {
  const { hash, phash, threshold = "0.9" } = req.query as Record<string, string>;
  if (hash) return res.json(await dbGetByHash(hash) ?? null);
  if (phash) {
    const results = Array.from(dbGetMemRegistry().values())
      .map((e) => ({ media_id: e.mediaId, similarity: pHashSimilarity(phash, e.perceptualHash) }))
      .filter((r) => r.similarity >= parseFloat(threshold))
      .sort((a, b) => b.similarity - a.similarity);
    return res.json(results);
  }
  res.status(400).json({ error: "Provide hash or phash query param" });
});

// ============================================================================
// POST /v1/stake  — F-8: Temporal staking for backdated claims
// ============================================================================

app.post("/v1/stake", async (req: Request, res: Response) => {
  try {
    const { media_id, claimed_timestamp, payment_coin_id } = req.body;

    if (!media_id || !claimed_timestamp || !payment_coin_id) {
      return res.status(400).json({ error: "media_id, claimed_timestamp, and payment_coin_id required" });
    }

    const keypair = getKeypair();
    const sender  = keypair.getPublicKey().toSuiAddress();

    const tx = buildDepositStakeTx({
      mediaId: media_id,
      claimedTimestamp: parseInt(claimed_timestamp),
      paymentCoinId: payment_coin_id,
      sender,
    });

    const { digest, createdObjectIds } = await signAndBroadcast(tx, keypair);

    const depositId = createdObjectIds[0] ?? "";
    const claimedTs = parseInt(claimed_timestamp);
    const now = Date.now();
    const STAKE_PER_DAY = 50_000_000_000;
    const THRESHOLD_MS  = 72 * 60 * 60 * 1000;
    const ageMs = now - claimedTs;
    const extraDays = Math.ceil(Math.max(0, ageMs - THRESHOLD_MS) / 86_400_000);
    const stakeAmount = extraDays * STAKE_PER_DAY;

    const record: StakeRecord = {
      depositId,
      mediaId: media_id,
      creator: sender,
      claimedTimestamp: claimedTs,
      stakeAmount,
      challengeDeadline: now + 7 * 24 * 60 * 60 * 1000,
      challenged: false,
      settled: false,
      suiTx: digest,
      createdAt: now,
    };

    stakes.set(depositId, record);

    res.json({ deposit_id: depositId, sui_tx: digest, stake_amount: stakeAmount, challenge_deadline: record.challengeDeadline });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ============================================================================
// POST /v1/challenge  — File a challenge against a stake
// ============================================================================

app.post("/v1/challenge", async (req: Request, res: Response) => {
  try {
    const { deposit_id, evidence } = req.body;
    if (!deposit_id || !evidence) return res.status(400).json({ error: "deposit_id and evidence required" });

    const keypair = getKeypair();
    const sender  = keypair.getPublicKey().toSuiAddress();

    const tx = buildFilChallengeTx({ depositObjectId: deposit_id, evidence, sender });
    const { digest } = await signAndBroadcast(tx, keypair);

    const record = stakes.get(deposit_id);
    if (record) { record.challenged = true; stakes.set(deposit_id, record); }

    res.json({ sui_tx: digest, deposit_id, challenger: sender });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ============================================================================
// GET /v1/stakes  — list all stake deposits
// ============================================================================

app.get("/v1/stakes", (_req: Request, res: Response) => {
  res.json(Array.from(stakes.values()));
});

// ============================================================================
// POST /v1/org  — F-6: Register an organization
// ============================================================================

app.post("/v1/org", async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });

    const keypair = getKeypair();
    const sender  = keypair.getPublicKey().toSuiAddress();

    const tx = buildRegisterOrgTx({ name, sender });
    const { digest, createdObjectIds } = await signAndBroadcast(tx, keypair);
    const orgId = createdObjectIds[0] ?? "";

    const record: OrgRecord = { orgId, name, authority: sender, suiTx: digest, delegateCount: 0, createdAt: Date.now() };
    orgs.set(orgId, record);

    res.json({ org_id: orgId, name, authority: sender, sui_tx: digest });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ============================================================================
// POST /v1/delegate  — F-6: Grant delegation to a sub-wallet
// ============================================================================

app.post("/v1/delegate", async (req: Request, res: Response) => {
  try {
    const { org_id, delegate, role } = req.body;
    if (!org_id || !delegate || !role) return res.status(400).json({ error: "org_id, delegate, role required" });

    const keypair = getKeypair();
    const sender  = keypair.getPublicKey().toSuiAddress();

    const tx = buildGrantDelegationTx({ orgObjectId: org_id, delegate, role, sender });
    const { digest } = await signAndBroadcast(tx, keypair);

    const org = orgs.get(org_id);
    if (org) { org.delegateCount++; orgs.set(org_id, org); }

    res.json({ delegation_tx: digest, org_id, delegate, role });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ============================================================================
// GET /v1/health
// ============================================================================

app.get("/v1/health", async (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    registered: await dbCount(),
    network: CONFIG.SUI_NETWORK,
    package_id: CONFIG.PACKAGE_ID,
    treasury_id: CONFIG.TREASURY_ID,
    stakes: stakes.size,
    orgs: orgs.size,
    db: process.env.DATABASE_URL ? "postgresql" : "file",
  });
});

// ============================================================================
// Error handler
// ============================================================================

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

// ============================================================================
// Start
// ============================================================================

const PORT = parseInt(process.env.PORT ?? "3001", 10);
app.listen(PORT, () => {
  console.log(`[TRACE API] Listening on http://localhost:${PORT}`);
  console.log(`[TRACE API] Network:    ${CONFIG.SUI_NETWORK}`);
  console.log(`[TRACE API] Package:    ${CONFIG.PACKAGE_ID}`);
  console.log(`[TRACE API] Treasury:   ${CONFIG.TREASURY_ID}`);
});

export default app;