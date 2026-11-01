#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { notarizeArtifact } from "./lib/notary-upload.mjs";
import { expectedMacUpdateYaml, verifyAppUpdateConfig } from "./lib/app-update-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = (file, algorithm = "sha256", encoding = "hex") => crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);

export async function releaseMac({ output, resume = false, env = process.env, execute = (command, args, options) => spawnSync(command, args, options), sleep } = {}) {
  if (!output) throw new Error("Missing release output directory");
  output = path.resolve(output);
  const auth = env.APPLE_KEYCHAIN_PROFILE ? ["--keychain-profile", env.APPLE_KEYCHAIN_PROFILE] :
    env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID ? ["--apple-id", env.APPLE_ID, "--password", env.APPLE_APP_SPECIFIC_PASSWORD, "--team-id", env.APPLE_TEAM_ID] : null;
  if (!auth) throw new Error("Set APPLE_KEYCHAIN_PROFILE or explicit Apple notarization credentials");
  if (!resume && fs.existsSync(output) && fs.readdirSync(output).length) throw new Error("Use a fresh release directory, or --resume for its existing candidate");
  const candidatePath = path.join(output, "notary", "candidate.json");
  if (resume) {
    if (!fs.existsSync(candidatePath)) throw new Error("No candidate to resume");
    if (JSON.parse(fs.readFileSync(candidatePath, "utf8")).flowVersion !== 2) {
      throw new Error("Candidate uses the old single-submission flow; create a fresh candidate");
    }
  }
  fs.mkdirSync(path.join(output, "notary"), { recursive: true });
  // One owner for all submit/staple/package steps in this candidate directory.
  const lock = path.join(output, ".release-lock");
  fs.mkdirSync(lock);
  let sequence = 0;
  const redact = text => {
    let result = String(text ?? "");
    for (const name of ["APPLE_APP_SPECIFIC_PASSWORD", "CSC_KEY_PASSWORD", "CSC_LINK"]) if (env[name]) result = result.replaceAll(env[name], "[REDACTED]");
    return result;
  };
  const run = (step, command, args, { required = true, timeout = 4 * 3600_000 } = {}) => {
    const result = execute(command, args, { cwd: root, env, encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 });
    const receipt = { step, generatedAt: new Date().toISOString(), status: result.status ?? null, signal: result.signal ?? null, error: result.error ? redact(result.error.message) : null, stdout: redact(result.stdout), stderr: redact(result.stderr) };
    fs.writeFileSync(path.join(output, "notary", `${Date.now()}-${++sequence}-${step}.json`), JSON.stringify(receipt, null, 2) + "\n");
    if (required && (result.status !== 0 || result.error)) throw new Error(`Release step failed: ${step}. See ${output}/notary`);
    return receipt;
  };
  const builder = (step, target, extra = []) => run(step, process.execPath, ["x", "--no-install", "electron-builder", "--mac", target, "--arm64", "--publish", "never", `--config.directories.output=${output}`, "--config.mac.notarize=false", "--config.forceCodeSigning=true", ...extra]);
  let appTeam;
  const cdhash = (label, file) => {
    const result = run(`${label}-identity`, "/usr/bin/codesign", ["-dvvv", file]);
    const text = result.stderr + result.stdout;
    const hash = text.match(/^CDHash=([a-f0-9]+)$/m)?.[1];
    if (!hash || !text.includes("Authority=Developer ID Application:") || (label === "app" && !text.includes("(runtime)"))) throw new Error(`Missing Developer ID hardened-runtime signature: ${file}`);
    if (label === "app") {
      appTeam = text.match(/^TeamIdentifier=(.+)$/m)?.[1];
      if (!appTeam) throw new Error("App signature has no team identifier");
    }
    return hash;
  };
  const verify = (label, file, dmg = false) => {
    run(`${label}-stapler-validate`, "/usr/bin/xcrun", ["stapler", "validate", file]);
    run(`${label}-codesign-verify`, "/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", file]);
    run(`${label}-spctl`, "/usr/sbin/spctl", ["--assess", "--verbose=4", "--type", dmg ? "open" : "execute", ...(dmg ? ["--context", "context:primary-signature"] : []), file]);
  };
  try {
    fs.rmSync(path.join(output, "notary", "complete.json"), { force: true });
    fs.rmSync(path.join(output, "SHA256SUMS"), { force: true });
    if (!resume) {
      const compileArgs = [process.execPath, "run", "release:mac:compile"];
      // The host slot covers compilation only. Apple upload/wait/stapling must
      // never hold it. Do not wrap the release runner itself in build-slot.sh.
      if (env.PLAINSONG_BUILD_SLOT) {
        if (!path.isAbsolute(env.PLAINSONG_BUILD_SLOT)) throw new Error("PLAINSONG_BUILD_SLOT must be absolute");
        run("compile", env.PLAINSONG_BUILD_SLOT, ["nice", "-n", "10", "env", "CARGO_BUILD_JOBS=4", ...compileArgs]);
      } else run("compile", compileArgs[0], compileArgs.slice(1));
      builder("build-signed-app", "dir");
    }
    const app = path.join(output, "mac-arm64", "Plainsong.app");
    const expectedUpdateYaml = await expectedMacUpdateYaml(root);
    verifyAppUpdateConfig(app, expectedUpdateYaml);
    run("app-preflight-signature", "/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    run("native-helpers", process.execPath, ["scripts/verify-packaged-native-helpers.mjs", "--app", app, "--arch", "arm64"]);
    const appCdhash = cdhash("app", app);
    if (!resume) fs.writeFileSync(candidatePath, JSON.stringify({ flowVersion: 2, appCdhash }, null, 2) + "\n");
    const candidate = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
    if (candidate.appCdhash !== appCdhash) throw new Error("Candidate signatures changed; refusing to reuse submission");
    const notarize = async (stage, file, cdhashes) => {
      const receipts = path.join(output, "notary", stage);
      fs.mkdirSync(receipts, { recursive: true });
      const identityPath = path.join(receipts, "candidate.json");
      if (!fs.existsSync(identityPath)) {
        fs.writeFileSync(identityPath, JSON.stringify({ uploadSha256: digest(file), cdhashes }, null, 2) + "\n");
      }
      const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
      if (JSON.stringify(identity.cdhashes) !== JSON.stringify(cdhashes)) throw new Error(`${stage} candidate signatures changed`);
      // Stapling changes DMG bytes after acceptance. Before a selected upload
      // exists, require the original bytes, including on interrupted resumes.
      if (!fs.existsSync(path.join(receipts, "submission.json")) && identity.uploadSha256 !== digest(file)) {
        throw new Error(`${stage} changed before upload`);
      }
      let acceptedLog;
      await notarizeArtifact({ file, binding: JSON.stringify(identity), receipts,
        run: (step, args) => {
          const result = run(`${stage}-${step}`, "/usr/bin/xcrun", ["notarytool", ...args, ...auth, "--output-format", "json"], { required: false });
          if (args[0] === "log" && result.status === 0) acceptedLog = JSON.parse(result.stdout);
          return result;
        },
        tries: Number(env.UPLOAD_TRIES ?? 12), spacingMs: Number(env.UPLOAD_SLEEP ?? 600) * 1000, waitTimeout: env.NOTARY_WAIT_TIMEOUT ?? "3h", sleep });
      if (acceptedLog?.sha256 !== identity.uploadSha256 ||
          !cdhashes.every(hash => acceptedLog.ticketContents?.some(entry => entry.cdhash === hash))) {
        throw new Error(`Apple's log does not cover this ${stage} SHA-256 and code identities`);
      }
    };
    const appArchive = path.join(output, "notary", "Plainsong-notarization.zip");
    if (!fs.existsSync(appArchive)) {
      const partial = `${appArchive}.partial`;
      fs.rmSync(partial, { force: true });
      run("archive-signed-app", "/usr/bin/ditto", ["-c", "-k", "--keepParent", app, partial]);
      fs.renameSync(partial, appArchive);
    }
    await notarize("app", appArchive, [candidate.appCdhash]);
    run("app-staple", "/usr/bin/xcrun", ["stapler", "staple", app]);
    verify("app", app);

    // Freeze the app ticket into the DMG, without re-signing the app.
    if (!fs.readdirSync(output).some(name => name.endsWith(".dmg"))) {
      builder("build-stapled-app-dmg", "dmg", ["--prepackaged", app]);
    }
    const dmgs = fs.readdirSync(output).filter(name => name.endsWith(".dmg"));
    if (dmgs.length !== 1) throw new Error("Expected exactly one DMG");
    const dmg = path.join(output, dmgs[0]);
    run("dmg-preflight-signature", "/usr/bin/codesign", ["--verify", "--deep", "--strict", dmg]);
    await notarize("dmg", dmg, [candidate.appCdhash, cdhash("dmg", dmg)]);
    run("dmg-staple", "/usr/bin/xcrun", ["stapler", "staple", dmg]);
    verify("dmg", dmg, true);
    const mounted = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-release-dmg-"));
    const mountpoint = path.join(mounted, "mount");
    fs.mkdirSync(mountpoint);
    try {
      run("dmg-mount", "/usr/bin/hdiutil", ["attach", dmg, "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mountpoint]);
      const dmgApp = path.join(mountpoint, "Plainsong.app");
      verifyAppUpdateConfig(dmgApp, expectedUpdateYaml);
      verify("dmg-app", dmgApp);
      if (cdhash("dmg-app", dmgApp) !== candidate.appCdhash) throw new Error("DMG contains a different app code identity");
    } finally {
      // Never recursively remove a mounted volume, even if detach fails.
      try { run("dmg-detach", "/usr/bin/hdiutil", ["detach", mountpoint]); }
      finally { fs.rmdirSync(mountpoint); fs.rmdirSync(mounted); }
    }
    // --prepackaged avoids signing or submitting again. Builder computes the
    // ZIP, blockmap and channel manifest together from the stapled app.
    builder("zip-stapled-app", "zip", ["--prepackaged", app]);
    const zips = fs.readdirSync(output).filter(name => name.endsWith("-mac.zip"));
    if (zips.length !== 1) throw new Error("Expected exactly one updater ZIP");
    const zip = path.join(output, zips[0]);
    const manifest = path.join(output, "beta-mac.yml");
    const manifestText = fs.readFileSync(manifest, "utf8");
    if (!manifestText.includes(path.basename(zip)) || !manifestText.includes(digest(zip, "sha512", "base64"))) throw new Error("Updater manifest does not match final ZIP");
    const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-release-zip-"));
    try {
      run("zip-extract", "/usr/bin/ditto", ["-x", "-k", zip, extracted]);
      const zipApp = path.join(extracted, "Plainsong.app");
      verifyAppUpdateConfig(zipApp, expectedUpdateYaml);
      verify("zip-app", zipApp);
      if (cdhash("zip-app", zipApp) !== candidate.appCdhash) {
        throw new Error("Updater ZIP contains a different app code identity");
      }
    } finally { fs.rmSync(extracted, { recursive: true, force: true }); }
    run("update-metadata", process.execPath, ["run", "qa:packaged:macos:update-metadata", "--", "--app", app, "--manifest", manifest,
      "--out", path.join(output, "notary", "update-metadata.json"), "--markdown", path.join(output, "notary", "update-metadata.md")]);
    run("full-trust-policy", process.execPath, ["run", "gate:release:macos:trust", "--", "--app", app, "--release-dir", output, "--expected-team", env.APPLE_TEAM_ID ?? appTeam,
      "--out", path.join(output, "notary", "macos-trust.json"), "--markdown", path.join(output, "notary", "macos-trust.md")]);
    const assets = [dmg, zip, `${zip}.blockmap`, manifest];
    const hashes = Object.fromEntries(assets.map(file => [path.basename(file), digest(file)]));
    fs.writeFileSync(path.join(output, "SHA256SUMS"), Object.entries(hashes).map(([name, hash]) => `${hash}  ${name}\n`).join(""));
    fs.writeFileSync(path.join(output, "notary", "complete.json"), JSON.stringify({ candidate, hashes, verifiedAt: new Date().toISOString() }, null, 2) + "\n");
  } finally { fs.rmdirSync(lock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("macOS arm64 release host required");
  const resume = process.argv[2] === "--resume";
  const output = resume ? process.argv[3] : process.env.PLAINSONG_RELEASE_DIR ?? path.join(root, "release");
  await releaseMac({ output, resume });
}
