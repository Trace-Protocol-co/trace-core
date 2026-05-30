/**
 * TRACE — Keypair Generator
 * Run: node scripts/genKeypair.js
 * Outputs a fresh Ed25519 keypair for dev/testnet use.
 */

const { Ed25519Keypair } = require("@mysten/sui/keypairs/ed25519");

const keypair = new Ed25519Keypair();
const address = keypair.getPublicKey().toSuiAddress();

// Export the secret key as hex
const secretBytes = keypair.getSecretKey(); // Uint8Array
const secretHex = Buffer.from(secretBytes).toString("hex");

console.log("========================================");
console.log("  TRACE — New Sui Keypair");
console.log("========================================");
console.log("Address    :", address);
console.log("Private Key:", secretHex);
console.log("========================================");
console.log("");
console.log("Add this to your .env file:");
console.log(`TRACE_PRIVATE_KEY=${secretHex}`);
console.log("");
console.log("Then fund it at:");
console.log(`https://faucet.triangleplatform.com/sui/testnet`);
console.log(`OR run: sui client faucet --address ${address}`);
console.log("========================================");