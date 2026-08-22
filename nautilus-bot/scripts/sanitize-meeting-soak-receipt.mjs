#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { sanitizeMeetingSoakReceipt } from "./lib/meeting-soak-receipt.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const inputPath = path.resolve(
  repoRoot,
  valueFor("--input", "artifacts/qa/macos/capture-soak-3h.json"),
);
const outputPath = path.resolve(
  repoRoot,
  valueFor("--out", inputPath),
);

if (!fs.existsSync(inputPath)) {
  console.error(`Meeting soak receipt not found: ${inputPath}`);
  process.exit(1);
}

const artifact = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const sanitized = sanitizeMeetingSoakReceipt(artifact);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      inputPath,
      outputPath,
      pass: sanitized.pass === true,
      contentRedacted: sanitized.contentRedacted === true,
      transcriptEvidence: sanitized.transcriptEvidence,
    },
    null,
    2,
  ),
);
