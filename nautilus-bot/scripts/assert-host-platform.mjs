#!/usr/bin/env node
const expected = process.argv[2];

if (!expected) {
  console.error("Usage: node scripts/assert-host-platform.mjs <darwin|win32|linux>");
  process.exit(1);
}

if (process.platform !== expected) {
  console.error(
    `This command must run on ${expected}. Current host platform is ${process.platform}.`
  );
  process.exit(1);
}
