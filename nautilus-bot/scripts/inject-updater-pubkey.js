#!/usr/bin/env node

/**
 * Inject updater public key into src-tauri/tauri.conf.json at build time.
 *
 * This keeps signing material out of the repository while ensuring release
 * artifacts never ship with the placeholder updater key.
 */

const fs = require("fs");
const path = require("path");

const PLACEHOLDER = "TODO_REPLACE_WITH_OUTPUT_OF_tauri_signer_generate";
const configPath = path.resolve(process.cwd(), "src-tauri", "tauri.conf.json");
const publicKey = (process.env.TAURI_SIGNING_PUBLIC_KEY || "").trim();

if (!publicKey) {
  console.error("Error: TAURI_SIGNING_PUBLIC_KEY is required.");
  process.exit(1);
}

if (!fs.existsSync(configPath)) {
  console.error(`Error: Could not find config file at ${configPath}`);
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (error) {
  console.error(`Error: Failed to parse ${configPath}: ${error.message}`);
  process.exit(1);
}

if (!config.plugins || !config.plugins.updater) {
  console.error("Error: plugins.updater config is missing in tauri.conf.json");
  process.exit(1);
}

const current = String(config.plugins.updater.pubkey || "").trim();
if (!current || current === PLACEHOLDER || current !== publicKey) {
  config.plugins.updater.pubkey = publicKey;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log("Updater public key injected into tauri.conf.json");
} else {
  console.log("Updater public key already set; no changes needed");
}
