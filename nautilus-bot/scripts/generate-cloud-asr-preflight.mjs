#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/cloud-asr-preflight.json")
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "artifacts/cloud-asr-smoke.blocked.md")
);
const fixturePath = path.resolve(repoRoot, "scripts/fixtures/live-cloud-smoke.wav");
const fixtureSha256 = fs.existsSync(fixturePath)
  ? createHash("sha256").update(fs.readFileSync(fixturePath)).digest("hex")
  : null;
const requiredKeys = ["OPENAI_API_KEY", "ELEVENLABS_API_KEY", "MISTRAL_API_KEY"];

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${body.trimEnd()}\n`, "utf8");
}

function writeJson(filePath, value) {
  writeText(filePath, JSON.stringify(value, null, 2));
}

const generatedAt = new Date().toISOString();
const env = requiredKeys.map((name) => ({
  name,
  present: Boolean(process.env[name]?.trim()),
}));
const missing = env.filter((entry) => !entry.present).map((entry) => entry.name);
const fixtureExists = fs.existsSync(fixturePath) && fs.statSync(fixturePath).isFile();
const status = missing.length === 0 && fixtureExists ? "READY" : "BLOCKED";

const report = {
  generatedAt,
  status,
  pass: status === "READY",
  command: "bun run qa:cloud-asr:smoke",
  liveSmokeOutput: "artifacts/cloud-asr-smoke.json",
  liveSmokeVerifier: "scripts/verify-cloud-asr-smoke.mjs",
  fixture: path.relative(repoRoot, fixturePath),
  fixtureSha256,
  fixtureExists,
  requiredEnv: env,
  missingEnv: missing,
  secretPolicy: "Only key names and boolean presence are recorded. Secret values are never written.",
};

writeJson(outPath, report);
writeText(
  markdownPath,
  `# Cloud ASR Smoke Gate

Status: ${status}
Generated: ${generatedAt}

## Command

- Preflight: \`bun run gate:cloud-asr:preflight\`
- Live smoke: \`${report.command}\`
- Live output: \`${report.liveSmokeOutput}\`
- Live verifier: \`${report.liveSmokeVerifier}\`

## Secret-Safe Preflight

- Fixture exists: ${fixtureExists ? "yes" : "no"}
- Fixture SHA-256: ${fixtureSha256 ?? "missing"}
- Missing env vars: ${missing.length > 0 ? missing.join(", ") : "none"}
- Secret policy: ${report.secretPolicy}

## Required Follow-Up

- Provide \`OPENAI_API_KEY\`, \`ELEVENLABS_API_KEY\`, and \`MISTRAL_API_KEY\` in the environment.
- Run \`${report.command}\`.
- Run \`bun run gate:blockers:refresh\` after the live smoke passes.
`
);

console.log(JSON.stringify(report, null, 2));
process.exit(0);
