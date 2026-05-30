/**
 * TRACE — Export Sui key to hex format for .env
 * Run: node scripts/exportKey.js
 * 
 * This reads your Sui keystore and exports the active keypair
 * in the hex format needed for TRACE_PRIVATE_KEY in .env
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const KEYSTORE_PATH = path.join(os.homedir(), ".sui", "sui_config", "sui.keystore");

try {
  const keystore = JSON.parse(fs.readFileSync(KEYSTORE_PATH, "utf8"));
  
  console.log("========================================");
  console.log("  TRACE — Sui Keystore Export");
  console.log("========================================");
  console.log(`Found ${keystore.length} key(s) in keystore\n`);

  keystore.forEach((b64Key, i) => {
    // Sui keystore stores keys as base64-encoded [scheme_flag, ...32_byte_key]
    const raw = Buffer.from(b64Key, "base64");
    // First byte is the scheme flag (0 = Ed25519), rest is the 32-byte private key
    const privKeyHex = raw.slice(1).toString("hex");
    console.log(`Key ${i + 1}:`);
    console.log(`  Base64: ${b64Key.slice(0, 20)}...`);
    console.log(`  Hex:    ${privKeyHex}`);
    console.log(`  Add to .env: TRACE_PRIVATE_KEY=${privKeyHex}`);
    console.log();
  });

  console.log("========================================");
  console.log("Copy the hex for your ACTIVE address into .env");
  console.log("Active address: run 'sui client active-address' to confirm");
  console.log("========================================");

} catch (err) {
  console.error("Error reading keystore:", err.message);
  console.log("\nTry running: sui keytool list");
  console.log("Then manually copy your key using: sui keytool export --key-identity <address>");
}