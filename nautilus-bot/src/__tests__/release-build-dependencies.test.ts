import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("packs and filters files with the patched build dependencies under Node", () => {
  const result = execFileSync("node", ["-e", `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const asar = require("@electron/asar");
    const { compareSync } = require("dir-compare");
    const { FileList } = require("filelist");
    const { FileMatcher } = require("app-builder-lib/out/fileMatcher");
    const rimraf = require("rimraf");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-build-deps-"));
    (async () => {
      try {
        const source = path.join(root, "source");
        fs.mkdirSync(path.join(source, "nested/vendor"), { recursive: true });
        fs.writeFileSync(path.join(source, "keep.txt"), "packed");
        fs.writeFileSync(path.join(source, "native.node"), "native");
        fs.writeFileSync(path.join(source, "nested/vendor/lib.txt"), "vendor");
        const archive = path.join(root, "app.asar");
        await asar.createPackageWithOptions(source, archive, {
          unpack: "**/*.node", unpackDir: "**/vendor",
        });
        assert.equal(asar.extractFile(archive, "keep.txt").toString(), "packed");
        assert.equal(fs.readFileSync(archive + ".unpacked/native.node", "utf8"), "native");
        assert.equal(fs.readFileSync(archive + ".unpacked/nested/vendor/lib.txt", "utf8"), "vendor");
        assert.ok(asar.listPackage(archive).includes("/nested/vendor/lib.txt"));

        const left = path.join(root, "left");
        const right = path.join(root, "right");
        for (const dir of [left, right]) {
          fs.mkdirSync(dir);
          fs.writeFileSync(path.join(dir, "keep.txt"), "same");
          fs.writeFileSync(path.join(dir, "skip.txt"), dir);
        }
        const comparison = compareSync(left, right, {
          compareContent: true, includeFilter: "*.txt", excludeFilter: "skip*",
        });
        assert.equal(comparison.same, true);
        assert.equal(comparison.equalFiles, 1);
        const files = new FileList();
        files.include(path.join(left, "*.txt"));
        files.exclude(path.join(left, "skip*"));
        assert.deepEqual(files.toArray(), [path.join(left, "keep.txt")]);
        const matcher = new FileMatcher(left, right, (value) => value, ["**/*.txt", "!skip*"]);
        const filter = matcher.createFilter();
        assert.equal(filter(path.join(left, "keep.txt"), fs.statSync(path.join(left, "keep.txt"))), true);
        assert.equal(filter(path.join(left, "skip.txt"), fs.statSync(path.join(left, "skip.txt"))), false);
        await new Promise((resolve, reject) => rimraf(path.join(left, "*.txt"), (error) => error ? reject(error) : resolve()));
        assert.deepEqual(fs.readdirSync(left), []);
        rimraf.sync(path.join(right, "*.txt"));
        assert.deepEqual(fs.readdirSync(right), []);
        console.log("packaging dependencies passed");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.trim()).toBe("packaging dependencies passed");
});
