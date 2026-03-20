#!/usr/bin/env node
/**
 * Generates a Tauri Ed25519 updater keypair and writes the public key into
 * src-tauri/tauri.conf.json automatically.
 *
 * Run once from the nautilus-bot directory after `npm install`:
 *   node scripts/setup-updater-key.js
 *
 * Keep the printed PRIVATE KEY in TAURI_SIGNING_PRIVATE_KEY (CI/CD secret).
 * NEVER commit the private key to git.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TAURI_CONF = path.join(ROOT, "src-tauri", "tauri.conf.json");
const TAURI_BIN = path.join(ROOT, "node_modules", ".bin", "tauri");

if (!fs.existsSync(TAURI_BIN)) {
  console.error("ERROR: Tauri CLI not found. Run `npm install` first.");
  process.exit(1);
}

console.log("Generating Tauri updater keypair…");
console.log("Generating an unencrypted local updater key for build automation.\n");

const result = spawnSync(TAURI_BIN, ["signer", "generate", "--ci", "--password", ""], {
  stdio: ["inherit", "pipe", "pipe"],
  encoding: "utf-8",
});

const output = (result.stdout ?? "") + (result.stderr ?? "");
console.log(output);

const match = output.match(/Public Key:\s*(\S+)/);
if (!match) {
  console.error(
    "\nERROR: Could not parse public key from tauri signer output."
  );
  console.error(
    "Run manually:  ./node_modules/.bin/tauri signer generate"
  );
  console.error(
    "Then paste the Public Key into src-tauri/tauri.conf.json → plugins.updater.pubkey"
  );
  process.exit(1);
}

const pubkey = match[1];

const conf = JSON.parse(fs.readFileSync(TAURI_CONF, "utf-8"));

if (!conf?.plugins?.updater) {
  console.error("ERROR: plugins.updater section not found in tauri.conf.json");
  process.exit(1);
}

conf.plugins.updater.pubkey = pubkey;
fs.writeFileSync(TAURI_CONF, JSON.stringify(conf, null, 2) + "\n");

console.log(`\n✅  Updated src-tauri/tauri.conf.json with the generated public key.`);
console.log("\n⚠️   Save the PRIVATE KEY printed above as:");
console.log("      TAURI_SIGNING_PRIVATE_KEY          — CI/CD secret (GitHub Actions, etc.)");
console.log("      TAURI_SIGNING_PRIVATE_KEY_PASSWORD — if you set a password above");
console.log("\n    Do NOT commit the private key to git.");
