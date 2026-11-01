#!/usr/bin/env bun
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { collectAppBundleIdentity } from "../lib/release-candidate-identity.ts";
import { microphoneReceiptFromFootprint, retainedFootprintReceipt } from "../lib/candidate-qa-receipts.ts";

const args = process.argv.slice(2);
function required(flag: string) {
  const index = args.indexOf(flag);
  const value = args[index + 1];
  if (index < 0 || !value || value.startsWith("--")) throw new Error(`Missing ${flag}`);
  return path.resolve(value);
}
const app = path.join(required("--candidate"), "mac-arm64/Plainsong.app");
const qa = required("--qa-dir");
const hash = collectAppBundleIdentity(app)?.sha256;
if (!hash) throw new Error("Candidate app is missing");
function read(file: string): unknown { return JSON.parse(fs.readFileSync(file, "utf8")); }
function provenance(file: string) {
  return { path: file, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
}
// Validate all requested conversions before writing any receipt. No app or model runs.
const writes: { name: string; receipt: object; sources: string[] }[] = [];
for (const gb of [8, 16]) {
  const flag = `--footprint-${gb}gb`;
  if (args.includes(flag)) {
    const file = required(flag);
    writes.push({ name: `footprint-${gb}gb.json`, receipt: retainedFootprintReceipt(read(file), hash), sources: [file] });
  }
}
if (args.includes("--microphone-footprint")) {
  const footprint = required("--microphone-footprint");
  const capture = required("--microphone-capture");
  writes.push({ name: "capture-meeting-mic.json", receipt: microphoneReceiptFromFootprint({
    footprint: read(footprint), capture: read(capture), appBundleSha256: hash,
  }), sources: [footprint, capture] });
}
if (!writes.length) throw new Error("Select --footprint-8gb, --footprint-16gb or --microphone-footprint with --microphone-capture");
fs.mkdirSync(qa, { recursive: true });
for (const { name, receipt, sources } of writes) {
  const out = path.join(qa, name);
  if (fs.existsSync(out)) throw new Error(`Refusing to overwrite ${out}; use a fresh QA directory`);
  fs.writeFileSync(out, `${JSON.stringify({ ...receipt, conversion: {
    generatedAt: new Date().toISOString(), method: "retained-raw-output", sources: sources.map(provenance),
  } }, null, 2)}\n`);
  console.log(out);
}
