import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

it("excludes the startup fixture and its key from production compilation", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../rust-sidecar/src/lib.rs"), "utf8");
  expect(source).toMatch(/#\[cfg\(all\(test, feature = "sqlcipher"\)\)\]\s*mod startup_migration_tests;/);
  expect(source).not.toContain("startup-migration-test-key-only");
});
