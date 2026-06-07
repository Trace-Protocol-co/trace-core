/**
 * TRACE Collective Memory Bank — Sighting Module
 * 
 * Every verification writes a sighting record to MemWal.
 * The bank grows with every encounter, regardless of verdict.
 * This is the foundation of the Collective Memory Bank (F-9).
 */

import crypto from "crypto";

export interface SightingRecord {
  sighting_id:   string;
  media_fingerprint: {
    content_hash:   string;
    perceptual_hash: string;
    media_type:     string;
  };
  first_seen: {
    timestamp:              string;
    platform:               string;
    geographic_region:      string;
    agent_verdict_at_encounter: string;
  };
  trace_registry_status: {
    registered:               boolean;
    sui_object_id:            string | null;
    registration_delta_hours: number | null;
  };
  spread: {
    sighting_count: number;
    sources:        string[];
    last_seen:      string;
  };
  contributed_by: string; // anonymized agent hash — Seal would encrypt this
  bank_blob_id:   string | null; // Walrus blob storing this sighting
}

// ── Anonymous contributor ID ──────────────────────────────────────────────────
// Privacy: contributor is hashed, not stored as raw identity
// In full Seal integration this would be threshold-encrypted
export function anonymousAgentId(seed: string = "trace-server"): string {
  return "agent_" + crypto.createHash("sha256")
    .update(seed + (process.env.TRACE_PACKAGE_ID ?? ""))
    .digest("hex")
    .slice(0, 16);
}

// ── Build a sighting record ───────────────────────────────────────────────────
export function buildSighting(params: {
  contentHash:   string;
  perceptualHash: string;
  mediaType:     string;
  verdict:       string;
  platform:      string;
  registryEntry: { mediaId?: string; timestamp?: number } | null;
}): SightingRecord {
  const { contentHash, perceptualHash, mediaType, verdict, platform, registryEntry } = params;

  const now = new Date().toISOString();
  const sightingId = "sight_" + crypto.randomBytes(8).toString("hex");

  let deltaHours: number | null = null;
  if (registryEntry?.timestamp) {
    deltaHours = Math.round(
      (Date.now() - registryEntry.timestamp) / (1000 * 60 * 60)
    );
  }

  return {
    sighting_id: sightingId,
    media_fingerprint: {
      content_hash:   contentHash,
      perceptual_hash: perceptualHash,
      media_type:     mediaType,
    },
    first_seen: {
      timestamp:              now,
      platform:               platform,
      geographic_region:      "UNKNOWN",
      agent_verdict_at_encounter: verdict,
    },
    trace_registry_status: {
      registered:               !!registryEntry,
      sui_object_id:            registryEntry?.mediaId ?? null,
      registration_delta_hours: deltaHours,
    },
    spread: {
      sighting_count: 1,
      sources:        [platform],
      last_seen:      now,
    },
    contributed_by: anonymousAgentId(),
    bank_blob_id:   null,
  };
}

// ── Write sighting to MemWal ──────────────────────────────────────────────────
export async function writeSightingToBank(sighting: SightingRecord): Promise<string | null> {
  const memwalKey = process.env.MEMWAL_PRIVATE_KEY;
  const accountId = process.env.MEMWAL_ACCOUNT_ID;

  if (!memwalKey || !accountId) return null;

  try {
    const { rememberVerification } = await import("./memwal-integration.js");

    // Format as semantic text so MemWal can recall by meaning
    const text = [
      `Sighting ${sighting.sighting_id}: media with hash ${sighting.media_fingerprint.content_hash.slice(0, 16)} encountered.`,
      `Verdict: ${sighting.first_seen.agent_verdict_at_encounter}.`,
      `Platform: ${sighting.first_seen.platform}.`,
      `Time: ${sighting.first_seen.timestamp}.`,
      sighting.trace_registry_status.registered
        ? `Found in TRACE registry. Sui object: ${sighting.trace_registry_status.sui_object_id}.`
        : "Not in TRACE registry at time of encounter.",
      sighting.trace_registry_status.registration_delta_hours !== null
        ? `Registration lag: ${sighting.trace_registry_status.registration_delta_hours} hours.`
        : "",
    ].filter(Boolean).join(" ");

    const blobId = await rememberVerification({
      imageUrl:   `hash:${sighting.media_fingerprint.content_hash}`,
      source:     sighting.first_seen.platform,
      verdict:    sighting.first_seen.agent_verdict_at_encounter,
      confidence: sighting.trace_registry_status.registered ? 0.95 : 0.5,
      hash:       sighting.media_fingerprint.content_hash,
      mediaId:    sighting.trace_registry_status.sui_object_id ?? undefined,
    });

    return blobId;
  } catch (e) {
    console.warn("[Bank] MemWal write failed:", e);
    return null;
  }
}

// ── Query bank for known sightings ────────────────────────────────────────────
export async function queryBank(contentHash: string): Promise<{
  known:          boolean;
  sighting_count: number;
  first_seen?:    string;
  sources?:       string[];
  memories?:      { text: string; blob_id: string; distance: number }[];
}> {
  const memwalKey = process.env.MEMWAL_PRIVATE_KEY;
  if (!memwalKey) return { known: false, sighting_count: 0 };

  try {
    const { recallMemories } = await import("./memwal-integration.js");
    const results = await recallMemories(`hash ${contentHash.slice(0, 16)}`, 5);

    if (!results.length) return { known: false, sighting_count: 0 };

    return {
      known:          true,
      sighting_count: results.length,
      first_seen:     results[results.length - 1]?.text?.match(/Time: ([^.]+)/)?.[1],
      sources:        [...new Set(results.map(r => r.text.match(/Platform: ([^.]+)/)?.[1] ?? "unknown"))],
      memories:       results,
    };
  } catch {
    return { known: false, sighting_count: 0 };
  }
}