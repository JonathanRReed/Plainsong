// NOTE: this hand-rolled dmg is NOT what releases ship. The release workflow
// runs `electron-builder --mac`, which builds the dmg target declared in
// electron-builder.yml. This script only supports local ad-hoc dmg packaging
// around an already-built zip-mode app (`electron:build:dmg`).
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const productName = packageJson.productName ?? "Plainsong";
const version = packageJson.version;
const arch = process.argv.includes("--x64") ? "x64" : "arm64";

const releaseDir = join(repoRoot, "release");
const appPath = join(releaseDir, `mac-${arch}`, `${productName}.app`);
const dmgPath = join(releaseDir, `${productName}-${version}-${arch}.dmg`);

function detectSigningIdentity() {
  if (process.env.CSC_NAME) {
    return process.env.CSC_NAME;
  }

  try {
    const result = spawnSync("codesign", ["-dv", "--verbose=4", appPath], {
      encoding: "utf8",
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const authorityLine = output
      .split("\n")
      .find((line) => line.startsWith("Authority="));
    return authorityLine?.slice("Authority=".length).trim() || null;
  } catch {
    return null;
  }
}

if (!existsSync(appPath)) {
  throw new Error(`Signed app not found at ${appPath}`);
}

const stagingRoot = mkdtempSync(join(tmpdir(), `${productName.toLowerCase()}-dmg-`));
const stagingDir = join(stagingRoot, `${productName} Installer`);

try {
  mkdirSync(stagingDir, { recursive: true });
  execFileSync("ditto", [appPath, join(stagingDir, `${productName}.app`)], {
    stdio: "inherit",
  });
  symlinkSync("/Applications", join(stagingDir, "Applications"));

  rmSync(dmgPath, { force: true });

  execFileSync(
    "hdiutil",
    [
      "create",
      "-volname",
      productName,
      "-srcfolder",
      stagingDir,
      "-ov",
      "-format",
      "UDZO",
      "-fs",
      "APFS",
      dmgPath,
    ],
    { stdio: "inherit" },
  );

  const identity = detectSigningIdentity();
  if (identity) {
    execFileSync("codesign", ["--sign", identity, "--force", "--timestamp", dmgPath], {
      stdio: "inherit",
    });
  }

  console.log(JSON.stringify({ dmgPath, signed: Boolean(identity) }, null, 2));
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}
