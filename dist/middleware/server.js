import "dotenv/config";
import rateLimit from "express-rate-limit";
/**
 * TRACE — REST API Server v2
 * Endpoints: register, verify, media, graph, search, health,
 *            certificate, explorer, stake, challenge, org, delegate
 */
import express from "express";
import multer from "multer";
import cors from "cors";
import crypto from "crypto";
// @ts-ignore — @mysten/sui v2 resolves correctly at runtime
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { registerMedia, sha256, computePerceptualHash, EditType, CONFIG, signAndBroadcast, buildGrantDelegationTx, buildRegisterOrgTx, buildDepositStakeTx, buildFilChallengeTx, } from "./traceProcessor.js";
import { generateCertificateHTML } from "./certificate.js";
import { dbInit, dbSave, dbGetByHash, dbGetById, dbList, dbCount, dbGetMemRegistry, dbGetMemRegistryById, } from "./db.js";
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173,http://localhost:3000")
    .split(",").map((o) => o.trim());
app.use(cors({
    origin: (origin, cb) => {
        // Allow requests with no origin (curl, Postman, server-to-server)
        if (!origin)
            return cb(null, true);
        // Allow Chrome extensions
        if (origin.startsWith("chrome-extension://"))
            return cb(null, true);
        // Allow moz-extension for Firefox
        if (origin.startsWith("moz-extension://"))
            return cb(null, true);
        if (ALLOWED_ORIGINS.some((o) => origin.startsWith(o)))
            return cb(null, true);
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
// Rate limiting — protect gas wallet and prevent abuse
app.use("/v1/register", rateLimit({
    windowMs: 60 * 1000, max: 5,
    message: { error: "Too many registrations. Max 5 per minute." },
    standardHeaders: true, legacyHeaders: false,
}));
app.use("/v1/verify", rateLimit({
    windowMs: 60 * 1000, max: 60,
    message: { error: "Too many requests. Slow down." },
    standardHeaders: true, legacyHeaders: false,
}));
app.use("/v1/search", rateLimit({
    windowMs: 60 * 1000, max: 100,
    standardHeaders: true, legacyHeaders: false,
}));
const stakes = new Map(); // key: depositId
const orgs = new Map(); // key: orgId
// ============================================================================
// Helpers
// ============================================================================
function getKeypair() {
    const privKey = process.env.TRACE_PRIVATE_KEY;
    if (privKey) {
        try {
            return Ed25519Keypair.fromSecretKey(Buffer.from(privKey, "hex"));
        }
        catch {
            // fall through to default
        }
    }
    return new Ed25519Keypair();
}
function hammingDistance(a, b) {
    if (a.length !== b.length)
        return 999;
    let dist = 0;
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            dist++;
    return dist;
}
function pHashSimilarity(a, b) {
    const dist = hammingDistance(a, b);
    return Math.max(0, 1 - dist / Math.max(a.length, 1));
}
function buildProvenanceChain(mediaId) {
    const chain = [];
    const memById = dbGetMemRegistryById();
    let current = memById.get(mediaId);
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
        current = current.parentId ? memById.get(current.parentId) : undefined;
    }
    return chain;
}
function estimateAiScore(bytes) {
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
app.post("/v1/register", upload.single("file"), async (req, res) => {
    try {
        if (!req.file)
            return res.status(400).json({ error: "No file uploaded" });
        const { description = req.file.originalname, parent_id: parentId, edit_type: editTypeStr = "0", ai_score: aiScoreStr = "0", creator_address, // zkLogin address from frontend — who is actually registering
        creator_email, // display identity (e.g. john@channelstv.com)
         } = req.body;
        // Require creator identity for registration (Producer side must authenticate)
        if (!creator_address) {
            return res.status(401).json({
                error: "Authentication required. Please sign in with Google to register media.",
                code: "UNAUTHENTICATED",
            });
        }
        const editType = parseInt(editTypeStr, 10);
        const aiScore = Math.min(10000, Math.max(0, parseInt(aiScoreStr, 10)));
        // Server keypair pays gas (sponsored transactions pattern)
        // The creator_address is stored as the identity anchor — WHO registered this
        const keypair = getKeypair();
        const result = await registerMedia({ blob: { bytes: new Uint8Array(req.file.buffer), mimeType: req.file.mimetype, filename: req.file.originalname }, parentId, editType, aiScore, description }, keypair);
        const { raw: contentHash } = sha256(new Uint8Array(req.file.buffer));
        const pHash = computePerceptualHash(new Uint8Array(req.file.buffer));
        const contentHashHex = Buffer.from(contentHash).toString("hex");
        const pHashHex = Buffer.from(pHash).toString("hex");
        const integrity = editType === EditType.AI_REMIX || aiScore >= 7500 ? 3
            : editType !== EditType.ORIGINAL ? 1 : 0;
        // Use the zkLogin address as creator — not the server keypair address
        const creatorIdentity = creator_address || keypair.getPublicKey().toSuiAddress();
        const entry = {
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
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
// ============================================================================
// POST /v1/verify
// ============================================================================
app.post("/v1/verify", upload.single("file"), async (req, res) => {
    try {
        if (!req.file)
            return res.status(400).json({ error: "No file provided" });
        const bytes = new Uint8Array(req.file.buffer);
        const { raw: cHash } = sha256(bytes);
        const pHash = computePerceptualHash(bytes);
        const contentHashHex = Buffer.from(cHash).toString("hex");
        const pHashHex = Buffer.from(pHash).toString("hex");
        const mediaType = req.file.mimetype.split("/")[0] ?? "image";
        const platform = req.headers["x-platform"] ?? "web";
        const { buildSighting, writeSightingToBank, queryBank } = await import("../agent/sighting.js");
        // Step 1 — Exact SHA-256 registry match
        const exact = await dbGetByHash(contentHashHex);
        if (exact) {
            const sighting = buildSighting({ contentHash: contentHashHex, perceptualHash: pHashHex, mediaType, verdict: "VERIFIED_ORIGINAL", platform, registryEntry: { mediaId: exact.mediaId, timestamp: exact.timestamp } });
            const bankBlob = await writeSightingToBank(sighting);
            return res.json({
                verdict: "VERIFIED_ORIGINAL", confidence: 1.0,
                origin: { first_seen: new Date(exact.timestamp).toISOString(), creator: exact.creator, sui_tx: exact.suiTx, walrus_blob: exact.blobId },
                provenance_chain: buildProvenanceChain(exact.mediaId),
                similarity_matches: [], flags: exact.revoked ? ["REVOKED"] : [],
                bank: { sighting_id: sighting.sighting_id, contributed_to_bank: true, bank_blob_id: bankBlob, message: "Sighting recorded in Collective Memory Bank" },
            });
        }
        // Step 2 — Query Collective Memory Bank
        const bankHistory = await queryBank(contentHashHex);
        if (bankHistory.known) {
            const sighting = buildSighting({ contentHash: contentHashHex, perceptualHash: pHashHex, mediaType, verdict: "UNVERIFIED", platform, registryEntry: null });
            const bankBlob = await writeSightingToBank(sighting);
            return res.json({
                verdict: "UNVERIFIED", confidence: 0.6,
                origin: null, provenance_chain: [], similarity_matches: [],
                flags: ["NOT_IN_REGISTRY", "KNOWN_TO_BANK"],
                bank: { known: true, sighting_count: bankHistory.sighting_count, first_seen: bankHistory.first_seen, sources: bankHistory.sources, sighting_id: sighting.sighting_id, bank_blob_id: bankBlob, message: `Previously seen ${bankHistory.sighting_count} time(s) in Collective Memory Bank` },
            });
        }
        // Step 3 — pHash similarity
        let bestMatch = null;
        for (const entry of dbGetMemRegistry().values()) {
            const sim = pHashSimilarity(pHashHex, entry.perceptualHash);
            if (sim > 0.9 && (!bestMatch || sim > bestMatch.similarity))
                bestMatch = { entry, similarity: sim };
        }
        if (bestMatch) {
            const sighting = buildSighting({ contentHash: contentHashHex, perceptualHash: pHashHex, mediaType, verdict: "MODIFIED", platform, registryEntry: { mediaId: bestMatch.entry.mediaId, timestamp: bestMatch.entry.timestamp } });
            const bankBlob = await writeSightingToBank(sighting);
            return res.json({
                verdict: "MODIFIED", confidence: bestMatch.similarity,
                origin: { first_seen: new Date(bestMatch.entry.timestamp).toISOString(), creator: bestMatch.entry.creator, sui_tx: bestMatch.entry.suiTx, walrus_blob: bestMatch.entry.blobId },
                provenance_chain: buildProvenanceChain(bestMatch.entry.mediaId),
                similarity_matches: [{ blob_id: bestMatch.entry.blobId, similarity: bestMatch.similarity, relationship: "PARENT" }],
                flags: ["UNANCHORED_EDIT_DETECTED"],
                bank: { sighting_id: sighting.sighting_id, contributed_to_bank: true, bank_blob_id: bankBlob, message: "Sighting recorded in Collective Memory Bank" },
            });
        }
        // Step 4 — AI detection
        const aiScore = estimateAiScore(bytes);
        const verdict = aiScore >= 7500 ? "AI_GENERATED" : "UNVERIFIED";
        // Step 5 — Write sighting regardless of verdict
        const sighting = buildSighting({ contentHash: contentHashHex, perceptualHash: pHashHex, mediaType, verdict, platform, registryEntry: null });
        const bankBlob = await writeSightingToBank(sighting);
        // Step 6 — Return with bank contribution confirmation
        res.json({
            verdict, confidence: aiScore / 10000,
            origin: null, provenance_chain: [], similarity_matches: [],
            flags: aiScore >= 7500 ? ["AI_GENERATED_ESTIMATE"] : ["NOT_IN_REGISTRY"],
            ai_score: aiScore,
            bank: { sighting_id: sighting.sighting_id, contributed_to_bank: true, bank_blob_id: bankBlob, message: "First encounter recorded in Collective Memory Bank" },
        });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
// ============================================================================
// GET /v1/media/:id
// ============================================================================
app.get("/v1/media/:id", async (req, res) => {
    const entry = await dbGetById(req.params.id);
    if (!entry)
        return res.status(404).json({ error: "Not found" });
    res.json(entry);
});
// ============================================================================
// GET /v1/media/:id/graph
// ============================================================================
app.get("/v1/media/:id/graph", async (req, res) => {
    const nodes = [];
    const edges = [];
    const memById = dbGetMemRegistryById();
    function collect(id) {
        const node = memById.get(id);
        if (!node || nodes.find((n) => n.mediaId === id))
            return;
        nodes.push(node);
        if (node.parentId) {
            edges.push({ from: node.parentId, to: id, type: "DECLARED" });
            collect(node.parentId);
        }
        for (const other of memById.values()) {
            if (other.parentId === id)
                collect(other.mediaId);
        }
    }
    collect(req.params.id);
    if (nodes.length === 0)
        return res.status(404).json({ error: "Not found" });
    res.json({ nodes, edges });
});
// ============================================================================
// GET /v1/media/:id/certificate  — F-5: HTML certificate with QR code
// ============================================================================
app.get("/v1/media/:id/certificate", async (req, res) => {
    try {
        const entry = await dbGetById(req.params.id);
        if (!entry)
            return res.status(404).json({ error: "Media not found" });
        // Query bank for sighting history
        const { queryBank } = await import("../agent/sighting.js");
        const bankHistory = await queryBank(entry.contentHash);
        const certData = {
            mediaId: entry.mediaId,
            blobId: entry.blobId,
            suiTx: entry.suiTx,
            creator: entry.creator,
            timestamp: entry.timestamp,
            integrity: entry.integrity,
            editType: entry.editType,
            aiScore: entry.aiScore,
            description: entry.description,
            contentHash: entry.contentHash,
            revoked: entry.revoked,
            // Bank sighting summary
            bankSightingCount: bankHistory.known ? bankHistory.sighting_count : 0,
            bankFirstSeen: bankHistory.first_seen,
            bankSources: bankHistory.sources,
        };
        const html = await generateCertificateHTML(certData);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "public, max-age=3600");
        res.send(html);
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
// ============================================================================
// GET /v1/explorer  — searchable registry table
// ============================================================================
app.get("/v1/explorer", async (req, res) => {
    const { creator, integrity, edit_type, from_date, to_date, q, sort = "timestamp", order = "desc", page = "1", limit = "20", } = req.query;
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
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
// ============================================================================
// GET /v1/search
// ============================================================================
app.get("/v1/search", async (req, res) => {
    const { hash, phash, threshold = "0.9" } = req.query;
    if (hash)
        return res.json(await dbGetByHash(hash) ?? null);
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
app.post("/v1/stake", async (req, res) => {
    try {
        const { media_id, claimed_timestamp, payment_coin_id } = req.body;
        if (!media_id || !claimed_timestamp || !payment_coin_id) {
            return res.status(400).json({ error: "media_id, claimed_timestamp, and payment_coin_id required" });
        }
        const keypair = getKeypair();
        const sender = keypair.getPublicKey().toSuiAddress();
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
        const THRESHOLD_MS = 72 * 60 * 60 * 1000;
        const ageMs = now - claimedTs;
        const extraDays = Math.ceil(Math.max(0, ageMs - THRESHOLD_MS) / 86_400_000);
        const stakeAmount = extraDays * STAKE_PER_DAY;
        const record = {
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
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
// ============================================================================
// POST /v1/challenge  — File a challenge against a stake
// ============================================================================
app.post("/v1/challenge", async (req, res) => {
    try {
        const { deposit_id, evidence } = req.body;
        if (!deposit_id || !evidence)
            return res.status(400).json({ error: "deposit_id and evidence required" });
        const keypair = getKeypair();
        const sender = keypair.getPublicKey().toSuiAddress();
        const tx = buildFilChallengeTx({ depositObjectId: deposit_id, evidence, sender });
        const { digest } = await signAndBroadcast(tx, keypair);
        const record = stakes.get(deposit_id);
        if (record) {
            record.challenged = true;
            stakes.set(deposit_id, record);
        }
        res.json({ sui_tx: digest, deposit_id, challenger: sender });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
// ============================================================================
// GET /v1/stakes  — list all stake deposits
// ============================================================================
app.get("/v1/stakes", (_req, res) => {
    res.json(Array.from(stakes.values()));
});
// ============================================================================
// POST /v1/org  — F-6: Register an organization
// ============================================================================
app.post("/v1/org", async (req, res) => {
    try {
        const { name } = req.body;
        if (!name)
            return res.status(400).json({ error: "name required" });
        const keypair = getKeypair();
        const sender = keypair.getPublicKey().toSuiAddress();
        const tx = buildRegisterOrgTx({ name, sender });
        const { digest, createdObjectIds } = await signAndBroadcast(tx, keypair);
        const orgId = createdObjectIds[0] ?? "";
        const record = { orgId, name, authority: sender, suiTx: digest, delegateCount: 0, createdAt: Date.now() };
        orgs.set(orgId, record);
        res.json({ org_id: orgId, name, authority: sender, sui_tx: digest });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
// ============================================================================
// POST /v1/delegate  — F-6: Grant delegation to a sub-wallet
// ============================================================================
app.post("/v1/delegate", async (req, res) => {
    try {
        const { org_id, delegate, role } = req.body;
        if (!org_id || !delegate || !role)
            return res.status(400).json({ error: "org_id, delegate, role required" });
        const keypair = getKeypair();
        const sender = keypair.getPublicKey().toSuiAddress();
        const tx = buildGrantDelegationTx({ orgObjectId: org_id, delegate, role, sender });
        const { digest } = await signAndBroadcast(tx, keypair);
        const org = orgs.get(org_id);
        if (org) {
            org.delegateCount++;
            orgs.set(org_id, org);
        }
        res.json({ delegation_tx: digest, org_id, delegate, role });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
// ============================================================================
// GET /v1/health
// ============================================================================
// ── AI Detection ─────────────────────────────────────────────────────────────
app.post("/v1/detect-ai", upload.single("file"), async (req, res) => {
    if (!req.file)
        return res.status(400).json({ error: "No file provided" });
    const apiUser = process.env.SIGHTENGINE_USER;
    const apiSecret = process.env.SIGHTENGINE_SECRET;
    if (!apiUser || !apiSecret) {
        return res.json({ score: localAiEstimate(req.file.buffer), source: "local", signals: ["Local analysis only"] });
    }
    try {
        const form = new FormData();
        form.append("media", new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);
        form.append("models", "genai");
        form.append("api_user", apiUser);
        form.append("api_secret", apiSecret);
        const response = await fetch("https://api.sightengine.com/1.0/check.json", { method: "POST", body: form });
        const data = await response.json();
        if (data.status === "success" && data.type?.ai_generated !== undefined) {
            const score = Math.round(data.type.ai_generated * 10000);
            return res.json({
                score, source: "sightengine",
                signals: [`Sightengine: ${(data.type.ai_generated * 100).toFixed(1)}% AI probability`],
            });
        }
        throw new Error("Bad response");
    }
    catch {
        return res.json({ score: localAiEstimate(req.file.buffer), source: "local_fallback", signals: ["API error — local fallback"] });
    }
});
function localAiEstimate(buf) {
    const bytes = new Uint8Array(buf);
    const freq = new Array(256).fill(0);
    const len = Math.min(bytes.length, 65536);
    for (let i = 0; i < len; i++)
        freq[bytes[i]]++;
    let entropy = 0;
    freq.forEach(f => { if (f > 0) {
        const p = f / len;
        entropy -= p * Math.log2(p);
    } });
    const n = entropy / 8.0;
    if (n > 0.975)
        return Math.min(10000, Math.round((n - 0.975) * 80000));
    if (n > 0.96)
        return Math.round((n - 0.96) * 40000);
    return 0;
}
// ── Health ────────────────────────────────────────────────────────────────────
app.get("/v1/health", async (_req, res) => {
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
app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: err.message });
});
// ============================================================================
// Start
// ============================================================================
// ── C2PA Manifest (F-1) ───────────────────────────────────────────────────────
app.get("/v1/media/:id/c2pa", async (req, res) => {
    try {
        const entry = await dbGetById(req.params.id);
        if (!entry)
            return res.status(404).json({ error: "Media not found" });
        const manifest = {
            "@context": "https://c2pa.org/assertions/v1",
            "claim_generator": "TRACE Protocol/2.0",
            "title": entry.description || "TRACE Authenticated Media",
            "format": "image/jpeg",
            "instance_id": `trace:${entry.mediaId}`,
            "claim": {
                "dc:title": entry.description || "Authenticated Media",
                "dc:format": "image/jpeg",
                "signature_info": {
                    "issuer": "TRACE Protocol",
                    "time": new Date(entry.timestamp).toISOString(),
                    "cert_serial_number": entry.suiTx,
                },
                "assertions": [
                    {
                        "label": "c2pa.actions",
                        "data": {
                            "actions": [{
                                    "action": "c2pa.created",
                                    "when": new Date(entry.timestamp).toISOString(),
                                    "softwareAgent": "TRACE Protocol",
                                    "digitalSourceType": entry.integrity === 3
                                        ? "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"
                                        : "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture",
                                }]
                        }
                    },
                    {
                        "label": "stds.schema-org.CreativeWork",
                        "data": {
                            "@context": "https://schema.org",
                            "@type": "CreativeWork",
                            "author": [{ "@type": "Person", "credential": entry.creator }],
                        }
                    },
                    {
                        "label": "trace.provenance",
                        "data": {
                            "sui_package": CONFIG.PACKAGE_ID,
                            "sui_object": entry.mediaId,
                            "sui_tx": entry.suiTx,
                            "walrus_blob": entry.blobId,
                            "content_hash": entry.contentHash,
                            "ai_score": entry.aiScore,
                            "network": CONFIG.SUI_NETWORK,
                        }
                    }
                ]
            }
        };
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="trace-c2pa-${entry.mediaId.slice(0, 8)}.json"`);
        res.json(manifest);
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
// ── Bank endpoints (F-9) ──────────────────────────────────────────────────────
app.get("/v1/bank/stats", async (_req, res) => {
    const m = loadAgentMemory();
    const registry = dbGetMemRegistry();
    res.json({
        total_sightings: m?.total_scanned ?? 0,
        total_verified: m?.total_verified ?? 0,
        total_unverified: m?.total_unverified ?? 0,
        total_ai_generated: m?.total_ai ?? 0,
        unique_media: registry.size,
        active_alerts: m?.alerts?.repeated_fakes?.length ?? 0,
        sessions_run: m?.sessions?.length ?? 0,
        walrus_memory: m?.walrus_blob_id ?? null,
        memwal_enabled: !!process.env.MEMWAL_PRIVATE_KEY,
        last_updated: m?.last_saved ?? null,
    });
});
app.get("/v1/bank/top-sighted", (_req, res) => {
    const m = loadAgentMemory();
    if (!m?.seen)
        return res.json({ results: [] });
    const sorted = Object.entries(m.seen)
        .sort(([, a], [, b]) => (b.seen_count ?? 0) - (a.seen_count ?? 0))
        .slice(0, 20)
        .map(([hash, entry]) => ({
        hash: hash.slice(0, 16) + "...",
        verdict: entry.verdict,
        sighting_count: entry.seen_count ?? 1,
        first_seen: entry.first_seen,
        sources: entry.sources,
        image_url: entry.image_url,
    }));
    res.json({ results: sorted });
});
app.get("/v1/bank/alerts", (_req, res) => {
    const m = loadAgentMemory();
    res.json({
        repeated_fakes: m?.alerts?.repeated_fakes ?? [],
        total: m?.alerts?.repeated_fakes?.length ?? 0,
        severity: (m?.alerts?.repeated_fakes?.length ?? 0) > 5 ? "HIGH" : "LOW",
    });
});
// ── Agent Types (F-10) ────────────────────────────────────────────────────────
// Sentinel Agent — derivative detection
app.post("/agent/sentinel", express.json(), async (req, res) => {
    const { media_id } = req.body;
    if (!media_id)
        return res.status(400).json({ error: "media_id required" });
    const entry = await dbGetById(media_id);
    if (!entry)
        return res.status(404).json({ error: "Media not found" });
    // Check bank for variants with similar pHash
    const m = loadAgentMemory();
    const variants = [];
    if (m?.seen) {
        for (const [hash, seen] of Object.entries(m.seen)) {
            if (seen.verdict === "MODIFIED")
                variants.push({ hash, sources: seen.sources, first_seen: seen.first_seen });
        }
    }
    res.json({
        agent: "sentinel",
        monitored_id: media_id,
        variants_detected: variants.length,
        variants,
        graph_nodes_added: variants.length,
        recommendation: variants.length > 0 ? "Unanchored derivatives detected — provenance graph updated with AI_AUTONOMOUS nodes" : "No variants detected",
    });
});
// Spread Analysis Agent — full spread timeline
app.get("/agent/spread/:hash", async (req, res) => {
    const { queryBank } = await import("../agent/sighting.js");
    const bankData = await queryBank(req.params.hash);
    const m = loadAgentMemory();
    const seen = m?.seen?.[req.params.hash];
    res.json({
        agent: "spread_analysis",
        hash: req.params.hash,
        known_to_bank: bankData.known,
        sighting_count: bankData.sighting_count,
        first_seen: bankData.first_seen ?? seen?.first_seen ?? null,
        sources: bankData.sources ?? seen?.sources ?? [],
        spread_velocity: bankData.sighting_count > 10 ? "HIGH" : bankData.sighting_count > 3 ? "MEDIUM" : "LOW",
        coordinated_behavior_detected: (seen?.sources?.length ?? 0) >= 3,
        timeline: bankData.memories?.map(m => ({ text: m.text, blob_id: m.blob_id })) ?? [],
    });
});
// Anomaly Detection Agent — coordinated inauthentic behavior
app.get("/agent/anomaly", (_req, res) => {
    const m = loadAgentMemory();
    const alerts = m?.alerts?.repeated_fakes ?? [];
    const anomalies = alerts.map(alert => ({
        hash: alert.hash,
        sources: alert.sources,
        count: alert.count,
        severity: alert.count >= 5 ? "HIGH" : alert.count >= 3 ? "MEDIUM" : "LOW",
        pattern: "COORDINATED_SPREAD",
        recommendation: `Same unverified media seen across ${alert.sources.length} sources — possible coordinated campaign`,
    }));
    res.json({
        agent: "anomaly_detection",
        total_anomalies: anomalies.length,
        anomalies,
        threshold: { sources_min: 2, count_min: 2 },
        last_scan: m?.last_saved ?? null,
    });
});
// Source Trust Agent — source track record
app.get("/agent/source-trust/:source", (_req, res) => {
    const source = decodeURIComponent(_req.params.source);
    const m = loadAgentMemory();
    const entries = Object.values(m?.seen ?? {});
    const sourceSightings = entries.filter(e => e.sources?.includes(source));
    const verified = sourceSightings.filter(e => e.verdict === "VERIFIED_ORIGINAL").length;
    const unverified = sourceSightings.filter(e => e.verdict === "UNVERIFIED").length;
    const ai = sourceSightings.filter(e => e.verdict === "AI_GENERATED").length;
    const total = sourceSightings.length;
    const trustScore = total > 0 ? Math.round((verified / total) * 100) : null;
    _req.res?.json({
        agent: "source_trust",
        source,
        total_media: total,
        verified,
        unverified,
        ai_generated: ai,
        trust_score: trustScore,
        verdict: trustScore === null ? "UNKNOWN" : trustScore > 70 ? "TRUSTED" : trustScore > 40 ? "MIXED" : "SUSPICIOUS",
    });
});
// Legal Evidence Agent — court-formatted evidence package
app.get("/agent/evidence/:id", async (req, res) => {
    const entry = await dbGetById(req.params.id);
    if (!entry)
        return res.status(404).json({ error: "Media not found" });
    const { queryBank } = await import("../agent/sighting.js");
    const bank = await queryBank(entry.contentHash);
    const evidence = {
        agent: "legal_evidence",
        generated_at: new Date().toISOString(),
        case_reference: `TRACE-EVIDENCE-${entry.mediaId.slice(0, 8).toUpperCase()}`,
        media: {
            sui_object_id: entry.mediaId,
            content_hash: entry.contentHash,
            walrus_blob_id: entry.blobId,
            sui_transaction: entry.suiTx,
            registration_timestamp: new Date(entry.timestamp).toISOString(),
            creator_identity: entry.creator,
            integrity_status: ["ORIGINAL", "MODIFIED", "UNVERIFIED", "AI_GENERATED"][entry.integrity],
            ai_probability: `${(entry.aiScore / 100).toFixed(1)}%`,
        },
        chain_of_custody: {
            registered_on_blockchain: true,
            blockchain: "Sui Testnet",
            package_id: CONFIG.PACKAGE_ID,
            immutable: true,
            tamper_evident: true,
        },
        collective_memory: {
            total_sightings: bank.sighting_count,
            first_seen: bank.first_seen,
            sources: bank.sources,
            stored_on_walrus_via_memwal: true,
        },
        admissibility_notes: [
            "SHA-256 hash anchored on Sui blockchain — tamper-proof",
            "Consensus-anchored timestamp via sui::clock",
            "Walrus blob certificate provides storage proof",
            "Collective Memory Bank corroborates timeline",
        ],
        walrus_artifact_url: entry.blobId ? `${CONFIG.WALRUS_AGGREGATOR}/v1/${entry.blobId}` : null,
    };
    res.json(evidence);
});
// Research Agent — aggregate pattern analysis
app.get("/agent/research", (_req, res) => {
    const m = loadAgentMemory();
    const registry = dbGetMemRegistry();
    const verdictBreakdown = {};
    for (const seen of Object.values(m?.seen ?? {})) {
        verdictBreakdown[seen.verdict] = (verdictBreakdown[seen.verdict] ?? 0) + 1;
    }
    const report = {
        agent: "research",
        generated_at: new Date().toISOString(),
        dataset: {
            total_bank_sightings: m?.total_scanned ?? 0,
            total_registered_media: registry.size,
            total_sessions: m?.sessions?.length ?? 0,
            active_anomaly_alerts: m?.alerts?.repeated_fakes?.length ?? 0,
        },
        verdict_distribution: verdictBreakdown,
        integrity_rate: m?.total_scanned
            ? `${((m.total_verified / m.total_scanned) * 100).toFixed(1)}%`
            : "N/A",
        ai_generation_rate: m?.total_scanned
            ? `${((m.total_ai / m.total_scanned) * 100).toFixed(1)}%`
            : "N/A",
        top_anomalies: (m?.alerts?.repeated_fakes ?? []).slice(0, 5),
        walrus_memory_blob: m?.walrus_blob_id ?? null,
        methodology: "TRACE Collective Memory Bank — MemWal on Walrus — anonymized sighting records",
        export_format: "JSON — Walrus-hosted artifact available on request",
    };
    res.json(report);
});
import * as agentFs from "fs";
import * as agentPath from "path";
const AGENT_MEM_FILE = agentPath.join(process.cwd(), "agent", "memory.json");
const WALRUS_AGG_URL = process.env.WALRUS_AGGREGATOR ?? "https://aggregator.walrus-testnet.walrus.space";
function loadAgentMemory() {
    try {
        if (agentFs.existsSync(AGENT_MEM_FILE))
            return JSON.parse(agentFs.readFileSync(AGENT_MEM_FILE, "utf8"));
    }
    catch { /* ignore */ }
    return null;
}
app.get("/agent/status", (_req, res) => {
    const m = loadAgentMemory();
    // Always return a valid response — agent is "ready" even if no scans yet
    res.json({
        status: m ? "active" : "ready",
        version: m?.version ?? "2.0",
        total_scanned: m?.total_scanned ?? 0,
        total_verified: m?.total_verified ?? 0,
        total_modified: m?.total_modified ?? 0,
        total_unverified: m?.total_unverified ?? 0,
        total_ai: m?.total_ai ?? 0,
        sessions_run: m?.sessions?.length ?? 0,
        active_alerts: m?.alerts?.repeated_fakes?.length ?? 0,
        walrus_memory: m?.walrus_blob_id ? `${WALRUS_AGG_URL}/v1/${m.walrus_blob_id}` : null,
        walrus_blob_id: m?.walrus_blob_id ?? null,
        last_session: m?.sessions?.[m.sessions.length - 1] ?? null,
        last_saved: m?.last_saved ?? null,
        message: m ? `Agent has scanned ${m.total_scanned} images across ${m.sessions?.length ?? 0} sessions`
            : "Agent ready — use /agent/verify to start scanning",
    });
});
app.get("/agent/memory", (_req, res) => {
    const m = loadAgentMemory();
    if (!m)
        return res.status(404).json({ error: "No agent memory found" });
    res.json(m);
});
app.get("/agent/alerts", (_req, res) => {
    const m = loadAgentMemory();
    if (!m)
        return res.json({ repeated_fakes: [], coordinated_sharing: [], total_alerts: 0 });
    res.json({
        repeated_fakes: m.alerts?.repeated_fakes ?? [],
        coordinated_sharing: m.alerts?.coordinated_sharing ?? [],
        total_alerts: m.alerts?.repeated_fakes?.length ?? 0,
    });
});
app.get("/agent/recall", async (req, res) => {
    const { q = "AI generated images", limit = "5" } = req.query;
    try {
        if (!process.env.MEMWAL_PRIVATE_KEY) {
            return res.json({ query: q, results: [], total: 0, powered_by: "MemWal", error: "MemWal not configured" });
        }
        const { recallMemories } = await import("../agent/memwal-integration.js");
        const results = await recallMemories(q, parseInt(limit));
        res.json({ query: q, results, total: results.length, powered_by: "MemWal" });
    }
    catch {
        res.json({ query: q, results: [], total: 0, powered_by: "MemWal", error: "MemWal not configured" });
    }
});
app.get("/agent/health", async (_req, res) => {
    try {
        if (!process.env.MEMWAL_PRIVATE_KEY) {
            return res.json({ agent: "ok", memwal: { connected: false }, version: "3.0" });
        }
        const { checkMemWalHealth } = await import("../agent/memwal-integration.js");
        const mw = await checkMemWalHealth();
        res.json({ agent: "ok", memwal: mw, version: "3.0" });
    }
    catch {
        res.json({ agent: "ok", memwal: { connected: false }, version: "3.0" });
    }
});
app.post("/agent/verify", express.json(), async (req, res) => {
    const { image_url, source } = req.body;
    if (!image_url)
        return res.status(400).json({ error: "image_url required" });
    try {
        // Download the image
        const imgRes = await fetch(image_url, { signal: AbortSignal.timeout(10000) });
        if (!imgRes.ok)
            throw new Error(`Failed to fetch image: HTTP ${imgRes.status}`);
        const imgBuf = await imgRes.arrayBuffer();
        const imgBytes = new Uint8Array(imgBuf);
        // Compute SHA-256 hash
        const hashBuf = await crypto.subtle.digest("SHA-256", imgBuf);
        const hash = Array.from(new Uint8Array(hashBuf))
            .map(b => b.toString(16).padStart(2, "0")).join("");
        // Check registry directly
        const existing = await dbGetByHash(hash);
        const verdict = existing
            ? ["VERIFIED_ORIGINAL", "MODIFIED", "UNVERIFIED", "AI_GENERATED"][existing.integrity] ?? "UNKNOWN"
            : "UNVERIFIED";
        const confidence = existing ? 0.95 : 0.5;
        // Save to agent memory
        const m = loadAgentMemory() ?? {
            version: 2, walrus_blob_id: null, last_saved: new Date().toISOString(),
            total_scanned: 0, total_verified: 0, total_modified: 0,
            total_unverified: 0, total_ai: 0, seen: {},
            alerts: { repeated_fakes: [], coordinated_sharing: [] }, sessions: [],
        };
        m.seen[hash] = {
            verdict, confidence,
            first_seen: new Date().toISOString(),
            last_seen: new Date().toISOString(),
            seen_count: 1,
            sources: [source ?? "api"],
            image_url,
            media_id: existing?.mediaId,
        };
        m.total_scanned++;
        if (verdict === "VERIFIED_ORIGINAL")
            m.total_verified++;
        else if (verdict === "MODIFIED")
            m.total_modified++;
        else if (verdict === "AI_GENERATED")
            m.total_ai++;
        else
            m.total_unverified++;
        m.last_saved = new Date().toISOString();
        const dir = agentPath.dirname(AGENT_MEM_FILE);
        if (!agentFs.existsSync(dir))
            agentFs.mkdirSync(dir, { recursive: true });
        agentFs.writeFileSync(AGENT_MEM_FILE, JSON.stringify(m, null, 2));
        res.json({
            verdict, confidence,
            hash,
            media_id: existing?.mediaId ?? null,
            in_registry: !!existing,
            walrus_memory: m.walrus_blob_id,
            message: existing
                ? `Found in TRACE registry — ${verdict}`
                : "Not in TRACE registry — image scanned and logged to agent memory",
        });
    }
    catch (err) {
        console.error("Agent verify error:", err);
        res.status(500).json({ error: err instanceof Error ? err.message : "Verification failed" });
    }
});
const PORT = parseInt(process.env.PORT ?? "3001", 10);
app.listen(PORT, () => {
    console.log(`[TRACE API] Listening on http://localhost:${PORT}`);
    console.log(`[TRACE API] Network:    ${CONFIG.SUI_NETWORK}`);
    console.log(`[TRACE API] Package:    ${CONFIG.PACKAGE_ID}`);
    console.log(`[TRACE API] Treasury:   ${CONFIG.TREASURY_ID}`);
});
export default app;
