import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  downloadHeadersForUrl,
  inspectBundleArchive,
  unsafeArchiveMemberReason,
} from "../../scripts/provision-asr-assets.mjs";

const appRoot = path.resolve(import.meta.dirname, "../..");
const provisionScript = fs.readFileSync(
  path.join(appRoot, "scripts/provision-asr-assets.mjs"),
  "utf8",
);

describe("ASR asset provisioning integrity", () => {
  it("uses immutable model revisions and application-pinned digests", () => {
    expect(provisionScript).not.toMatch(/resolve\/(?:main|master)\//);
    expect(provisionScript).toContain("createHash");
    expect(provisionScript).toContain("integrity verification failed");
    expect(provisionScript).toContain("plainsong-model-integrity-v1");
    expect(provisionScript).toContain(".plainsong-integrity");
  });

  it("provisions Moonshine tokenizer data from the model-specific repository", () => {
    expect(provisionScript).toContain('const MOONSHINE_BASE_REPO = "UsefulSensors/moonshine-base"');
    expect(provisionScript).toContain('remotePath: "tokenizer.json"');
    expect(provisionScript).not.toContain("onnx/merged/base/float/tokenizer.json");
  });

  it("never attaches the Hugging Face token to an operator-supplied bundle URL", () => {
    expect(provisionScript).toContain(
      "downloadFile(url, destination, null, { includeHfToken: false })",
    );
    expect(
      downloadHeadersForUrl("https://example.invalid/models.tar", {
        includeHfToken: false,
        token: "private-token",
      }),
    ).not.toHaveProperty("authorization");
    expect(
      downloadHeadersForUrl("https://huggingface.co/private/model", {
        includeHfToken: true,
        token: "private-token",
      }),
    ).toHaveProperty("authorization", "Bearer private-token");
    expect(
      downloadHeadersForUrl("https://huggingface.co.attacker.invalid/model", {
        includeHfToken: true,
        token: "private-token",
      }),
    ).not.toHaveProperty("authorization");
  });

  it("rejects absolute and parent-traversing bundle members", () => {
    expect(unsafeArchiveMemberReason("../../outside")).toBe("parent traversal");
    expect(unsafeArchiveMemberReason("/tmp/outside")).toBe(
      "absolute or invalid path",
    );
    expect(unsafeArchiveMemberReason("C:\\outside")).toBe(
      "absolute or invalid path",
    );
    expect(unsafeArchiveMemberReason("whisper/model.bin")).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "accepts regular bundles and rejects links before extraction",
    () => {
      const tempRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "plainsong-asr-bundle-test-"),
      );
      const safeSource = path.join(tempRoot, "safe-source");
      const safeArchive = path.join(tempRoot, "safe-bundle.tar");
      fs.mkdirSync(path.join(safeSource, "whisper"), { recursive: true });
      fs.writeFileSync(
        path.join(safeSource, "whisper", "model.bin"),
        "model",
      );
      const safeResult = spawnSync(
        "tar",
        ["-cf", safeArchive, "-C", safeSource, "whisper"],
        { encoding: "utf8" },
      );

      try {
        expect(safeResult.status).toBe(0);
        expect(inspectBundleArchive(safeArchive)).toEqual({ ok: true });

        const unsafeSource = path.join(tempRoot, "unsafe-source");
        const unsafeArchive = path.join(tempRoot, "unsafe-bundle.tar");
        fs.mkdirSync(unsafeSource);
        fs.symlinkSync("/tmp", path.join(unsafeSource, "unsafe-link"));
        const unsafeResult = spawnSync(
          "tar",
          ["-cf", unsafeArchive, "-C", unsafeSource, "unsafe-link"],
          { encoding: "utf8" },
        );
        expect(unsafeResult.status).toBe(0);
        expect(inspectBundleArchive(unsafeArchive)).toMatchObject({
          ok: false,
        });
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );
});
