import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recordCargoExecutable, requireCargoExecutables } from "../../scripts/lib/cargo-output-path.ts";

const manifest = "/repo/rust-sidecar/Cargo.toml";
const names = ["plainsong-sidecar", "plainsong-cli"];
function artifact(name: string, executable: string | null, overrides = {}) {
  return JSON.stringify({
    reason: "compiler-artifact", manifest_path: manifest,
    target: { name, kind: ["bin"] }, executable, fresh: true, ...overrides,
  });
}

describe("Cargo build output receipts", () => {
  it.each([
    ["default", "/repo/rust-sidecar/target/release"],
    ["relative target directory", "/repo/custom-target/release"],
    ["absolute target directory", "/tmp/custom-target/release"],
    ["configured target triple", "/tmp/custom-target/aarch64-apple-darwin/release"],
    ["Windows target", "C:/target/x86_64-pc-windows-msvc/release"],
  ])("uses Cargo's exact paths for %s", (_label, directory) => {
    const outputs = new Map();
    const suffix = directory.startsWith("C:") ? ".exe" : "";
    for (const name of names) {
      recordCargoExecutable(artifact(name, `${directory}/${name}${suffix}`), outputs, manifest);
    }
    const binaries = requireCargoExecutables(outputs, names);
    for (const name of names) expect(binaries.get(name)).toBe(`${directory}/${name}${suffix}`);
  });

  it("fails when the current invocation omits an output instead of choosing a default file", () => {
    const outputs = new Map();
    recordCargoExecutable(artifact(names[0], "/tmp/current/plainsong-sidecar"), outputs, manifest);
    expect(() => requireCargoExecutables(outputs, names)).toThrow("plainsong-cli");
    expect(() => requireCargoExecutables(new Map(), names)).toThrow("plainsong-sidecar");
  });

  it("ignores non-executable, dependency, and non-bin artifacts", () => {
    const outputs = new Map();
    recordCargoExecutable(artifact(names[0], null), outputs, manifest);
    recordCargoExecutable(artifact(names[0], "/tmp/dependency", { manifest_path: "/other/Cargo.toml" }), outputs, manifest);
    recordCargoExecutable(artifact(names[0], "/tmp/library", { target: { name: names[0], kind: ["lib"] } }), outputs, manifest);
    expect(() => requireCargoExecutables(outputs, names)).toThrow("plainsong-sidecar");
  });

  it("preserves rendered compiler diagnostics", () => {
    expect(recordCargoExecutable(JSON.stringify({ reason: "compiler-message", message: { rendered: "warning: example\n" } }), new Map(), manifest)).toBe("warning: example\n");
  });

  it("strips and audits the reported output and checks it exists", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../scripts/build-rust-sidecar.ts"), "utf8");
    expect(source).toContain("--message-format=json-render-diagnostics");
    expect(source).toContain("fs.statSync(executable).isFile()");
    expect(source).toContain("for (const [binary, binaryPath] of binaries)");
    expect(source).toContain('binaries.get("plainsong-sidecar")');
    expect(source).not.toContain('"target", "release"');
  });
});
