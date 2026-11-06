import { describe, expect, it } from "vitest";
import { sidecarModule } from "./sidecar-source";

describe("export_paths open_path_in_default_app security", () => {
  it("uses PowerShell with -LiteralPath and avoids cmd.exe on Windows", () => {
    const exportPathsSource = sidecarModule("export_paths.rs");

    // Must not use cmd.exe /C start which is vulnerable to command injection via shell metacharacters
    expect(exportPathsSource).not.toContain('Command::new("cmd")');
    expect(exportPathsSource).not.toContain('"/C"');

    // Must use PowerShell with Start-Process -LiteralPath and single-quote escaping on Windows
    expect(exportPathsSource).toContain('Command::new("powershell")');
    expect(exportPathsSource).toContain("Start-Process -LiteralPath");
    expect(exportPathsSource).toContain(".replace('\\'', \"''\")");
  });
});
