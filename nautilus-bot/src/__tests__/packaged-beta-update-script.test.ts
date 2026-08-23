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
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve(
  process.cwd(),
  "scripts/capture-packaged-macos-beta-update.mjs",
);
const releaseAuditPath = path.resolve(
  process.cwd(),
  "scripts/capture-packaged-macos-release-audit.mjs",
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

function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "plainsong-beta-update-"));
  const beforeArtifact = path.join(root, "Plainsong-0.9.0-beta.1-arm64.dmg");
  const afterArtifact = path.join(root, "Plainsong-0.9.0-beta.2-arm64.dmg");
  writeFileSync(beforeArtifact, "signed beta one");
  writeFileSync(afterArtifact, "signed beta two");
  return {
    root,
    beforeArtifact,
    afterArtifact,
    beforeApp: writeFakeApp(root, "Before.app", "0.9.0-beta.1"),
    afterApp: writeFakeApp(root, "After.app", "0.9.0-beta.2"),
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
    beforeVersion: "0.9.0-beta.1",
    afterVersion: "0.9.0-beta.2",
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
      packageVersion: "0.9.0-beta.1",
      artifactSha256: sha256(fixture.beforeArtifact),
      ...trustOverrides.before,
    }),
  );
  writeFileSync(
    afterTrustPath,
    JSON.stringify({
      pass: true,
      packageVersion: "0.9.0-beta.2",
      artifactSha256: sha256(fixture.afterArtifact),
      ...trustOverrides.after,
    }),
  );
  const result = spawnSync(
    "node",
    [
      scriptPath,
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

describe("capture-packaged-macos-beta-update.mjs", () => {
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
});
