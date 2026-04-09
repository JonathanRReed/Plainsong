import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

const mode = process.argv[2] ?? "build";
const repoRoot = resolve(import.meta.dirname, "..");
const electronBuilderBin = resolve(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-builder.cmd" : "electron-builder"
);

function platformTargetArgs(currentMode) {
  if (currentMode === "pack") {
    if (process.platform === "darwin") {
      return ["--dir", "--mac"];
    }
    if (process.platform === "win32") {
      return ["--dir", "--win"];
    }
    return ["--dir", "--linux"];
  }

  if (process.platform === "darwin") {
    return ["--mac", "zip"];
  }
  if (process.platform === "win32") {
    return ["--win", "nsis"];
  }
  return ["--linux", "AppImage", "deb"];
}

const args = [...platformTargetArgs(mode), "--publish", "never"];
const result = spawnSync(electronBuilderBin, args, {
  cwd: repoRoot,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
