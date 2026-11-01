import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectAppBundleIdentity } from "../../scripts/lib/release-candidate-identity";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve(
  process.cwd(),
  "scripts/capture-packaged-macos-beta-update.ts",
);
const releaseAuditPath = path.resolve(
  process.cwd(),
  "scripts/capture-packaged-macos-release-audit.ts",
);

function sha256(filePath: string) {
  return crypto.createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function writeFakeApp(root: string, name: string, version: string) {
  const appPath = path.join(root, name);
  const contentsPath = path.join(appPath, "Contents");
  mkdirSync(contentsPath, { recursive: true });
  writeFileSync(
    path.join(contentsPath, "Info.plist"),
    `<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
  );
  return appPath;
}

function createFixture(beforeVersion = "0.9.0-beta.1", afterVersion = "0.9.0-beta.2") {
  const root = mkdtempSync(path.join(os.tmpdir(), "plainsong-beta-update-"));
  mkdirSync(path.join(root, "before"));
  mkdirSync(path.join(root, "after"));
  const beforeArtifact = path.join(root, "before", `Plainsong-${beforeVersion}-arm64.dmg`);
  const afterArtifact = path.join(root, "after", `Plainsong-${afterVersion}-arm64.dmg`);
  writeFileSync(beforeArtifact, "signed beta one");
  writeFileSync(afterArtifact, "signed beta two");
  return {
    root,
    beforeVersion,
    afterVersion,
    beforeArtifact,
    afterArtifact,
    beforeApp: writeFakeApp(root, "Before.app", beforeVersion),
    afterApp: writeFakeApp(root, "After.app", afterVersion),
  };
}

function validJourney(fixture: ReturnType<typeof createFixture>) {
  return {
    schemaVersion: 1,
    scope: "local-signed-update-mechanism",
    feed: {
      provider: "generic",
      baseUrl: "http://127.0.0.1:18765/",
      production: false,
    },
    observedAt: "2026-08-08T18:00:00.000Z",
    beforeVersion: fixture.beforeVersion,
    afterVersion: fixture.afterVersion,
    beforeArtifactSha256: sha256(fixture.beforeArtifact),
    afterArtifactSha256: sha256(fixture.afterArtifact),
    installedThroughUpdater: true,
    relaunchObserved: true,
    events: [
      "checking-for-update",
      "update-available",
      "download-progress",
      "update-downloaded",
      "before-quit-for-update",
      "relaunch",
    ],
    preservation: {
      settings: true,
      onboarding: true,
      dictationHistory: true,
      meetings: true,
    },
    observations: {
      settingsSentinel: "same-settings-id",
      onboardingSentinel: "complete",
      dictationSentinel: "dictation-id-1",
      meetingSentinel: "meeting-id-1",
    },
  };
}

function runFixture(
  fixture: ReturnType<typeof createFixture>,
  journey: ReturnType<typeof validJourney>,
  trustOverrides: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  } = {},
  expectedAfterVersion = fixture.afterVersion,
) {
  const journeyPath = path.join(fixture.root, "journey.json");
  const beforeTrustPath = path.join(fixture.root, "before-trust.json");
  const afterTrustPath = path.join(fixture.root, "after-trust.json");
  const outPath = path.join(fixture.root, "receipt.json");
  writeFileSync(journeyPath, JSON.stringify(journey));
  writeFileSync(
    beforeTrustPath,
    JSON.stringify({
      pass: true,
      packageVersion: fixture.beforeVersion,
      artifactSha256: sha256(fixture.beforeArtifact),
      ...trustOverrides.before,
    }),
  );
  writeFileSync(
    afterTrustPath,
    JSON.stringify({
      pass: true,
      packageVersion: fixture.afterVersion,
      artifactSha256: sha256(fixture.afterArtifact),
      ...trustOverrides.after,
    }),
  );
  const result = spawnSync(
    "bun",
    [
      scriptPath,
      "--expected-before-version", fixture.beforeVersion,
      "--expected-after-version", expectedAfterVersion,
      "--before-app",
      fixture.beforeApp,
      "--after-app",
      fixture.afterApp,
      "--before-artifact",
      fixture.beforeArtifact,
      "--after-artifact",
      fixture.afterArtifact,
      "--journey",
      journeyPath,
      "--before-trust",
      beforeTrustPath,
      "--after-trust",
      afterTrustPath,
      "--out",
      outPath,
    ],
    { encoding: "utf8" },
  );
  return { result, receipt: JSON.parse(readFileSync(outPath, "utf8")) };
}

describe("capture-packaged-macos-beta-update.ts", () => {
  it("keeps local updater proof separate from the client-reachable production feed gate", () => {
    const auditSource = readFileSync(releaseAuditPath, "utf8");

    expect(auditSource).toContain('id: "signed-updater"');
    expect(auditSource).toContain('id: "public-update-feed"');
    expect(auditSource).toContain('evidenceFile("public-update-feed.json")');
  });

  it("accepts only the signed-update event order and preserved dual-pillar state", () => {
    const fixture = createFixture();
    try {
      const { result, receipt } = runFixture(fixture, validJourney(fixture));
      expect(result.status).toBe(0);
      expect(receipt.pass).toBe(true);
      expect(receipt.transition).toBe("0.9.0-beta.1 -> 0.9.0-beta.2");
      expect(receipt.scope).toBe("local-signed-update-mechanism");
      expect(receipt.productionFeedProven).toBe(false);
      expect(Object.values(receipt.checks).every(Boolean)).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("binds beta.5 to beta.6 proof to the delivered after app", () => {
    const fixture = createFixture("0.9.0-beta.5", "0.9.0-beta.6");
    try {
      const { result, receipt } = runFixture(fixture, validJourney(fixture));
      expect(result.status).toBe(0);
      const plist = receipt.candidateIdentity.appComponents.find(
        (entry: { name: string }) => entry.name === "Contents/Info.plist",
      );
      expect(plist.sha256).toBe(sha256(path.join(fixture.afterApp, "Contents/Info.plist")));
      expect(receipt.candidateIdentity.artifacts.map((entry: { name: string }) => entry.name)).toEqual([path.basename(fixture.afterArtifact)]);
      expect(plist.sha256).not.toBe(sha256(path.join(fixture.beforeApp, "Contents/Info.plist")));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an after app that differs from the expected delivered version", () => {
    const fixture = createFixture("0.9.0-beta.5", "0.9.0-beta.6");
    try {
      const { result, receipt } = runFixture(fixture, validJourney(fixture), {}, "0.9.0-beta.7");
      expect(result.status).toBe(1);
      expect(receipt.checks.afterVersionMatchesExpected).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["0.9.0-beta.6", "0.9.0-beta.5"],
    ["0.9.0-beta.6", "0.9.0-beta.6"],
    ["0.9.0-beta.6", "invalid"],
  ])("rejects a non-forward transition %s to %s", (before, after) => {
    const fixture = createFixture(before, after);
    try {
      const { result, receipt } = runFixture(fixture, validJourney(fixture));
      expect(result.status).toBe(1);
      expect(receipt.checks.versionTransitionIsForward).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails when updater events or meeting preservation evidence are missing", () => {
    const fixture = createFixture();
    try {
      const journey = validJourney(fixture);
      journey.events = ["checking-for-update", "update-available", "relaunch"];
      journey.preservation.meetings = false;
      const { result, receipt } = runFixture(fixture, journey);
      expect(result.status).toBe(1);
      expect(receipt.pass).toBe(false);
      expect(receipt.checks.updaterEventsCompleteAndOrdered).toBe(false);
      expect(receipt.checks.meetingsPreserved).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects path-matching trust receipts whose artifact hashes do not match", () => {
    const fixture = createFixture();
    try {
      const { result, receipt } = runFixture(fixture, validJourney(fixture), {
        before: {
          artifactSha256: "0".repeat(64),
          paths: { dmg: fixture.beforeArtifact },
        },
        after: {
          artifactSha256: "f".repeat(64),
          paths: { dmg: fixture.afterArtifact },
        },
      });

      expect(result.status).toBe(1);
      expect(receipt.pass).toBe(false);
      expect(receipt.checks.beforeTrustPasses).toBe(false);
      expect(receipt.checks.afterTrustPasses).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
  it("accepts the managed macOS install-on-quit handoff", () => {
    const fixture = createFixture();
    try {
      const journey = { ...validJourney(fixture), installHandoff: "managed-macos-install-on-quit" };
      journey.events = journey.events.map((event) => event === "before-quit-for-update" ? "app-before-quit" : event);
      const { result, receipt } = runFixture(fixture, journey);
      expect(result.status).toBe(0);
      expect(receipt.pass).toBe(true);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it.each(["http://0x7f000001/", "http://127.0.0.1.nip.io/", "http://user@localhost/"])("rejects bypass feed evidence %s", (baseUrl) => {
    const fixture = createFixture();
    try {
      const journey = validJourney(fixture);
      journey.feed.baseUrl = baseUrl;
      const { result, receipt } = runFixture(fixture, journey);
      expect(result.status).toBe(1);
      expect(receipt.checks.feedIsLocalGeneric).toBe(false);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("accepts current trust-gate receipts bound to full app and artifact bytes", () => {
    const fixture = createFixture();
    try {
      const trust = (app: string, artifact: string) => ({
        packageVersion: undefined, artifactSha256: undefined,
        candidateIdentity: { complete: true, appBundle: collectAppBundleIdentity(app), artifacts: [{ name: path.basename(artifact), sha256: sha256(artifact) }] },
      });
      const overrides = { before: trust(fixture.beforeApp, fixture.beforeArtifact), after: trust(fixture.afterApp, fixture.afterArtifact) };
      expect(runFixture(fixture, validJourney(fixture), overrides).result.status).toBe(0);
      writeFileSync(path.join(fixture.afterApp, "Contents/extra"), "changed candidate");
      const { result, receipt } = runFixture(fixture, validJourney(fixture), overrides);
      expect(result.status).toBe(1);
      expect(receipt.checks.afterTrustPasses).toBe(false);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

});
