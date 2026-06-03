/**
 * TRACE — PostgreSQL Database Layer
 * Falls back to in-memory + JSON file when DATABASE_URL not set (local dev)
 */

import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";

export interface RegistryEntry {
  mediaId:       string;
  blobId:        string;
  contentHash:   string;
  perceptualHash: string;
  creator:       string;
  creatorEmail?: string;
  timestamp:     number;
  suiTx:         string;
  editType:      number;
  integrity:     number;
  aiScore:       number;
  parentId?:     string;
  revoked:       boolean;
  certificateUrl: string;
  description:   string;
}

// ── In-memory fallback ────────────────────────────────────────────────────────
const memRegistry    = new Map<string, RegistryEntry>(); // key: contentHash
const memRegistryById = new Map<string, RegistryEntry>(); // key: mediaId

const DATA_FILE = path.join(process.cwd(), "data", "registry.json");

function saveToFile() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(Array.from(memRegistryById.values()), null, 2));
  } catch (e) { console.warn("[DB] Could not save to file:", e); }
}

function loadFromFile() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const entries: RegistryEntry[] = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    for (const e of entries) {
      memRegistry.set(e.contentHash, e);
      memRegistryById.set(e.mediaId, e);
    }
    console.log(`[DB] Loaded ${entries.length} entries from file`);
  } catch (e) { console.warn("[DB] Could not load from file:", e); }
}

// ── PostgreSQL ────────────────────────────────────────────────────────────────
let pgPool: Pool | null = null;

async function getPool(): Promise<Pool | null> {
  if (!process.env.DATABASE_URL) return null;
  if (pgPool) return pgPool;
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  });
  await initSchema(pgPool);
  return pgPool;
}

async function initSchema(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_registry (
      media_id        VARCHAR PRIMARY KEY,
      blob_id         VARCHAR,
      content_hash    VARCHAR UNIQUE,
      perceptual_hash VARCHAR,
      creator         VARCHAR,
      creator_email   VARCHAR,
      timestamp       BIGINT,
      sui_tx          VARCHAR,
      edit_type       INTEGER DEFAULT 0,
      integrity       INTEGER DEFAULT 0,
      ai_score        INTEGER DEFAULT 0,
      parent_id       VARCHAR,
      revoked         BOOLEAN DEFAULT FALSE,
      certificate_url VARCHAR,
      description     TEXT,
      created_at      TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_content_hash ON media_registry(content_hash);
    CREATE INDEX IF NOT EXISTS idx_creator ON media_registry(creator);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON media_registry(timestamp DESC);
  `);
  console.log("[DB] PostgreSQL schema ready");
}

// ── Public interface ──────────────────────────────────────────────────────────

export async function dbInit() {
  const pool = await getPool();
  if (!pool) {
    loadFromFile();
    console.log("[DB] Using file-based storage (no DATABASE_URL set)");
  } else {
    console.log("[DB] Connected to PostgreSQL");
  }
}

export async function dbSave(entry: RegistryEntry): Promise<void> {
  // Always update in-memory for fast reads
  memRegistry.set(entry.contentHash, entry);
  memRegistryById.set(entry.mediaId, entry);

  const pool = await getPool();
  if (!pool) { saveToFile(); return; }

  await pool.query(`
    INSERT INTO media_registry (
      media_id, blob_id, content_hash, perceptual_hash, creator, creator_email,
      timestamp, sui_tx, edit_type, integrity, ai_score, parent_id,
      revoked, certificate_url, description
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (content_hash) DO UPDATE SET
      revoked = EXCLUDED.revoked,
      description = EXCLUDED.description
  `, [
    entry.mediaId, entry.blobId, entry.contentHash, entry.perceptualHash,
    entry.creator, entry.creatorEmail ?? null, entry.timestamp, entry.suiTx,
    entry.editType, entry.integrity, entry.aiScore, entry.parentId ?? null,
    entry.revoked, entry.certificateUrl, entry.description,
  ]);
}

export async function dbGetByHash(hash: string): Promise<RegistryEntry | null> {
  // Check memory first
  if (memRegistry.has(hash)) return memRegistry.get(hash)!;

  const pool = await getPool();
  if (!pool) return null;

  const { rows } = await pool.query(
    "SELECT * FROM media_registry WHERE content_hash = $1", [hash]
  );
  if (!rows[0]) return null;
  const e = rowToEntry(rows[0]);
  memRegistry.set(e.contentHash, e);
  memRegistryById.set(e.mediaId, e);
  return e;
}

export async function dbGetById(mediaId: string): Promise<RegistryEntry | null> {
  if (memRegistryById.has(mediaId)) return memRegistryById.get(mediaId)!;

  const pool = await getPool();
  if (!pool) return null;

  const { rows } = await pool.query(
    "SELECT * FROM media_registry WHERE media_id = $1", [mediaId]
  );
  if (!rows[0]) return null;
  const e = rowToEntry(rows[0]);
  memRegistryById.set(e.mediaId, e);
  return e;
}

export async function dbList(filters: {
  creator?: string; integrity?: number; editType?: number;
  fromDate?: number; toDate?: number; q?: string;
  sort?: string; order?: string; page?: number; limit?: number;
}): Promise<{ items: RegistryEntry[]; total: number }> {
  const pool = await getPool();

  // Use in-memory if no DB
  if (!pool) {
    let items = Array.from(memRegistryById.values());
    if (filters.creator) items = items.filter(e => e.creator.toLowerCase().includes(filters.creator!.toLowerCase()));
    if (filters.integrity !== undefined) items = items.filter(e => e.integrity === filters.integrity);
    if (filters.q) {
      const q = filters.q.toLowerCase();
      items = items.filter(e =>
        e.mediaId.includes(q) || e.description.toLowerCase().includes(q) ||
        e.creator.toLowerCase().includes(q) || e.contentHash.includes(q)
      );
    }
    items.sort((a, b) => b.timestamp - a.timestamp);
    const page = filters.page ?? 1;
    const limit = Math.min(filters.limit ?? 20, 100);
    return { items: items.slice((page-1)*limit, page*limit), total: items.length };
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (filters.creator)   { conditions.push(`creator ILIKE $${i++}`); params.push(`%${filters.creator}%`); }
  if (filters.integrity !== undefined) { conditions.push(`integrity = $${i++}`); params.push(filters.integrity); }
  if (filters.q) {
    conditions.push(`(media_id ILIKE $${i} OR description ILIKE $${i} OR creator ILIKE $${i})`);
    params.push(`%${filters.q}%`); i++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const order = filters.order === "asc" ? "ASC" : "DESC";
  const sort  = ["timestamp","ai_score"].includes(filters.sort ?? "") ? filters.sort : "timestamp";
  const page  = Math.max(1, filters.page ?? 1);
  const limit = Math.min(filters.limit ?? 20, 100);
  const offset = (page - 1) * limit;

  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query(`SELECT * FROM media_registry ${where} ORDER BY ${sort} ${order} LIMIT $${i} OFFSET $${i+1}`,
      [...params, limit, offset]),
    pool.query(`SELECT COUNT(*) FROM media_registry ${where}`, params),
  ]);

  const items = rows.map(rowToEntry);
  items.forEach(e => { memRegistryById.set(e.mediaId, e); memRegistry.set(e.contentHash, e); });

  return { items, total: parseInt(countRows[0].count) };
}

export async function dbCount(): Promise<number> {
  const pool = await getPool();
  if (!pool) return memRegistryById.size;
  const { rows } = await pool.query("SELECT COUNT(*) FROM media_registry");
  return parseInt(rows[0].count);
}

export function dbGetMemRegistry() { return memRegistry; }
export function dbGetMemRegistryById() { return memRegistryById; }

function rowToEntry(row: Record<string, unknown>): RegistryEntry {
  return {
    mediaId:        String(row.media_id),
    blobId:         String(row.blob_id ?? ""),
    contentHash:    String(row.content_hash),
    perceptualHash: String(row.perceptual_hash ?? ""),
    creator:        String(row.creator ?? ""),
    creatorEmail:   row.creator_email ? String(row.creator_email) : undefined,
    timestamp:      Number(row.timestamp),
    suiTx:          String(row.sui_tx ?? ""),
    editType:       Number(row.edit_type ?? 0),
    integrity:      Number(row.integrity ?? 0),
    aiScore:        Number(row.ai_score ?? 0),
    parentId:       row.parent_id ? String(row.parent_id) : undefined,
    revoked:        Boolean(row.revoked),
    certificateUrl: String(row.certificate_url ?? ""),
    description:    String(row.description ?? ""),
  };
}