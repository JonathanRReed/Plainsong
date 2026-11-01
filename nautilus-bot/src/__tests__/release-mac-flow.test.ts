import { afterEach, beforeAll, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error Release tooling is plain JavaScript, also run directly by Bun.
import { releaseMac } from "../../scripts/release-mac.mjs";
// @ts-expect-error Release tooling is plain JavaScript.
import { expectedMacUpdateYaml } from "../../scripts/lib/app-update-config.mjs";

let updateYaml: string;
beforeAll(async () => { updateYaml = await expectedMacUpdateYaml(process.cwd()); });
function writeUpdate(app: string, value = updateYaml) {
  const resources = path.join(app, "Contents", "Resources");
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, "app-update.yml"), value);
}

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const sha = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const appId = "12345678-1234-1234-1234-123456789abc";
const dmgId = "abcdefab-1234-1234-1234-123456789abc";
function fixture() {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "release-flow-")); roots.push(output);
  const calls: { command: string; args: string[] }[] = [];
  const app = path.join(output, "mac-arm64", "Plainsong.app");
  const state = { failStaple: false, failDmgWait: false, badDmgTicket: false, failTrust: false, missingDmgAppTicket: false, failDetach: false, cutApp: false, cutDmg: false, appUpdate: "valid", dmgUpdate: "valid", zipUpdate: "valid", failMetadata: false };
  let dmgHasTicket = false;
  const execute = (command: string, args: string[]) => {
    calls.push({ command, args });
    if (args.includes("electron-builder")) {
      if (args.includes("dir")) {
        fs.mkdirSync(app, { recursive: true });
        if (state.appUpdate !== "missing") writeUpdate(app, state.appUpdate === "valid" ? updateYaml : "provider: wrong\n");
      }
      if (args.includes("dmg")) {
        expect(args).toContain("--prepackaged");
        expect(fs.readFileSync(path.join(app, "ticket"), "utf8")).toBe("stapled");
        dmgHasTicket = true;
        fs.writeFileSync(path.join(output, "Plainsong-test-arm64.dmg"), "signed dmg");
      }
      if (args.includes("zip")) {
        expect(fs.readFileSync(path.join(app, "ticket"), "utf8")).toBe("stapled");
        const name = "Plainsong-test-arm64-mac.zip";
        fs.writeFileSync(path.join(output, name), "stapled ZIP bytes");
        fs.writeFileSync(path.join(output, `${name}.blockmap`), "blockmap");
        fs.writeFileSync(path.join(output, "beta-mac.yml"), `files:\n - url: ${name}\n   sha512: ${crypto.createHash("sha512").update("stapled ZIP bytes").digest("base64")}\n`);
      }
    }
    if (args[0] === "-c" && command.endsWith("ditto")) fs.writeFileSync(args.at(-1)!, "signed app archive");
    if (args[0] === "-x") {
      fs.mkdirSync(path.join(args.at(-1)!, "Plainsong.app"));
      fs.writeFileSync(path.join(args.at(-1)!, "Plainsong.app", "ticket"), "stapled");
      if (state.zipUpdate !== "missing") writeUpdate(path.join(args.at(-1)!, "Plainsong.app"), state.zipUpdate === "valid" ? updateYaml : "provider: wrong\n");
    }
    if (args[0] === "attach") {
      const mountpoint = args.at(-1)!;
      fs.mkdirSync(path.join(mountpoint, "Plainsong.app"));
      if (state.dmgUpdate !== "missing") writeUpdate(path.join(mountpoint, "Plainsong.app"), state.dmgUpdate === "valid" ? updateYaml : "provider: wrong\n");
      if (dmgHasTicket && !state.missingDmgAppTicket) fs.writeFileSync(path.join(mountpoint, "Plainsong.app", "ticket"), "stapled");
    }
    if (args[0] === "detach") {
      if (state.failDetach) return { status: 1, stdout: "", stderr: "busy" };
      fs.rmSync(path.join(args[1], "Plainsong.app"), { recursive: true });
    }
    if (args[0] === "-dvvv") return { status: 0, stdout: "", stderr: `CDHash=${args.at(-1)?.endsWith(".dmg") ? "dddd1234" : "abcdef1234"}\nAuthority=Developer ID Application: Test\nTeamIdentifier=TEST\nflags=0x10000(runtime)\n` };
    if (args[0] === "stapler" && args[1] === "staple" && args[2] === app) {
      if (state.failStaple) return { status: 65, stdout: "", stderr: "Record not found" };
      fs.writeFileSync(path.join(app, "ticket"), "stapled");
    }
    if (args[0] === "stapler" && args[1] === "validate" && args[2].endsWith(".app") && !fs.existsSync(path.join(args[2], "ticket"))) return { status: 65, stdout: "", stderr: "No ticket" };
    if (args[0] === "notarytool") {
      if (args[1] === "submit" && (args[2].endsWith(".dmg") ? state.cutDmg : state.cutApp)) {
        if (args[2].endsWith(".dmg")) state.cutDmg = false; else state.cutApp = false;
        return { status: 138, stdout: JSON.stringify({ id: "badbadba-1234-1234-1234-123456789abc" }), stderr: "SIGBUS" };
      }
      if (args[2] === "badbadba-1234-1234-1234-123456789abc") return { status: 0, stdout: JSON.stringify({ status: "In Progress" }), stderr: "" };
      if (args[1] === "wait" && args[2] === dmgId && state.failDmgWait) return { status: 1, stdout: "", stderr: "timeout" };
      const payload = args[1] === "history" ? { history: [] } : args[1] === "submit" ? { id: args[2].endsWith(".dmg") ? dmgId : appId } : args[1] === "log" ? {
        sha256: sha(args[2] === dmgId ? "signed dmg" : "signed app archive"),
        ticketContents: args[2] === dmgId && state.badDmgTicket ? [] : [{ cdhash: "abcdef1234" }, { cdhash: "dddd1234" }],
      } : { status: args[2] === dmgId && state.failDmgWait ? "In Progress" : "Accepted" };
      return { status: 0, stdout: JSON.stringify(payload), stderr: "" };
    }
    if (args.includes("gate:release:macos:trust") && state.failTrust) return { status: 1, stdout: "FAIL", stderr: "" };
    if (args.includes("qa:packaged:macos:update-metadata")) {
      expect(fs.existsSync(path.join(output, "beta-mac.yml"))).toBe(true);
      expect(args).toContain(app);
      expect(args).toContain(path.join(output, "beta-mac.yml"));
      if (state.failMetadata) return { status: 1, stdout: "FAIL", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { output, app, calls, state, options: { output, execute, env: { APPLE_KEYCHAIN_PROFILE: "fake-profile", PLAINSONG_BUILD_SLOT: "/tmp/fake-build-slot.sh" } } };
}
it("notarizes and staples the app before building the DMG, then notarizes the DMG and verifies all shipped copies", async () => {
  const f = fixture(); await releaseMac(f.options);
  const submissions = f.calls.filter(call => call.args[1] === "submit");
  expect(submissions.map(call => call.args[2])).toEqual([path.join(f.output, "notary", "Plainsong-notarization.zip"), path.join(f.output, "Plainsong-test-arm64.dmg")]);
  expect(f.calls.find(call => call.args[0] === "-c")?.args.slice(0, 3)).toEqual(["-c", "-k", "--keepParent"]);
  expect(f.calls.filter(call => call.command.endsWith("spctl"))).toHaveLength(4);
  expect(f.calls.find(call => call.args[0] === "attach")?.args).toContain("-readonly");
  for (const prefix of ["app", "dmg"]) expect(fs.existsSync(path.join(f.output, "notary", prefix, "submission.json"))).toBe(true);
  const extracted = f.calls.find(call => call.args[0] === "-x")?.args.at(-1);
  expect(extracted?.startsWith(os.tmpdir())).toBe(true);
  expect(fs.existsSync(extracted!)).toBe(false);
  expect(f.calls.filter(call => call.command === "/tmp/fake-build-slot.sh").map(call => call.args)).toEqual([["nice", "-n", "10", "env", "CARGO_BUILD_JOBS=4", process.execPath, "run", "release:mac:compile"]]);
  expect(f.calls.at(-1)?.args).toContain("gate:release:macos:trust");
  expect(f.calls.some(call => call.args.includes("qa:packaged:macos:update-metadata"))).toBe(true);
  expect(fs.readFileSync(path.join(f.output, "SHA256SUMS"), "utf8")).toContain(sha("stapled ZIP bytes"));
  expect(fs.existsSync(path.join(f.output, "notary", "complete.json"))).toBe(true);
});

it.each(["missing", "wrong"])("rejects %s app updater configuration before any Apple upload", async value => {
  const f = fixture(); f.state.appUpdate = value;
  await expect(releaseMac(f.options)).rejects.toThrow("app-update.yml");
  expect(f.calls.some(call => call.args[0] === "notarytool")).toBe(false);
  expect(fs.existsSync(path.join(f.output, "notary", "complete.json"))).toBe(false);
});

it.each(["missing", "wrong"])("rejects %s updater configuration on resume without repairing signed bytes", async value => {
  const f = fixture(); f.state.failStaple = true;
  await expect(releaseMac(f.options)).rejects.toThrow("app-staple");
  const file = path.join(f.app, "Contents", "Resources", "app-update.yml");
  if (value === "missing") fs.rmSync(file); else fs.writeFileSync(file, "wrong");
  f.calls.length = 0;
  await expect(releaseMac({ ...f.options, resume: true })).rejects.toThrow("app-update.yml");
  expect(f.calls).toEqual([]);
  expect(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null).toBe(value === "missing" ? null : "wrong");
});

it.each(["missing", "wrong"])("rejects %s updater configuration in the mounted DMG and detaches", async value => {
  const f = fixture(); f.state.dmgUpdate = value;
  await expect(releaseMac(f.options)).rejects.toThrow("app-update.yml");
  expect(f.calls.some(call => call.args[0] === "detach")).toBe(true);
  expect(f.calls.some(call => call.args.includes("zip"))).toBe(false);
});

it.each(["missing", "wrong"])("rejects %s updater configuration in the ZIP and removes the extraction", async value => {
  const f = fixture(); f.state.zipUpdate = value;
  await expect(releaseMac(f.options)).rejects.toThrow("app-update.yml");
  const extracted = f.calls.find(call => call.args[0] === "-x")!.args.at(-1)!;
  expect(fs.existsSync(extracted)).toBe(false);
  expect(fs.existsSync(path.join(f.output, "SHA256SUMS"))).toBe(false);
});

it("cannot finish when the packaged update metadata gate fails", async () => {
  const f = fixture(); f.state.failMetadata = true;
  await expect(releaseMac(f.options)).rejects.toThrow("update-metadata");
  expect(f.calls.some(call => call.args.includes("gate:release:macos:trust"))).toBe(false);
  expect(fs.existsSync(path.join(f.output, "SHA256SUMS"))).toBe(false);
  expect(fs.existsSync(path.join(f.output, "notary", "complete.json"))).toBe(false);
});
it("stops before building a DMG when app stapling fails and resumes the app journal without reuploading", async () => {
  const f = fixture(); f.state.failStaple = true;
  await expect(releaseMac(f.options)).rejects.toThrow("app-staple");
  expect(f.calls.some(call => call.args.includes("dmg"))).toBe(false);
  f.state.failStaple = false;
  await releaseMac({ ...f.options, resume: true });
  expect(f.calls.filter(call => call.args[1] === "submit")).toHaveLength(2);
  expect(f.calls.filter(call => call.command === "/tmp/fake-build-slot.sh")).toHaveLength(1);
});
it("resumes a DMG wait from its own journal, without rebuilding or reuploading either artifact", async () => {
  const f = fixture(); f.state.failDmgWait = true;
  await expect(releaseMac(f.options)).rejects.toThrow("In Progress");
  f.state.failDmgWait = false;
  await releaseMac({ ...f.options, resume: true });
  expect(f.calls.filter(call => call.args[1] === "submit")).toHaveLength(2);
  expect(f.calls.filter(call => call.args.includes("electron-builder") && call.args.includes("dmg"))).toHaveLength(1);
});
it("rejects a DMG log missing its own or the nested app code identity", async () => {
  const f = fixture(); f.state.badDmgTicket = true;
  await expect(releaseMac(f.options)).rejects.toThrow("does not cover this dmg");
  expect(f.calls.some(call => call.args.includes("zip"))).toBe(false);
  expect(fs.existsSync(path.join(f.output, "SHA256SUMS"))).toBe(false);
});
it("rejects a mounted app missing its staple and always detaches", async () => {
  const f = fixture(); f.state.missingDmgAppTicket = true;
  await expect(releaseMac(f.options)).rejects.toThrow("dmg-app-stapler-validate");
  expect(f.calls.some(call => call.args[0] === "detach")).toBe(true);
  expect(f.calls.some(call => call.args.includes("zip"))).toBe(false);
});
it("does not recursively remove a volume after detach fails", async () => {
  const f = fixture(); f.state.failDetach = true;
  await expect(releaseMac(f.options)).rejects.toThrow();
  const mountpoint = f.calls.find(call => call.args[0] === "attach")!.args.at(-1)!;
  expect(fs.existsSync(path.join(mountpoint, "Plainsong.app", "ticket"))).toBe(true);
  fs.rmSync(path.dirname(mountpoint), { recursive: true }); // fake mount only
});
it("cannot finish when the unmodified full trust policy fails", async () => {
  const f = fixture(); f.state.failTrust = true;
  await expect(releaseMac(f.options)).rejects.toThrow("full-trust-policy");
  expect(fs.existsSync(path.join(f.output, "SHA256SUMS"))).toBe(false);
  expect(fs.existsSync(path.join(f.output, "notary", "complete.json"))).toBe(false);
});
it("refuses legacy single-submission candidates", async () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.output, "notary"));
  fs.writeFileSync(path.join(f.output, "notary", "candidate.json"), JSON.stringify({ appCdhash: "abcdef1234" }));
  fs.writeFileSync(path.join(f.output, "notary", "complete.json"), "old completion");
  fs.writeFileSync(path.join(f.output, "SHA256SUMS"), "old checksums");
  await expect(releaseMac({ ...f.options, resume: true })).rejects.toThrow("old single-submission flow");
  expect(fs.readFileSync(path.join(f.output, "notary", "complete.json"), "utf8")).toBe("old completion");
  expect(fs.readFileSync(path.join(f.output, "SHA256SUMS"), "utf8")).toBe("old checksums");
  expect(f.calls).toEqual([]);
  expect(f.calls.some(call => call.args[0] === "notarytool")).toBe(false);
});
it("keeps credential values out of command receipts", async () => {
  const f = fixture();
  const execute = (command: string, args: string[]) => {
    const result = f.options.execute(command, args);
    return args.includes("scripts/verify-packaged-native-helpers.mjs") ? { ...result, stdout: "fake-password fake-certificate" } : result;
  };
  await releaseMac({ ...f.options, execute, env: { APPLE_ID: "test@example.invalid", APPLE_APP_SPECIFIC_PASSWORD: "fake-password", APPLE_TEAM_ID: "TEST", CSC_LINK: "fake-certificate" } });
  for (const name of fs.readdirSync(path.join(f.output, "notary"))) {
    if (!fs.statSync(path.join(f.output, "notary", name)).isFile()) continue;
    const receipt = fs.readFileSync(path.join(f.output, "notary", name), "utf8");
    expect(receipt).not.toContain("fake-password"); expect(receipt).not.toContain("fake-certificate");
  }
});

it.each(["app", "dmg"])("retries a cut-off %s upload without waiting on its incomplete submission", async stage => {
  const f = fixture();
  f.state.cutApp = stage === "app"; f.state.cutDmg = stage === "dmg";
  await releaseMac({ ...f.options, sleep: async () => {} });
  expect(f.calls.filter(call => call.args[1] === "submit")).toHaveLength(3);
  expect(f.calls.filter(call => call.args[1] === "wait").some(call => call.args[2] === "badbadba-1234-1234-1234-123456789abc")).toBe(false);
  const receipts = path.join(f.output, "notary", stage);
  expect(fs.readdirSync(receipts).filter(name => /^attempt-\d+-\d+\.json$/.test(name))).toHaveLength(2);
});

it.each([appId, dmgId])("refuses an accepted log for different upload bytes at submission %s", async id => {
  const f = fixture();
  const execute = (command: string, args: string[]) => {
    const result = f.options.execute(command, args);
    return args[0] === "notarytool" && args[1] === "log" && args[2] === id
      ? { ...result, stdout: JSON.stringify({ sha256: "different bytes", ticketContents: [{ cdhash: "abcdef1234" }, { cdhash: "dddd1234" }] }) }
      : result;
  };
  await expect(releaseMac({ ...f.options, execute })).rejects.toThrow("does not cover");
  expect(fs.existsSync(path.join(f.output, "SHA256SUMS"))).toBe(false);
});

it("refuses a changed app signature before reusing either journal", async () => {
  const f = fixture(); f.state.failStaple = true;
  await expect(releaseMac(f.options)).rejects.toThrow("app-staple");
  const execute = (command: string, args: string[]) => {
    const result = f.options.execute(command, args);
    return args[0] === "-dvvv" ? { ...result, stderr: result.stderr.replace("abcdef1234", "fedcba9876") } : result;
  };
  await expect(releaseMac({ ...f.options, execute, resume: true })).rejects.toThrow("Candidate signatures changed");
  expect(f.calls.filter(call => call.args[1] === "submit")).toHaveLength(1);
});
