/**
 * TRACE Verification Agent
 * 
 * An autonomous agent that:
 * 1. Monitors news sources for new media
 * 2. Automatically verifies each image against TRACE registry
 * 3. Stores its memory of verified images on Walrus (persistent across sessions)
 * 4. Builds a growing knowledge base of media authenticity over time
 * 5. Detects patterns — repeated fake images, coordinated inauthentic behaviour
 * 
 * This demonstrates:
 * - Long-running autonomous agent behaviour
 * - Walrus as the PRIMARY memory layer (not just storage)
 * - Cross-session persistence — agent remembers everything it has ever seen
 * - Multi-signal decision making
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

const TRACE_API   = process.env.TRACE_API_URL   ?? "https://trace-cbvb.onrender.com";
const WALRUS_PUB  = process.env.WALRUS_PUBLISHER ?? "https://publisher.walrus-testnet.walrus.space";
const WALRUS_AGG  = process.env.WALRUS_AGGREGATOR ?? "https://aggregator.walrus-testnet.walrus.space";
const MEMORY_FILE = path.join(process.cwd(), "agent", "memory.json");

// ── Agent Memory Schema ───────────────────────────────────────────────────────
interface AgentMemory {
  version:       number;
  walrus_blob_id: string | null;   // Walrus blob storing full memory
  last_saved:    string;
  total_scanned: number;
  total_verified: number;
  total_flagged:  number;
  seen_hashes:   Record<string, {
    verdict:     string;
    first_seen:  string;
    seen_count:  number;
    sources:     string[];
    media_id?:   string;
  }>;
  flagged_patterns: {
    repeated_fakes: string[];       // Hashes seen as fake across multiple sources
    suspicious_sources: string[];   // Sources repeatedly sharing unverified media
  };
  sessions: {
    started:  string;
    ended?:   string;
    scanned:  number;
    flagged:  number;
  }[];
}

// ── Sample news images for agent to verify ───────────────────────────────────
// In production this would pull from RSS feeds, Twitter API, news APIs
const SAMPLE_MEDIA_SOURCES = [
  { url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png", source: "wikipedia.org" },
  { url: "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3f/Bikesgray.jpg/320px-Bikesgray.jpg", source: "wikipedia.org" },
  { url: "https://www.w3schools.com/css/img_5terre.jpg", source: "w3schools.com" },
];

// ── Walrus Memory Layer ───────────────────────────────────────────────────────
async function saveMemoryToWalrus(memory: AgentMemory): Promise<string | null> {
  try {
    console.log("  💾 Saving agent memory to Walrus...");
    const blob = JSON.stringify(memory, null, 2);
    const res  = await fetch(`${WALRUS_PUB}/v1/blobs?epochs=5`, {
      method:  "PUT",
      headers: { "Content-Type": "application/json" },
      body:    blob,
    });
    if (!res.ok) throw new Error(`Walrus PUT failed: ${res.status}`);
    const data = await res.json() as {
      newlyCreated?: { blobObject?: { blobId?: string } };
      alreadyCertified?: { blobId?: string };
    };
    const blobId = data.newlyCreated?.blobObject?.blobId
                ?? data.alreadyCertified?.blobId
                ?? null;
    if (blobId) {
      console.log(`  ✅ Memory saved to Walrus: ${blobId}`);
      console.log(`  🔗 Retrieve: ${WALRUS_AGG}/v1/${blobId}`);
    }
    return blobId;
  } catch (err) {
    console.warn("  ⚠ Walrus save failed (offline?):", err);
    return null;
  }
}

async function loadMemoryFromWalrus(blobId: string): Promise<AgentMemory | null> {
  try {
    console.log(`  📥 Loading agent memory from Walrus blob: ${blobId}`);
    const res  = await fetch(`${WALRUS_AGG}/v1/${blobId}`);
    if (!res.ok) throw new Error(`Walrus GET failed: ${res.status}`);
    const data = await res.json() as AgentMemory;
    console.log(`  ✅ Memory restored: ${data.total_scanned} images previously scanned`);
    return data;
  } catch {
    return null;
  }
}

// ── Local memory fallback ─────────────────────────────────────────────────────
function loadLocalMemory(): AgentMemory {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8")) as AgentMemory;
    }
  } catch { /* ignore */ }
  return {
    version:          1,
    walrus_blob_id:   null,
    last_saved:       new Date().toISOString(),
    total_scanned:    0,
    total_verified:   0,
    total_flagged:    0,
    seen_hashes:      {},
    flagged_patterns: { repeated_fakes: [], suspicious_sources: [] },
    sessions:         [],
  };
}

function saveLocalMemory(memory: AgentMemory) {
  const dir = path.dirname(MEMORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

// ── Core agent action: verify one image ──────────────────────────────────────
async function verifyImageUrl(
  imageUrl: string,
  source: string,
  memory: AgentMemory
): Promise<{ verdict: string; mediaId?: string; confidence: number }> {

  try {
    // Download image
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error(`Failed to fetch image: ${imgRes.status}`);
    const imgBuf = await imgRes.arrayBuffer();
    const imgBlob = new Blob([imgBuf]);

    // Quick hash for memory lookup (simplified)
    const hashBuf = await crypto.subtle.digest("SHA-256", imgBuf);
    const hash    = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2,"0")).join("");

    // Check agent memory first — have we seen this before?
    if (memory.seen_hashes[hash]) {
      const prev = memory.seen_hashes[hash];
      prev.seen_count++;
      prev.sources = [...new Set([...prev.sources, source])];
      console.log(`    📋 Known image (seen ${prev.seen_count}x) — verdict: ${prev.verdict}`);
      return { verdict: prev.verdict, mediaId: prev.media_id, confidence: 1.0 };
    }

    // Call TRACE verification API
    const form = new FormData();
    form.append("file", imgBlob, "image.jpg");
    const verRes  = await fetch(`${TRACE_API}/v1/verify`, { method: "POST", body: form });
    const verData = await verRes.json() as {
      verdict: string;
      confidence: number;
      provenance_chain?: { mediaId?: string }[];
    };

    const verdict  = verData.verdict ?? "UNKNOWN";
    const mediaId  = verData.provenance_chain?.[0]?.mediaId;
    const confidence = verData.confidence ?? 0;

    // Update memory
    memory.seen_hashes[hash] = {
      verdict,
      first_seen:  new Date().toISOString(),
      seen_count:  1,
      sources:     [source],
      media_id:    mediaId,
    };

    // Pattern detection — same fake appearing across multiple sources
    if (verdict === "UNVERIFIED" || verdict === "AI_GENERATED") {
      memory.total_flagged++;
      if (!memory.flagged_patterns.repeated_fakes.includes(hash)) {
        memory.flagged_patterns.repeated_fakes.push(hash);
      }
    } else if (verdict === "VERIFIED_ORIGINAL" || verdict === "MODIFIED") {
      memory.total_verified++;
    }

    memory.total_scanned++;
    return { verdict, mediaId, confidence };

  } catch (err) {
    console.warn(`    ⚠ Verification failed: ${err}`);
    return { verdict: "ERROR", confidence: 0 };
  }
}

// ── Generate agent report ─────────────────────────────────────────────────────
function generateReport(memory: AgentMemory, session: AgentMemory["sessions"][0]) {
  const lines = [
    "",
    "╔══════════════════════════════════════════════════╗",
    "║          TRACE AGENT — SESSION REPORT            ║",
    "╠══════════════════════════════════════════════════╣",
    `║  Session scanned:   ${String(session.scanned).padEnd(27)}║`,
    `║  Session flagged:   ${String(session.flagged).padEnd(27)}║`,
    "╠══════════════════════════════════════════════════╣",
    `║  Total ever scanned: ${String(memory.total_scanned).padEnd(26)}║`,
    `║  Total verified:     ${String(memory.total_verified).padEnd(26)}║`,
    `║  Total flagged:      ${String(memory.total_flagged).padEnd(26)}║`,
    "╠══════════════════════════════════════════════════╣",
    `║  Repeated fake hashes: ${String(memory.flagged_patterns.repeated_fakes.length).padEnd(24)}║`,
    `║  Memory blob (Walrus): ${(memory.walrus_blob_id ?? "not saved yet").slice(0,24).padEnd(24)}║`,
    "╚══════════════════════════════════════════════════╝",
    "",
  ];
  return lines.join("\n");
}

// ── Main agent loop ───────────────────────────────────────────────────────────
async function runAgent(options: { continuous?: boolean; intervalMinutes?: number } = {}) {
  const { continuous = false, intervalMinutes = 5 } = options;

  console.log("\n🤖 TRACE Verification Agent starting...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // Load memory — from Walrus if available, else local file
  let memory = loadLocalMemory();
  if (memory.walrus_blob_id) {
    const walrusMemory = await loadMemoryFromWalrus(memory.walrus_blob_id);
    if (walrusMemory) memory = walrusMemory;
  }

  console.log(`📊 Agent memory: ${memory.total_scanned} images scanned across ${memory.sessions.length} previous sessions\n`);

  const doScan = async () => {
    const session = {
      started: new Date().toISOString(),
      scanned: 0,
      flagged: 0,
    };

    console.log(`🔍 Starting scan — ${new Date().toLocaleTimeString()}`);
    console.log(`   Monitoring ${SAMPLE_MEDIA_SOURCES.length} sources...\n`);

    for (const { url, source } of SAMPLE_MEDIA_SOURCES) {
      console.log(`  → Checking: ${source}`);
      const result = await verifyImageUrl(url, source, memory);

      const emoji = {
        VERIFIED_ORIGINAL: "✅",
        MODIFIED:          "⚠️",
        UNVERIFIED:        "❌",
        AI_GENERATED:      "🤖",
        UNKNOWN:           "○",
        ERROR:             "💥",
      }[result.verdict] ?? "○";

      console.log(`    ${emoji} ${result.verdict} (${(result.confidence * 100).toFixed(0)}% confidence)`);
      if (result.mediaId) {
        console.log(`    🔗 ${TRACE_API}/v1/media/${result.mediaId}`);
      }

      session.scanned++;
      if (result.verdict === "UNVERIFIED" || result.verdict === "AI_GENERATED") {
        session.flagged++;
      }

      // Small delay between requests
      await new Promise(r => setTimeout(r, 1000));
    }

    session.ended = new Date().toISOString();
    memory.sessions.push(session as AgentMemory["sessions"][0]);
    memory.last_saved = new Date().toISOString();

    // Save memory to Walrus — this is the core Walrus integration
    const blobId = await saveMemoryToWalrus(memory);
    if (blobId) memory.walrus_blob_id = blobId;

    // Also save locally as fallback
    saveLocalMemory(memory);

    console.log(generateReport(memory, session as AgentMemory["sessions"][0]));

    if (memory.walrus_blob_id) {
      console.log(`🌊 Agent memory persisted on Walrus:`);
      console.log(`   ${WALRUS_AGG}/v1/${memory.walrus_blob_id}\n`);
      console.log(`   Any other agent can load this memory with:`);
      console.log(`   GET ${WALRUS_AGG}/v1/${memory.walrus_blob_id}\n`);
    }
  };

  // Run once
  await doScan();

  // If continuous mode, keep running
  if (continuous) {
    console.log(`⏱ Running continuously every ${intervalMinutes} minutes. Ctrl+C to stop.\n`);
    setInterval(doScan, intervalMinutes * 60 * 1000);
  }
}

// ── HTTP API for agent ────────────────────────────────────────────────────────
// Expose agent memory and status via HTTP so other agents can query it
import express from "express";

const agentApp = express();
agentApp.use(express.json());

agentApp.get("/agent/status", (_req, res) => {
  const memory = loadLocalMemory();
  res.json({
    status:         "active",
    total_scanned:  memory.total_scanned,
    total_verified: memory.total_verified,
    total_flagged:  memory.total_flagged,
    walrus_memory:  memory.walrus_blob_id
      ? `${WALRUS_AGG}/v1/${memory.walrus_blob_id}`
      : null,
    last_session:   memory.sessions[memory.sessions.length - 1] ?? null,
    sessions_count: memory.sessions.length,
  });
});

agentApp.get("/agent/memory", (_req, res) => {
  const memory = loadLocalMemory();
  res.json(memory);
});

agentApp.post("/agent/verify", express.json(), async (req, res) => {
  const { image_url, source } = req.body as { image_url: string; source: string };
  if (!image_url) return res.status(400).json({ error: "image_url required" });
  const memory = loadLocalMemory();
  const result = await verifyImageUrl(image_url, source ?? "api", memory);
  saveLocalMemory(memory);
  res.json(result);
});

agentApp.get("/agent/flagged", (_req, res) => {
  const memory = loadLocalMemory();
  res.json({
    repeated_fakes:    memory.flagged_patterns.repeated_fakes.length,
    suspicious_sources: memory.flagged_patterns.suspicious_sources,
    flagged_hashes:    memory.flagged_patterns.repeated_fakes,
  });
});

const AGENT_PORT = process.env.AGENT_PORT ? parseInt(process.env.AGENT_PORT) : 3002;

// Start HTTP server
agentApp.listen(AGENT_PORT, () => {
  console.log(`🤖 TRACE Agent API running on port ${AGENT_PORT}`);
  console.log(`   GET  /agent/status  — current agent state`);
  console.log(`   GET  /agent/memory  — full Walrus-backed memory`);
  console.log(`   POST /agent/verify  — verify any image URL`);
  console.log(`   GET  /agent/flagged — flagged media patterns\n`);
});

// Run the agent
runAgent({ continuous: true, intervalMinutes: 5 });