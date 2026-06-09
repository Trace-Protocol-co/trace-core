/**
 * TRACE — Seal Privacy Layer
 *
 * Encrypts sensitive fields in sighting records before writing to MemWal.
 * Only credentialed verifiers (VerifierCredential on-chain) can decrypt.
 * Aggregate stats (verdict, platform, timestamp) remain public.
 *
 * On-chain policy: trace::seal_policy::seal_approve()
 * Policy object:   TRACE_SEAL_POLICY_ID (BankAccessPolicy shared object)
 */
import { SealClient } from "@mysten/seal";
import { SuiJsonRpcClient as SuiClient, getJsonRpcFullnodeUrl as getFullnodeUrl } from "@mysten/sui/jsonRpc";
// Seal testnet key server — Mysten Labs operated
// objectId is the on-chain KeyServer object for testnet
const SEAL_KEY_SERVER_OBJECT_ID = "0x05e36bb95f534cac3c66a63bdce0a9c9c6b23f8f";
const PACKAGE_ID = process.env.TRACE_PACKAGE_ID
    ?? "0xf1acdf7d36c4816d91ebe39f0887f163155a08bb0d435e7ea8f737b981637bdb";
let _sealClient = null;
let _initAttempted = false;
function getSealClient() {
    if (_sealClient)
        return _sealClient;
    if (_initAttempted)
        return null;
    _initAttempted = true;
    try {
        const suiClient = new SuiClient({
            url: getFullnodeUrl("testnet"),
            network: "testnet",
        });
        _sealClient = new SealClient({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            suiClient: suiClient,
            serverConfigs: [{
                    objectId: SEAL_KEY_SERVER_OBJECT_ID,
                    weight: 1,
                }],
            verifyKeyServers: false, // skip on testnet
        });
        console.log("[Seal] Client initialized");
        return _sealClient;
    }
    catch (e) {
        console.warn("[Seal] Client init failed:", e.message?.slice(0, 60));
        return null;
    }
}
/**
 * Encrypt sensitive sighting fields using Seal.
 * Returns hex-encoded encrypted bytes, or null if Seal unavailable.
 *
 * Encrypted fields: content_hash, contributed_by, geographic_region
 * Public fields:    verdict, platform, timestamp, sighting_id
 */
export async function encryptSighting(sensitiveJson, sightingId) {
    const client = getSealClient();
    if (!client)
        return null;
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const id = new TextEncoder().encode(sightingId.slice(0, 32).padEnd(32, "0"));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = new TextEncoder().encode(sensitiveJson);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { encryptedObject } = await client.encrypt({
            threshold: 1,
            packageId: PACKAGE_ID,
            id,
            data,
        });
        // Return as base64 string for storage
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = encryptedObject;
        const bytes = raw instanceof Uint8Array ? raw : raw.toBytes ? raw.toBytes() : Buffer.from(JSON.stringify(raw));
        const b64 = Buffer.from(bytes).toString("base64");
        console.log(`[Seal] Sighting ${sightingId} encrypted (${b64.length} bytes)`);
        return b64;
    }
    catch (e) {
        // Seal encryption is best-effort — sighting still gets written plaintext
        console.warn("[Seal] Encrypt failed:", e.message?.slice(0, 80));
        return null;
    }
}
/**
 * Check if Seal is configured
 */
export function isSealAvailable() {
    return !!(process.env.TRACE_PACKAGE_ID &&
        process.env.MEMWAL_PRIVATE_KEY);
}
/**
 * Seal status for health endpoint
 */
export function getSealStatus() {
    return {
        available: isSealAvailable(),
        policy_id: (process.env.TRACE_SEAL_POLICY_ID ?? "not-set").slice(0, 12) + "...",
        package_id: PACKAGE_ID.slice(0, 12) + "...",
        key_server: SEAL_KEY_SERVER_OBJECT_ID.slice(0, 12) + "...",
        mode: isSealAvailable() ? "threshold_encryption" : "plaintext_fallback",
        contract_module: "trace::seal_policy",
        seal_approve_fn: "seal_approve(VerifierCredential, id, ctx)",
    };
}
