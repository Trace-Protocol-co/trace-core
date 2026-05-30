#!/usr/bin/env node
/**
 * TRACE — E2E Smoke Test
 * Tests the full pipeline: register → verify → graph
 * Run AFTER the API server is up: npm run dev
 *
 * Usage: node scripts/e2eTest.js
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const API = process.env.TRACE_API_URL ?? "http://localhost:3001";

// ─── Colour helpers ───────────────────────────────────────────────────────────
const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const red    = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan   = (s) => `\x1b[36m${s}\x1b[0m`;
const bold   = (s) => `\x1b[1m${s}\x1b[0m`;

let passed = 0;
let failed = 0;

function ok(label, value) {
  console.log(green("  ✓"), bold(label), cyan(String(value ?? "")));
  passed++;
}

function fail(label, reason) {
  console.log(red("  ✗"), bold(label), red(reason));
  failed++;
}

async function check(label, fn) {
  try {
    await fn();
  } catch (err) {
    fail(label, err.message);
  }
}

// ─── Fake file factory ────────────────────────────────────────────────────────
function fakeJpeg(seed = "original") {
  // Minimal valid JPEG header + random payload so SHA-256s differ per seed
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const payload = Buffer.from(seed + crypto.randomBytes(64).toString("hex"));
  return Buffer.concat([header, payload]);
}

function makeFormData(fileBuffer, filename, extraFields = {}) {
  // Manual multipart/form-data builder (no external dep)
  const boundary = `----TraceBoundary${crypto.randomBytes(8).toString("hex")}`;
  const parts = [];

  for (const [key, value] of Object.entries(extraFields)) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
    );
  }

  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`
  );

  const header = Buffer.from(parts.join(""));
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, fileBuffer, footer]);

  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function post(path, body, contentType) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: text }; }
}

async function get(path) {
  const res = await fetch(`${API}${path}`);
  return { status: res.status, data: await res.json() };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(bold("\n╔══════════════════════════════════════════╗"));
  console.log(bold("║   TRACE — E2E Backend Smoke Test         ║"));
  console.log(bold("╚══════════════════════════════════════════╝\n"));
  console.log(`  API: ${cyan(API)}\n`);

  // ── 0: Health check ─────────────────────────────────────────────────────────
  console.log(bold("▸ Stage 0 — Health Check"));
  await check("GET /v1/health", async () => {
    const { status, data } = await get("/v1/health");
    if (status !== 200) throw new Error(`status ${status}`);
    if (data.status !== "ok") throw new Error("status not ok");
    ok("Server healthy", `network=${data.network} registered=${data.registered}`);
  });

  // ── 1: Register original ────────────────────────────────────────────────────
  console.log(bold("\n▸ Stage 1 — Register Original Media"));

  let originalMediaId = null;
  let originalBlobId = null;
  const originalBytes = fakeJpeg("original_capture_lagos");

  await check("POST /v1/register (original)", async () => {
    const { body, contentType } = makeFormData(originalBytes, "lagos_protest.jpg", {
      edit_type: "0",
      ai_score: "200",
      description: "Lagos protest footage — original capture",
    });
    const { status, data } = await post("/v1/register", body, contentType);

    if (status !== 200) throw new Error(`status ${status}: ${JSON.stringify(data)}`);
    if (!data.media_id) throw new Error("No media_id returned");

    originalMediaId = data.media_id;
    originalBlobId = data.walrus_blob;
    ok("media_id", originalMediaId);
    ok("walrus_blob", originalBlobId);
    ok("certificate_url", data.certificate_url);
    ok("sui_tx", data.sui_tx || "(simulated — no package deployed)");
  });

  // ── 2: Register TRIM derivative ─────────────────────────────────────────────
  console.log(bold("\n▸ Stage 2 — Register TRIM Derivative"));

  let trimMediaId = null;

  await check("POST /v1/register (trim edit)", async () => {
    if (!originalMediaId) throw new Error("Skip — original registration failed");
    const trimBytes = fakeJpeg("trim_edit_broadcast");
    const { body, contentType } = makeFormData(trimBytes, "lagos_protest_trim.jpg", {
      edit_type: "1",       // TRIM
      ai_score: "150",
      parent_id: originalMediaId,
      description: "Broadcast trim — removed first 45s",
    });
    const { status, data } = await post("/v1/register", body, contentType);
    if (status !== 200) throw new Error(`status ${status}: ${JSON.stringify(data)}`);
    trimMediaId = data.media_id;
    ok("trim media_id", trimMediaId);
  });

  // ── 3: Register AI_REMIX (unanchored — no parent declared) ──────────────────
  console.log(bold("\n▸ Stage 3 — Register AI_REMIX (Unanchored)"));

  let aiMediaId = null;

  await check("POST /v1/register (ai_remix)", async () => {
    const aiBytes = fakeJpeg("ai_deepfake_remix");
    const { body, contentType } = makeFormData(aiBytes, "deepfake.jpg", {
    edit_type: "0",       // ORIGINAL — bad actor claims it's original
    ai_score: "9200",     // 92% AI probability flags it
    description: "Suspicious re-upload — claims to be original",
        });
    const { status, data } = await post("/v1/register", body, contentType);
    if (status !== 200) throw new Error(`status ${status}: ${JSON.stringify(data)}`);
    aiMediaId = data.media_id;
    ok("ai media_id", aiMediaId);
  });

  // ── 4: Verify the original (exact hash match) ────────────────────────────────
  console.log(bold("\n▸ Stage 4 — Verify Original (Exact Match)"));

  await check("POST /v1/verify (original bytes)", async () => {
    const { body, contentType } = makeFormData(originalBytes, "check_this.jpg");
    const { status, data } = await post("/v1/verify", body, contentType);
    if (status !== 200) throw new Error(`status ${status}`);
    if (data.verdict !== "VERIFIED_ORIGINAL") throw new Error(`unexpected verdict: ${data.verdict}`);
    ok("verdict", data.verdict);
    ok("confidence", data.confidence);
    ok("origin.creator", data.origin?.creator ?? "n/a");
  });

  // ── 5: Verify unknown file (UNVERIFIED) ──────────────────────────────────────
  console.log(bold("\n▸ Stage 5 — Verify Unknown File"));

  await check("POST /v1/verify (unknown bytes)", async () => {
    const unknownBytes = fakeJpeg("completely_unknown_file_" + Date.now());
    const { body, contentType } = makeFormData(unknownBytes, "unknown.jpg");
    const { status, data } = await post("/v1/verify", body, contentType);
    if (status !== 200) throw new Error(`status ${status}`);
    const valid = ["UNVERIFIED", "AI_GENERATED"];
    if (!valid.includes(data.verdict)) throw new Error(`unexpected verdict: ${data.verdict}`);
    ok("verdict", data.verdict);
    ok("flags", data.flags?.join(", "));
  });

  // ── 6: Get media by ID ───────────────────────────────────────────────────────
  console.log(bold("\n▸ Stage 6 — Get Media Record by ID"));

  await check("GET /v1/media/:id", async () => {
    if (!originalMediaId) throw new Error("Skip — no original registered");
    const { status, data } = await get(`/v1/media/${originalMediaId}`);
    if (status !== 200) throw new Error(`status ${status}`);
    if (data.mediaId !== originalMediaId) throw new Error("ID mismatch");
    ok("mediaId", data.mediaId);
    ok("integrity", data.integrity);
    ok("editType", data.editType);
    ok("revoked", data.revoked);
  });

  // ── 7: Provenance graph ──────────────────────────────────────────────────────
  console.log(bold("\n▸ Stage 7 — Provenance Graph"));

  await check("GET /v1/media/:id/graph", async () => {
    if (!originalMediaId) throw new Error("Skip — no original registered");
    const { status, data } = await get(`/v1/media/${originalMediaId}/graph`);
    if (status !== 200) throw new Error(`status ${status}`);
    if (!Array.isArray(data.nodes)) throw new Error("No nodes array");
    ok("graph nodes", data.nodes.length);
    ok("graph edges", data.edges.length);
    data.nodes.forEach((n, i) => console.log(`    ${yellow("node")} #${i}: ${n.mediaId?.slice(0, 16)}… integrity=${n.integrity}`));
  });

  // ── 8: Hash search ───────────────────────────────────────────────────────────
  console.log(bold("\n▸ Stage 8 — Hash Search"));

  await check("GET /v1/search?hash=...", async () => {
    const crypto2 = require("crypto");
    const hashHex = crypto2.createHash("sha256").update(originalBytes).digest("hex");
    const { status, data } = await get(`/v1/search?hash=${hashHex}`);
    if (status !== 200) throw new Error(`status ${status}`);
    if (!data) throw new Error("No result returned");
    ok("found entry", data.mediaId?.slice(0, 20) + "…");
  });

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(bold("\n╔══════════════════════════════════════════╗"));
  console.log(bold(`║  Results: ${green(passed + " passed")}  ${failed > 0 ? red(failed + " failed") : "0 failed"}               ║`));
  console.log(bold("╚══════════════════════════════════════════╝\n"));

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(red("\nFatal error:"), err.message);
  process.exit(1);
});