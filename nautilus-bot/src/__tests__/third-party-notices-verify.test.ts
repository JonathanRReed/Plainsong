import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareNoticesToCurrent,
  mergeCargoMetadata,
} from "../../scripts/generate-third-party-notices.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const sourcePath = "/repo/THIRD-PARTY-NOTICES.txt";
const packagedPath = "/release/Plainsong.app/Contents/Resources/THIRD-PARTY-NOTICES.txt";
const current = "PLAINSONG THIRD-PARTY SOFTWARE NOTICES\nmetal 0.29.0\n";

function compare(source: string | null, packaged: string | null) {
  return compareNoticesToCurrent({
    current,
    source,
    packaged,
    sourcePath,
    packagedPath,
  });
}

describe("license gate: notices verified against a regeneration", () => {
  it("passes only when both the committed and packaged copies match the regenerated notices", () => {
    expect(compare(current, current)).toEqual([]);
  });

  it("names a stale committed file and says how to regenerate it", () => {
    const failures = compare("stale source\n", current);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("source third-party notices are stale");
    expect(failures[0]).toContain(sourcePath);
    expect(failures[0]).toContain("bun run licenses:generate");
  });

  it("names a stale packaged copy even when the committed file is current", () => {
    const failures = compare(current, "stale packaged\n");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("packaged third-party notices are stale");
    expect(failures[0]).toContain(packagedPath);
    expect(failures[0]).toContain("rebuild the app");
  });

  it("reports both files when both are stale, and missing or empty packaged copies", () => {
    const both = compare("stale source\n", "stale packaged\n");
    expect(both).toHaveLength(2);
    expect(both[0]).toContain("source third-party notices are stale");
    expect(both[1]).toContain("packaged third-party notices are stale");
    expect(both[1]).toContain("bun run licenses:generate");

    expect(compare(null, current)).toEqual([
      expect.stringContaining("source third-party notices are missing"),
    ]);
    expect(compare(current, null)).toEqual([
      expect.stringContaining("packaged third-party notices are missing"),
    ]);
    expect(compare(current, "")).toEqual([
      expect.stringContaining("packaged third-party notices are empty"),
    ]);
  });

  it("regenerates the notices inside --verify-app instead of trusting the source file", () => {
    const script = fs.readFileSync(
      path.join(repoRoot, "scripts/generate-third-party-notices.ts"),
      "utf8",
    );
    const verify = script.slice(
      script.indexOf("function verifyPackagedApp("),
      script.indexOf("function cargoMetadata("),
    );
    expect(verify).toContain("buildNotices()");
    expect(verify).toContain("compareNoticesToCurrent({");
    expect(verify).not.toMatch(/name: "third-party notices"/);
    expect(script).toMatch(/if \(entrypointUrl === import\.meta\.url\) \{\s*main\(\);/);
  });
});

describe("mergeCargoMetadata", () => {
  it("covers the sidecar and the text helper once each, without either workspace crate", () => {
    const pkg = (id: string) => ({
      id,
      name: id,
      version: "1.0.0",
      source: null,
      manifest_path: `/${id}/Cargo.toml`,
    });
    const merged = mergeCargoMetadata([
      {
        packages: [pkg("plainsong"), pkg("serde")],
        workspace_members: ["plainsong"],
        resolve: { nodes: [{ id: "plainsong" }, { id: "serde" }] },
      },
      {
        packages: [pkg("plainsong-text-helper"), pkg("serde"), pkg("llama-cpp-sys-2")],
        workspace_members: ["plainsong-text-helper"],
        resolve: {
          nodes: [{ id: "plainsong-text-helper" }, { id: "serde" }, { id: "llama-cpp-sys-2" }],
        },
      },
    ]);
    expect(merged.packages.map((entry) => entry.id).sort()).toEqual([
      "llama-cpp-sys-2",
      "plainsong",
      "plainsong-text-helper",
      "serde",
    ]);
    expect(merged.workspace_members?.sort()).toEqual(["plainsong", "plainsong-text-helper"]);
    expect(merged.resolve?.nodes).toHaveLength(4);
  });

  it("is what the committed notices were generated from", () => {
    const notices = fs.readFileSync(path.join(repoRoot, "THIRD-PARTY-NOTICES.txt"), "utf8");
    expect(notices).toContain("llama-cpp-sys-2 0.1.160");
    expect(notices).toContain("File name(s): llama.cpp/LICENSE");
  });
});
