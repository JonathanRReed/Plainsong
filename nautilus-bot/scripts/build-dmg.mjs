// NOTE: this hand-rolled dmg is NOT what releases ship. The release workflow
// runs `electron-builder --mac`, which builds the dmg target declared in
// electron-builder.yml. This script only supports local ad-hoc dmg packaging
// around an already-built zip-mode app (`electron:build:dmg`).
//
// That note existed and the beta.2 DMG still went out unnotarized, so it is now
// also printed at runtime, before and after the build. See `warnNotForRelease`.
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

/**
 * Say plainly, on stderr, that this artifact must not be distributed.
 *
 * A comment at the top of the file is invisible to whoever runs the script and
 * reads its output, which is how an unnotarized DMG built here reached users.
 * This produces no notarization submission, staples no ticket, applies no DMG
 * layout, and is never checked by `gate:release:macos:trust` — Gatekeeper will
 * refuse to open it on any Mac but this one.
 */
function warnNotForRelease(banner) {
  const line = "═".repeat(74);
  const lines = [
    "",
    line,
    "  ⚠  NOT A RELEASE ARTIFACT — DO NOT DISTRIBUTE THIS DMG  ⚠",
    line,
    "  This is scripts/build-dmg.mjs: a local, ad-hoc disk image for testing",
    "  the install gesture on this machine only.",
    "",
    "  It does NOT notarize. It does NOT staple a ticket. It does NOT apply",
    "  the DMG layout in electron-builder.yml, and no release gate inspects",
    "  it. Gatekeeper will refuse to open it on any other Mac.",
    "",
    "  The release path is:  bun run release:mac",
    "  (electron-builder --mac, then gate:release:macos:trust)",
    line,
    "",
  ];
  if (banner) lines.splice(1, 0, banner, "");
  console.error(lines.join("\n"));
}

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

warnNotForRelease();

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

  console.log(
    JSON.stringify(
      { dmgPath, signed: Boolean(identity), notarized: false, releaseArtifact: false },
      null,
      2,
    ),
  );
  // Repeated after the build so it is the last thing on screen, next to the
  // path someone is about to copy.
  warnNotForRelease(`  Built: ${dmgPath}`);
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}
