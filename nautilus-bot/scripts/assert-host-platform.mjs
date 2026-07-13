#!/usr/bin/env node
const expected = process.argv[2];
const expectedArch = process.argv[3];

if (!expected) {
  console.error(
    "Usage: node scripts/assert-host-platform.mjs <darwin|win32|linux> [arm64|x64]"
  );
  process.exit(1);
}

if (process.platform !== expected) {
  console.error(
    `This command must run on ${expected}. Current host platform is ${process.platform}.`
  );
  process.exit(1);
}

// The sidecar and shortcut helper are compiled for the host arch, so a
// mismatched host (e.g. an Intel Mac building the arm64-only artifact) would
// silently produce an app bundle with broken native binaries.
if (expectedArch && process.arch !== expectedArch) {
  console.error(
    `This command must run on ${expectedArch}. Current host arch is ${process.arch}.`
  );
  process.exit(1);
}
