/**
 * TRACE Verification Agent v3 — with MemWal
 *
 * A production-grade autonomous agent that:
 * 1. Fetches real images from live RSS news feeds
 * 2. Verifies each against the TRACE registry
 * 3. Runs AI detection on unverified media
 * 4. Stores persistent memory on Walrus Core — survives restarts
 * 5. Stores semantic memory on MemWal — cross-agent queryable
 * 6. Detects coordinated inauthentic behaviour patterns
 * 7. Exposes HTTP API so other agents can query its knowledge
 * 8. Alerts when the same fake image appears across multiple sources
 */

import "dotenv/config";
import * as fs   from "fs";
import * as path from "path";
import express, { Request, Response } from "express";
import {
  rememberVerification,
  rememberSession,
  recallMemories,
  checkMemWalHealth,
  getMemWalClient,
} from "./memwal-integration.js";

const TRACE_API        = process.env.TRACE_API_URL    ?? "https://trace-cbvb.onrender.com";
const WALRUS_PUB       = process.env.WALRUS_PUBLISHER  ?? "https://publisher.walrus-testnet.walrus.space";
const WALRUS_AGG       = process.env.WALRUS_AGGREGATOR ?? "https://aggregator.walrus-testnet.walrus.space";
const MEM_FILE         = path.join(process.cwd(), "agent", "memory.json");
const SCAN_INTERVAL_MS = parseInt(process.env.AGENT_INTERVAL ?? "300000");

// ── Real RSS news sources ─────────────────────────────────────────────────────
const RSS_SOURCES = [
  { name: "BBC News",   url: "https://feeds.bbci.co.uk/news/rss.xml" },
  { name: "Reuters",    url: "https://feeds.reuters.com/reuters/topNews" },
  { name: "AP News",    url: "https://rsshub.app/apnews/topics/apf-topnews" },
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { name: "Guardian",   url: "https://www.theguardian.com/world/rss" },
];

// ── Memory schema ─────────────────────────────────────────────────────────────
interface SeenEntry {
  verdict:      string;
  confidence:   number;
  first_seen:   string;
  last_seen:    string;
  seen_count:   number;
  sources:      string[];
  media_id?:    string;
  image_url:    string;
  ai_score?:    number;
  memwal_blob?: string; // ← NEW: MemWal blob reference
}

interface AgentMemory {
  version:          number;
  walrus_blob_id:   string | null;
  memwal_enabled:   boolean;        // ← NEW
  last_saved:       string;
  total_scanned:    number;
  total_verified:   number;
  total_modified:   number;
  total_unverified: number;
  total_ai:         number;
  seen:             Record<string, SeenEntry>;
  alerts: {
    repeated_fakes:      { hash: string; sources: string[]; count: number }[];
    coordinated_sharing: { image_url: string; sources: string[] }[];
  };
  sessions: {
    id:                  number;
    started:             string;
    ended?:              string;
    scanned:             number;
    verdicts:            Record<string, number>;
    sources_checked:     string[];
    memwal_session_blob?: string; // ← NEW
  }[];
}

// ── Walrus Core memory layer ──────────────────────────────────────────────────
async function saveToWalrus(memory: AgentMemory): Promise<string | null> {
  try {
    const blob = Buffer.from(JSON.stringify(memory));
    const res  = await fetch(`${WALRUS_PUB}/v1/blobs?epochs=5`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: blob,
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json() as {
      newlyCreated?:     { blobObject?: { blobId?: string } };
      alreadyCertified?: { blobId?: string };
    };
    return data.newlyCreated?.blobObject?.blobId
        ?? data.alreadyCertified?.blobId
        ?? null;
  } catch (e) {
    console.warn("  ⚠ Walrus save failed:", e);
    return null;
  }
}

async function loadFromWalrus(blobId: string): Promise<AgentMemory | null> {
  try {
    const res = await fetch(`${WALRUS_AGG}/v1/${blobId}`);
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json() as AgentMemory;
  } catch { return null; }
}

// ── Local memory ──────────────────────────────────────────────────────────────
function emptyMemory(): AgentMemory {
  return {
    version: 3, walrus_blob_id: null,
    memwal_enabled: !!getMemWalClient(),
    last_saved: new Date().toISOString(),
    total_scanned: 0, total_verified: 0, total_modified: 0,
    total_unverified: 0, total_ai: 0,
    seen: {},
    alerts: { repeated_fakes: [], coordinated_sharing: [] },
    sessions: [],
  };
}

function loadLocal(): AgentMemory {
  try {
    if (fs.existsSync(MEM_FILE))
      return JSON.parse(fs.readFileSync(MEM_FILE, "utf8")) as AgentMemory;
  } catch { /* ignore */ }
  return emptyMemory();
}

function saveLocal(m: AgentMemory) {
  const dir = path.dirname(MEM_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(MEM_FILE, JSON.stringify(m, null, 2));
}

// ── RSS parser ────────────────────────────────────────────────────────────────
async function fetchImagesFromRSS(source: { name: string; url: string }): Promise<string[]> {
  try {
    const res = await fetch(source.url, {
      headers: { "User-Agent": "TRACE-Agent/3.0 (media verification bot)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const urls: string[] = [];
    const patterns = [
      /enclosure[^>]+url="([^"]+\.(?:jpg|jpeg|png|webp))"/gi,
      /media:content[^>]+url="([^"]+\.(?:jpg|jpeg|png|webp))"/gi,
      /<url>([^<]+\.(?:jpg|jpeg|png|webp))<\/url>/gi,
      /media:thumbnail[^>]+url="([^"]+)"/gi,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(xml)) !== null) {
        if (match[1] && !urls.includes(match[1])) urls.push(match[1]);
        if (urls.length >= 10) break;
      }
    }
    return urls.slice(0, 10);
  } catch { return []; }
}

// ── Hash ──────────────────────────────────────────────────────────────────────
async function hashBuffer(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Verify one image ──────────────────────────────────────────────────────────
async function verifyOne(
  imageUrl: string,
  sourceName: string,
  memory: AgentMemory
): Promise<{ verdict: string; confidence: number; fromCache: boolean }> {

  let imgBuf: ArrayBuffer;
  try {
    const r = await fetch(imageUrl, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    imgBuf = await r.arrayBuffer();
  } catch { return { verdict: "FETCH_ERROR", confidence: 0, fromCache: false }; }

  const hash = await hashBuffer(imgBuf);

  // Check memory cache
  if (memory.seen[hash]) {
    const entry = memory.seen[hash];
    entry.seen_count++;
    entry.last_seen = new Date().toISOString();
    if (!entry.sources.includes(sourceName)) {
      entry.sources.push(sourceName);
      if (entry.sources.length >= 2 &&
          (entry.verdict === "UNVERIFIED" || entry.verdict === "AI_GENERATED")) {
        const existing = memory.alerts.repeated_fakes.find(a => a.hash === hash);
        if (existing) {
          existing.sources = entry.sources;
          existing.count   = entry.seen_count;
        } else {
          memory.alerts.repeated_fakes.push({
            hash, sources: entry.sources, count: entry.seen_count,
          });
        }
        console.log(`  🚨 ALERT: Unverified image spreading across ${entry.sources.length} sources!`);
      }
    }
    return { verdict: entry.verdict, confidence: entry.confidence, fromCache: true };
  }

  // Call TRACE verify API
  try {
    const form = new FormData();
    form.append("file", new Blob([imgBuf]), "image.jpg");
    const res  = await fetch(`${TRACE_API}/v1/verify`, {
      method: "POST", body: form,
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json() as {
      verdict: string;
      confidence: number;
      provenance_chain?: { mediaId?: string }[];
      ai_score?: number;
    };

    const verdict    = data.verdict    ?? "UNKNOWN";
    const confidence = data.confidence ?? 0;
    const mediaId    = data.provenance_chain?.[0]?.mediaId;

    // Store in MemWal (semantic, encrypted, cross-agent shareable) ← NEW
    const memwalBlob = await rememberVerification({
      imageUrl, source: sourceName, verdict, confidence, hash, mediaId,
    });

    // Store in local memory cache
    memory.seen[hash] = {
      verdict, confidence,
      first_seen:  new Date().toISOString(),
      last_seen:   new Date().toISOString(),
      seen_count:  1,
      sources:     [sourceName],
      media_id:    mediaId,
      image_url:   imageUrl,
      ai_score:    data.ai_score,
      memwal_blob: memwalBlob ?? undefined, // ← NEW
    };

    // Update totals
    memory.total_scanned++;
    if (verdict === "VERIFIED_ORIGINAL") memory.total_verified++;
    else if (verdict === "MODIFIED")     memory.total_modified++;
    else if (verdict === "UNVERIFIED")   memory.total_unverified++;
    else if (verdict === "AI_GENERATED") memory.total_ai++;

    return { verdict, confidence, fromCache: false };
  } catch {
    return { verdict: "API_ERROR", confidence: 0, fromCache: false };
  }
}

// ── Scan session ──────────────────────────────────────────────────────────────
async function runScanSession(memory: AgentMemory) {
  const session = {
    id:              memory.sessions.length + 1,
    started:         new Date().toISOString(),
    scanned:         0,
    verdicts:        {} as Record<string, number>,
    sources_checked: [] as string[],
  };

  console.log(`\n🔍 Session #${session.id} — ${new Date().toLocaleString()}`);
  const memwalOk = !!getMemWalClient();
  console.log(`   MemWal: ${memwalOk ? "✅ connected" : "⚠ not configured"}`);
  console.log(`   Scanning ${RSS_SOURCES.length} news sources...\n`);

  for (const source of RSS_SOURCES) {
    console.log(`  📰 ${source.name}`);
    const imageUrls = await fetchImagesFromRSS(source);

    if (imageUrls.length === 0) {
      console.log(`    ○ No images found`);
      continue;
    }

    session.sources_checked.push(source.name);
    console.log(`    Found ${imageUrls.length} images`);

    for (const url of imageUrls) {
      const { verdict, confidence, fromCache } = await verifyOne(url, source.name, memory);
      const emoji = {
        VERIFIED_ORIGINAL: "✅",
        MODIFIED:          "⚠️ ",
        UNVERIFIED:        "❌",
        AI_GENERATED:      "🤖",
        UNKNOWN:           "○ ",
        FETCH_ERROR:       "💥",
        API_ERROR:         "💥",
      }[verdict] ?? "○ ";

      const cached = fromCache ? " [cached]" : "";
      console.log(`    ${emoji} ${verdict} (${(confidence*100).toFixed(0)}%)${cached}`);
      session.scanned++;
      session.verdicts[verdict] = (session.verdicts[verdict] ?? 0) + 1;
      await new Promise(r => setTimeout(r, 500));
    }
  }

  session.ended = new Date().toISOString();
  memory.sessions.push(session);
  memory.last_saved = new Date().toISOString();

  // Save to Walrus Core (cold storage — full snapshot)
  console.log("\n  💾 Saving memory to Walrus Core...");
  const blobId = await saveToWalrus(memory);
  if (blobId) {
    memory.walrus_blob_id = blobId;
    console.log(`  ✅ Walrus blob: ${blobId}`);
    console.log(`  🔗 ${WALRUS_AGG}/v1/${blobId}`);
  }

  // Save session summary to MemWal (hot semantic memory) ← NEW
  const memwalSessionBlob = await rememberSession({
    sessionId:      session.id,
    sourcesChecked: session.sources_checked,
    totalScanned:   session.scanned,
    verdicts:       session.verdicts,
    alerts:         memory.alerts.repeated_fakes.length,
    walrusBlobId:   blobId ?? undefined,
  });

  if (memwalSessionBlob) {
    const last = memory.sessions[memory.sessions.length - 1];
    if (last) (last as typeof last & { memwal_session_blob?: string }).memwal_session_blob = memwalSessionBlob;
    console.log(`  🧠 MemWal session stored: ${memwalSessionBlob}`);
  }

  memory.memwal_enabled = !!getMemWalClient();
  saveLocal(memory);

  console.log(`\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Session #${session.id} complete`);
  console.log(`  Scanned: ${session.scanned} images across ${session.sources_checked.length} sources`);
  Object.entries(session.verdicts).forEach(([v, count]) => {
    console.log(`  ${v}: ${count}`);
  });
  if (memory.alerts.repeated_fakes.length > 0) {
    console.log(`  🚨 Active alerts: ${memory.alerts.repeated_fakes.length} fake images spreading`);
  }
  console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

// ── HTTP API ──────────────────────────────────────────────────────────────────
const agentApp = express();
agentApp.use(express.json());

agentApp.get("/agent/status", (_req: Request, res: Response) => {
  const m = loadLocal();
  res.json({
    status:           "active",
    version:          "3.0-memwal",
    memwal_enabled:   m.memwal_enabled,
    total_scanned:    m.total_scanned,
    total_verified:   m.total_verified,
    total_modified:   m.total_modified,
    total_unverified: m.total_unverified,
    total_ai:         m.total_ai,
    sessions_run:     m.sessions.length,
    active_alerts:    m.alerts.repeated_fakes.length,
    walrus_memory:    m.walrus_blob_id ? `${WALRUS_AGG}/v1/${m.walrus_blob_id}` : null,
    walrus_blob_id:   m.walrus_blob_id,
    last_session:     m.sessions[m.sessions.length - 1] ?? null,
    last_saved:       m.last_saved,
    scan_interval_ms: SCAN_INTERVAL_MS,
  });
});

agentApp.get("/agent/memory", (_req: Request, res: Response) => {
  res.json(loadLocal());
});

agentApp.get("/agent/alerts", (_req: Request, res: Response) => {
  const m = loadLocal();
  res.json({
    repeated_fakes:      m.alerts.repeated_fakes,
    coordinated_sharing: m.alerts.coordinated_sharing,
    total_alerts:        m.alerts.repeated_fakes.length,
  });
});

agentApp.get("/agent/sessions", (_req: Request, res: Response) => {
  const m = loadLocal();
  res.json({ sessions: m.sessions, total: m.sessions.length });
});

agentApp.post("/agent/verify", async (req: Request, res: Response) => {
  const { image_url, source } = req.body as { image_url: string; source?: string };
  if (!image_url) return res.status(400).json({ error: "image_url required" });
  const memory = loadLocal();
  const result = await verifyOne(image_url, source ?? "api", memory);
  saveLocal(memory);
  res.json({ ...result, walrus_memory: memory.walrus_blob_id });
});

agentApp.get("/agent/seen/:hash", (req: Request, res: Response) => {
  const m = loadLocal();
  const entry = m.seen[req.params.hash];
  if (!entry) return res.status(404).json({ error: "Hash not in agent memory" });
  res.json(entry);
});

// ← NEW: Semantic recall via MemWal
agentApp.get("/agent/recall", async (req: Request, res: Response) => {
  const { q = "AI generated images", limit = "5" } = req.query as Record<string, string>;
  const results = await recallMemories(q, parseInt(limit));
  res.json({ query: q, results, total: results.length, powered_by: "MemWal" });
});

// ← NEW: MemWal health
agentApp.get("/agent/health", async (_req: Request, res: Response) => {
  const mw = await checkMemWalHealth();
  res.json({ agent: "ok", memwal: mw, version: "3.0" });
});

const AGENT_PORT = parseInt(process.env.AGENT_PORT ?? "3002");
agentApp.listen(AGENT_PORT, () => {
  console.log(`\n🤖 TRACE Agent API → http://localhost:${AGENT_PORT}`);
  console.log(`   GET  /agent/status   — live stats`);
  console.log(`   GET  /agent/memory   — full Walrus-backed memory`);
  console.log(`   GET  /agent/alerts   — coordinated fake alerts`);
  console.log(`   GET  /agent/sessions — scan history`);
  console.log(`   POST /agent/verify   — verify any image URL`);
  console.log(`   GET  /agent/seen/:hash — check if hash in memory`);
  console.log(`   GET  /agent/recall?q= — semantic search via MemWal\n`); // ← NEW
});

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║   TRACE Verification Agent v3 + MemWal      ║");
  console.log("║  Autonomous · Walrus-Powered · Persistent    ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  // MemWal health check ← NEW
  const mw = await checkMemWalHealth();
  console.log(`MemWal: ${mw.connected ? `✅ connected (${mw.version})` : "⚠ not configured — Walrus Core only"}`);

  // Load memory from Walrus Core if available
  let memory = loadLocal();
  if (memory.walrus_blob_id) {
    console.log("📥 Restoring memory from Walrus Core...");
    const walrusMem = await loadFromWalrus(memory.walrus_blob_id);
    if (walrusMem) {
      memory = walrusMem;
      console.log(`✅ Restored: ${memory.total_scanned} images, ${memory.sessions.length} sessions\n`);
    }
  } else {
    console.log("🆕 Starting fresh — no previous Walrus memory found\n");
  }

  await runScanSession(memory);

  setInterval(async () => {
    const freshMemory = loadLocal();
    await runScanSession(freshMemory);
  }, SCAN_INTERVAL_MS);
}

main().catch(console.error);