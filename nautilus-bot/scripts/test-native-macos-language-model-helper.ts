#!/usr/bin/env bun
// Run through realistic-hardware/build-slot.sh. This parses SDK fixtures without model generation.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
  console.log(JSON.stringify({ result: "skipped", reason: "requires macOS" }));
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(join(root, "scripts/native-macos-language-model-helper.swift"), "utf8");
const fixture = readFileSync(join(root, "scripts/fixtures/apple-response-completeness.swift"), "utf8");
const entry = source.indexOf("// MARK: - Entry point");
if (entry < 0) throw new Error("The helper entry point is missing");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
console.log(JSON.stringify({ sourceSha256: digest(source), fixtureSha256: digest(fixture) }));
const directory = mkdtempSync(join(tmpdir(), "plainsong-apple-codec-"));
try {
  const file = join(directory, "main.swift");
  writeFileSync(file, source.slice(0, entry) + "\n" + fixture);
  const result = spawnSync("/usr/bin/xcrun", ["swift", file], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
