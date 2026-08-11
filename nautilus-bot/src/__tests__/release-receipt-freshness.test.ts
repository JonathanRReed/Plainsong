import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { evaluateReleaseReceiptFreshness } from "../../scripts/lib/release-receipt-freshness.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("release receipt freshness", () => {
  const candidateBuiltAtMs = Date.parse("2026-08-08T12:00:00.000Z");

  it("accepts an unbound receipt without a candidate timestamp", () => {
    expect(
      evaluateReleaseReceiptFreshness({
        candidateBound: false,
        candidateBuiltAtMs: null,
        generatedAt: "not-a-date",
      }),
    ).toMatchObject({ current: true });
  });

  it("accepts a candidate receipt generated at the archive timestamp", () => {
    expect(
      evaluateReleaseReceiptFreshness({
        candidateBound: true,
        candidateBuiltAtMs,
        generatedAt: "2026-08-08T12:00:00.000Z",
      }),
    ).toMatchObject({ current: true });
  });

  it("allows the existing one-second filesystem timestamp tolerance", () => {
    expect(
      evaluateReleaseReceiptFreshness({
        candidateBound: true,
        candidateBuiltAtMs,
        generatedAt: "2026-08-08T11:59:59.000Z",
      }),
    ).toMatchObject({ current: true });
  });

  it("rejects stale and malformed candidate-bound receipts", () => {
    expect(
      evaluateReleaseReceiptFreshness({
        candidateBound: true,
        candidateBuiltAtMs,
        generatedAt: "2026-08-08T11:59:58.999Z",
      }),
    ).toMatchObject({ current: false, reason: "receipt-predates-candidate" });
    expect(
      evaluateReleaseReceiptFreshness({
        candidateBound: true,
        candidateBuiltAtMs,
        generatedAt: "not-a-date",
      }),
    ).toMatchObject({ current: false, reason: "invalid-generated-at" });
  });

  it("requires an exact release identity when one is supplied", () => {
    expect(
      evaluateReleaseReceiptFreshness({
        candidateBound: true,
        candidateBuiltAtMs,
        generatedAt: "2026-08-08T12:00:01.000Z",
        expectedIdentitySha256: "a".repeat(64),
        receiptIdentitySha256: "b".repeat(64),
      }),
    ).toMatchObject({ current: false, reason: "candidate-identity-mismatch" });
    expect(
      evaluateReleaseReceiptFreshness({
        candidateBound: true,
        candidateBuiltAtMs,
        generatedAt: "2026-08-08T12:00:01.000Z",
        expectedIdentitySha256: "a".repeat(64),
        receiptIdentitySha256: "a".repeat(64),
      }),
    ).toMatchObject({ current: true, reason: "exact-candidate-identity" });
  });

  it("marks a stale candidate-bound receipt contradicted in the release audit", () => {
    const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-release-audit-"));
    const appAsarPath = path.join(
      candidateDir,
      "mac-arm64",
      "Plainsong.app",
      "Contents",
      "Resources",
      "app.asar",
    );
    const qaDir = path.join(candidateDir, "qa");
    const sidecarPath = path.join(
      candidateDir,
      "mac-arm64",
      "Plainsong.app",
      "Contents",
      "Resources",
      "sidecar",
      "plainsong-sidecar",
    );
    const outPath = path.join(qaDir, "audit.json");
    fs.mkdirSync(path.dirname(appAsarPath), { recursive: true });
    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
    fs.mkdirSync(qaDir, { recursive: true });
    fs.writeFileSync(appAsarPath, "candidate", "utf8");
    fs.writeFileSync(sidecarPath, "candidate-sidecar", "utf8");
    const candidateBuiltAt = new Date("2026-08-08T12:00:00.000Z");
    fs.utimesSync(appAsarPath, candidateBuiltAt, candidateBuiltAt);
    fs.writeFileSync(
      path.join(qaDir, "update-metadata.json"),
      JSON.stringify({ pass: true, generatedAt: "2026-08-08T11:59:58.000Z" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(qaDir, "updater-n-to-n-plus-1.json"),
      JSON.stringify({ pass: true, generatedAt: "2026-08-08T11:59:58.000Z" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(qaDir, "support-bundle.json"),
      JSON.stringify({
        safeToShare: true,
        excludedByDesign: Array.from({ length: 8 }, (_, index) => `excluded-${index}`),
        generatedAt: "2026-08-08T11:59:58.000Z",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(qaDir, "macos-trust.json"),
      JSON.stringify({
        pass: true,
        generatedAt: "2026-08-08T11:59:58.000Z",
        checks: { appSigned: true },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(qaDir, "source-gates.json"),
      JSON.stringify({
        pass: true,
        generatedAt: "2026-08-08T11:59:58.000Z",
        sourceIdentity: {
          sourceSnapshotSha256: "source-snapshot",
          trackedDiffSha256: "tracked-diff",
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(qaDir, "code-review.json"),
      JSON.stringify({
        pass: true,
        reviewMethod: "ordinary-code-review",
        remainingLaunchFindings: [],
        sourceIdentity: {
          sourceSnapshotSha256: "source-snapshot",
          trackedDiffSha256: "tracked-diff",
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(qaDir, "capture-soak-3h.json"),
      JSON.stringify({
        pass: true,
        generatedAt: "2026-08-08T12:00:00.000Z",
        recordMs: 10_800_000,
        minRecordMs: 10_800_000,
        sidecarSha256: "0".repeat(64),
        transcriptWait: { timedOut: false },
        transcriptDetails: {
          requestedProvider: "parakeet",
          actualProvider: "parakeet",
        },
        checks: { recordingCompleted: true, transcriptCreated: true },
      }),
      "utf8",
    );

    const result = spawnSync(
      "node",
      [
        path.join(repoRoot, "scripts", "capture-packaged-macos-release-audit.mjs"),
        "--candidate",
        candidateDir,
        "--out",
        outPath,
        "--markdown",
        path.join(qaDir, "audit.md"),
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const audit = JSON.parse(fs.readFileSync(outPath, "utf8"));
    fs.rmSync(candidateDir, { recursive: true, force: true });

    expect(result.status, result.stderr).toBe(1);
    expect(
      audit.requirements.find((requirement: { id: string }) => requirement.id === "update-metadata"),
    ).toMatchObject({
      status: "contradicted",
      detail:
        "The receipt is not bound to the exact app, DMG, ZIP, blockmap, and beta manifest identity.",
    });
    expect(
      audit.requirements.find((requirement: { id: string }) => requirement.id === "meeting-soak"),
    ).toMatchObject({
      status: "contradicted",
    });
    expect(
      audit.requirements.find((requirement: { id: string }) => requirement.id === "signed-updater"),
    ).toMatchObject({ status: "contradicted" });
    expect(
      audit.requirements.find((requirement: { id: string }) => requirement.id === "support-bundle"),
    ).toMatchObject({ status: "contradicted" });
    expect(
      audit.requirements.find(
        (requirement: { id: string }) => requirement.id === "developer-id-signing",
      ),
    ).toMatchObject({ status: "contradicted" });
    expect(
      audit.requirements.find(
        (requirement: { id: string }) => requirement.id === "apple-distribution",
      ),
    ).toMatchObject({
      status: "incomplete",
      detail: "The macOS trust receipt predates the current candidate components and must be regenerated.",
    });
    expect(
      audit.requirements.find(
        (requirement: { id: string }) => requirement.id === "release-code-review",
      ),
    ).toMatchObject({ status: "proved" });
    expect(
      audit.requirements.find(
        (requirement: { id: string }) => requirement.id === "source-gates",
      ),
    ).toMatchObject({ status: "contradicted" });
  });

  it("uses every shipped native component when evaluating receipt freshness", () => {
    const componentPaths = [
      ["Resources", "app.asar"],
      ["Resources", "sidecar", "plainsong-sidecar"],
      ["MacOS", "Plainsong"],
      ["Resources", "shortcut-helper", "plainsong-native-shortcut-helper"],
      ["Resources", "sidecar", "nautilus-macos-speech-helper-aarch64-apple-darwin"],
    ];

    for (const newestComponent of componentPaths) {
      const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-component-age-"));
      const appRoot = path.join(candidateDir, "mac-arm64", "Plainsong.app", "Contents");
      const qaDir = path.join(candidateDir, "qa");
      const outPath = path.join(qaDir, "audit.json");
      const baseline = new Date("2026-08-08T12:00:00.000Z");
      const newest = new Date("2026-08-08T12:10:00.000Z");
      fs.mkdirSync(qaDir, { recursive: true });
      for (const componentParts of componentPaths) {
        const componentPath = path.join(appRoot, ...componentParts);
        fs.mkdirSync(path.dirname(componentPath), { recursive: true });
        fs.writeFileSync(componentPath, componentParts.join("/"), "utf8");
        fs.utimesSync(
          componentPath,
          componentParts === newestComponent ? newest : baseline,
          componentParts === newestComponent ? newest : baseline,
        );
      }
      fs.writeFileSync(
        path.join(qaDir, "update-metadata.json"),
        JSON.stringify({ pass: true, generatedAt: "2026-08-08T12:05:00.000Z" }),
        "utf8",
      );

      const result = spawnSync(
        "node",
        [
          path.join(repoRoot, "scripts", "capture-packaged-macos-release-audit.mjs"),
          "--candidate",
          candidateDir,
          "--out",
          outPath,
          "--markdown",
          path.join(qaDir, "audit.md"),
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
      const audit = JSON.parse(fs.readFileSync(outPath, "utf8"));
      fs.rmSync(candidateDir, { recursive: true, force: true });

      expect(result.status, result.stderr).toBe(1);
      expect(
        audit.requirements.find(
          (requirement: { id: string }) => requirement.id === "update-metadata",
        ),
        newestComponent.join("/"),
      ).toMatchObject({ status: "contradicted" });
    }
  });
});
