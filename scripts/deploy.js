#!/usr/bin/env node
/**
 * TRACE — Deploy Script
 * Publishes the Move package to Sui testnet and writes TRACE_PACKAGE_ID to .env
 *
 * Prerequisites:
 *   - sui CLI installed and configured (sui client active-address shows your address)
 *   - Active address has testnet SUI for gas
 *
 * Run: node scripts/deploy.js
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const MOVE_DIR = path.join(__dirname, "../move");
const ENV_FILE = path.join(__dirname, "../.env");
const ENV_EXAMPLE = path.join(__dirname, "../.env.example");

// Bootstrap .env from example if it doesn't exist
if (!fs.existsSync(ENV_FILE)) {
  fs.copyFileSync(ENV_EXAMPLE, ENV_FILE);
  console.log("Created .env from .env.example");
}

console.log("╔══════════════════════════════════════╗");
console.log("║   TRACE — Move Package Deployment    ║");
console.log("╚══════════════════════════════════════╝");
console.log("");

// 1. Check sui CLI
try {
  const ver = execSync("sui --version", { encoding: "utf8" }).trim();
  console.log("✓ Sui CLI:", ver);
} catch {
  console.error("✗ sui CLI not found. Install from: https://docs.sui.io/guides/developer/getting-started/sui-install");
  process.exit(1);
}

// 2. Show active address
let activeAddress;
try {
  activeAddress = execSync("sui client active-address", { encoding: "utf8" }).trim();
  console.log("✓ Active address:", activeAddress);
} catch {
  console.error("✗ No active Sui address. Run: sui client new-address ed25519");
  process.exit(1);
}

// 3. Check balance
try {
  const balance = execSync(`sui client balance`, { encoding: "utf8" });
  console.log("✓ Balance check:\n", balance.trim());
} catch {
  console.warn("⚠ Could not check balance. Make sure you have testnet SUI.");
  console.warn("  Get testnet SUI: sui client faucet");
}

// 4. Build and publish
console.log("\n→ Publishing Move package (this takes ~30s)...\n");

let publishOutput;
try {
  publishOutput = execSync(
    `sui client publish --gas-budget 100000000 --json ${MOVE_DIR}`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
} catch (err) {
  console.error("✗ Publish failed:\n", err.stderr ?? err.message);
  process.exit(1);
}

// 5. Parse output for package ID
let packageId;
try {
  const json = JSON.parse(publishOutput);

  // Look in objectChanges for Published type
  const published = json.objectChanges?.find(
    (c) => c.type === "published"
  );
  if (published) {
    packageId = published.packageId;
  }

  // Fallback: effects.created
  if (!packageId) {
    const digest = json.digest;
    console.log("TX Digest:", digest);
    // Try parsing from effects
    const created = json.effects?.created ?? [];
    for (const obj of created) {
      if (obj.owner === "Immutable") {
        packageId = obj.reference?.objectId;
        break;
      }
    }
  }
} catch (e) {
  console.error("✗ Could not parse publish output as JSON.");
  console.log("Raw output:\n", publishOutput.slice(0, 2000));
  process.exit(1);
}

if (!packageId) {
  console.error("✗ Could not extract package ID from publish output.");
  console.log("Full output:\n", publishOutput.slice(0, 3000));
  process.exit(1);
}

console.log("\n✓ Package published!");
console.log("  Package ID:", packageId);

// 6. Write to .env
let envContent = fs.readFileSync(ENV_FILE, "utf8");
if (envContent.includes("TRACE_PACKAGE_ID=")) {
  envContent = envContent.replace(/TRACE_PACKAGE_ID=.*/, `TRACE_PACKAGE_ID=${packageId}`);
} else {
  envContent += `\nTRACE_PACKAGE_ID=${packageId}\n`;
}
fs.writeFileSync(ENV_FILE, envContent);

console.log("  Written to .env ✓");
console.log("");
console.log("╔══════════════════════════════════════╗");
console.log("║        Deployment Complete!          ║");
console.log(`║  Package: ${packageId.slice(0, 20)}...  ║`);
console.log("╚══════════════════════════════════════╝");
console.log("");
console.log("Next steps:");
console.log("  1. npm run dev   ← start the API server");
console.log("  2. curl http://localhost:3001/v1/health");