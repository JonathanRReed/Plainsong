import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The gate reads three real files out of `process.cwd()`. These fixtures are
 * the smallest shapes its extractors recognize, so a failure mode can be
 * provoked without editing the repository's own sources.
 */
function bridgeFixture(commands: string[]): string {
  return `const ALLOWED_RENDERER_COMMANDS = new Set<string>([
${commands.map((command) => `  "${command}",`).join("\n")}
]);
`;
}

function mainFixture(localCommands: string[]): string {
  return `async function handleLocalCommand(
  event: IpcMainInvokeEvent,
  command: string,
  args: unknown
): Promise<{ handled: boolean; result?: unknown }> {
  switch (command) {
${localCommands
  .map(
    (command) => `    case "${command}": {
      switch (nested) {
        case "not_a_local_command":
          break;
      }
      return { handled: true, result: null };
    }`,
  )
  .join("\n")}
    default:
      return { handled: false };
  }
}
`;
}

function sidecarFixture(commands: string[]): string {
  return `pub async fn dispatch_command(method: &str) -> Result<Value, String> {
    match method {
${commands.map((command) => `        "${command}" => Ok(Value::Null),`).join("\n")}
        _ => Err(format!("Unknown command: {}", method)),
    }
}
`;
}

function runGate(fixture: {
  allowed: string[];
  local: string[];
  dispatched: string[];
}) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "plainsong-ipc-gate-"));
  try {
    mkdirSync(path.join(tempRoot, "scripts"), { recursive: true });
    mkdirSync(path.join(tempRoot, "electron"), { recursive: true });
    mkdirSync(path.join(tempRoot, "rust-sidecar", "src"), { recursive: true });
    copyFileSync(
      path.resolve(process.cwd(), "scripts/verify-ipc-contract.mjs"),
      path.join(tempRoot, "scripts/verify-ipc-contract.mjs"),
    );
    writeFileSync(
      path.join(tempRoot, "electron/ipc-bridge.ts"),
      bridgeFixture(fixture.allowed),
      "utf8",
    );
    writeFileSync(
      path.join(tempRoot, "electron/main.ts"),
      mainFixture(fixture.local),
      "utf8",
    );
    writeFileSync(
      path.join(tempRoot, "rust-sidecar/src/lib.rs"),
      sidecarFixture(fixture.dispatched),
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [path.join(tempRoot, "scripts/verify-ipc-contract.mjs")],
      { cwd: tempRoot, encoding: "utf8" },
    );
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe("verify-ipc-contract.mjs", () => {
  it("derives the local command set from main.ts rather than a literal", () => {
    // The finding: the hand-maintained `electronLocalCommands` literal hid both
    // a dead allowlist entry and a dead handler at once, because it was only
    // ever compared against other hand-written lists.
    const source = readFileSync(
      path.resolve(process.cwd(), "scripts/verify-ipc-contract.mjs"),
      "utf8",
    );
    expect(source).toContain("function extractElectronLocalCommands(source)");
    expect(source).toContain("extractElectronLocalCommands(main)");
    // No hardcoded command names remain in the derived set.
    expect(source).not.toContain('"__window_set_size__"');
    expect(source).not.toContain('"select_export_location"');
    expect(source).not.toContain('"__emit__"');
  });

  it("passes when every command is reachable in both directions", () => {
    const result = runGate({
      allowed: ["__window_show__", "get_settings"],
      local: ["__window_show__"],
      dispatched: ["get_settings"],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("IPC contract validation passed");
    expect(result.stdout).toContain("1 Electron local commands derived from main.ts");
  });

  it("fails on a local case the renderer allowlist does not admit", () => {
    // Exactly the `app:set_minimize_to_tray` shape: the bridge rejects the
    // command before handleLocalCommand ever sees it, so the case is dead.
    const result = runGate({
      allowed: ["get_settings"],
      local: ["app:set_minimize_to_tray"],
      dispatched: ["get_settings"],
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Electron local commands no renderer can reach");
    expect(result.stderr).toContain("app:set_minimize_to_tray");
  });

  it("fails on an allowlisted command nothing implements", () => {
    // Exactly the `__emit__` shape, now that the pending-command escape hatch
    // is empty.
    const result = runGate({
      allowed: ["__emit__", "__window_show__", "get_settings"],
      local: ["__window_show__"],
      dispatched: ["get_settings"],
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Renderer commands missing from sidecar dispatch");
    expect(result.stderr).toContain("__emit__");
  });

  it("still fails on a sidecar arm no renderer can reach", () => {
    const result = runGate({
      allowed: ["__window_show__", "get_settings"],
      local: ["__window_show__"],
      dispatched: ["get_settings", "orphaned_rpc"],
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Sidecar commands no renderer can reach");
    expect(result.stderr).toContain("orphaned_rpc");
  });

  it("refuses to pass vacuously when the switch yields no labels", () => {
    // If a refactor moved the switch and the extractor silently matched
    // nothing, the local-command dimension would stop being checked at all
    // while the gate still reported PASS. Extraction failure is an error.
    const result = runGate({
      allowed: ["get_settings"],
      local: [],
      dispatched: ["get_settings"],
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("produced no case labels");
  });

  it("fails on a duplicated case label", () => {
    const result = runGate({
      allowed: ["__window_show__", "get_settings"],
      local: ["__window_show__", "__window_show__"],
      dispatched: ["get_settings"],
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Duplicate case labels in handleLocalCommand");
  });

  it("ignores case labels of a switch nested inside a case body", () => {
    // Each fixture case body contains `case "not_a_local_command"` at a deeper
    // indentation. Reading the arms at their own indentation is what keeps it
    // out; if it leaked in, the allowlist check above would fail.
    const result = runGate({
      allowed: ["__window_show__", "get_settings"],
      local: ["__window_show__"],
      dispatched: ["get_settings"],
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("not_a_local_command");
  });

  it("does not admit new sidecar commands without an implementation", () => {
    // The derivation must not depend on today's command set: a command added to
    // the allowlist and implemented in the sidecar passes, one added without an
    // implementation does not.
    expect(
      runGate({
        allowed: [
          "__window_show__",
          "revalidate_recording_audio",
          "acknowledge_incomplete_transcript",
        ],
        local: ["__window_show__"],
        dispatched: [
          "revalidate_recording_audio",
          "acknowledge_incomplete_transcript",
        ],
      }).status,
    ).toBe(0);
    expect(
      runGate({
        allowed: ["__window_show__", "revalidate_recording_audio"],
        local: ["__window_show__"],
        dispatched: [],
      }).status,
    ).not.toBe(0);
  });
});
