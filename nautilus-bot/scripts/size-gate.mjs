#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function valueFor(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function directoryBytes(targetPath) {
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) return stat.size;

  let total = 0;
  const stack = [targetPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        total += fs.statSync(entryPath).size;
      }
    }
  }
  return total;
}

const appPath = valueFor("--app");
if (!appPath) {
  console.error("Usage: node scripts/size-gate.mjs --app <path-to-app-or-binary> [--max-mb 450]");
  process.exit(1);
}

const maxMbRaw = valueFor("--max-mb", "35");
const maxMb = Number(maxMbRaw);
if (!Number.isFinite(maxMb) || maxMb <= 0) {
  console.error(`Invalid --max-mb value: ${maxMbRaw}`);
  process.exit(1);
}

const resolvedPath = path.resolve(process.cwd(), appPath);
if (!fs.existsSync(resolvedPath)) {
  console.error(`Target does not exist: ${resolvedPath}`);
  process.exit(1);
}

const totalBytes = directoryBytes(resolvedPath);
const totalMb = totalBytes / (1024 * 1024);
const pass = totalMb <= maxMb;

console.log(
  JSON.stringify(
    {
      target: resolvedPath,
      sizeBytes: totalBytes,
      sizeMb: Number(totalMb.toFixed(2)),
      maxMb,
      pass,
    },
    null,
    2
  )
);

if (!pass) {
  process.exit(2);
}
