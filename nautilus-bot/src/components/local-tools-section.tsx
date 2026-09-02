import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsSwitch } from "@/components/ui/settings-control";
import { useToast } from "@/components/toast";
import {
  getCliToolStatus,
  installCliTool,
  type CliInstallResult,
  type CliToolStatus,
} from "@/lib/backend";

interface LocalToolsSectionProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}

/**
 * Settings > General > Local tools: the one switch behind the `plainsong`
 * command, its read-only MCP server, and `plainsong://` links, plus the
 * "Install command-line tool" action.
 *
 * The install row reports state, cause and next action in one line each
 * (DESIGN.md, State Design): installed / not installed / pointing at an older
 * copy / path taken by something else / not in this build. When the app
 * cannot write the link itself it shows the command to paste instead of
 * asking for an administrator password.
 */
export function LocalToolsSection({ enabled, onEnabledChange }: LocalToolsSectionProps) {
  const { toast } = useToast();
  const [status, setStatus] = useState<CliToolStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [lastResult, setLastResult] = useState<CliInstallResult | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await getCliToolStatus());
      setStatusError(null);
    } catch (error) {
      setStatus(null);
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleInstall = async () => {
    setInstalling(true);
    try {
      const result = await installCliTool();
      setLastResult(result);
      if (result.status === "installed") {
        toast(`Installed the plainsong command at ${result.linkPath}.`, "success");
      }
      await refreshStatus();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setInstalling(false);
    }
  };

  const copyManualCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      toast("Copied. Paste it into Terminal and press Return.", "success");
    } catch {
      toast("Could not copy. Select the command and copy it by hand.", "error");
    }
  };

  const manualCommand =
    lastResult?.status === "manual" ? lastResult.command : null;

  let statusLine: string;
  let statusGlyph: "lit" | "hollow" | "rust" = "hollow";
  if (statusError) {
    statusLine = `Could not check the command-line tool: ${statusError}`;
    statusGlyph = "rust";
  } else if (!status) {
    statusLine = "Checking the command-line tool…";
  } else if (!status.binaryPresent) {
    statusLine = "The command-line tool is not part of this build.";
    statusGlyph = "rust";
  } else if (status.installed) {
    statusLine = `Installed. The plainsong command at ${status.linkPath} points at this copy of Plainsong.`;
    statusGlyph = "lit";
  } else if (status.stale) {
    statusLine = `${status.linkPath} points at an older copy of Plainsong. Install again to update it.`;
    statusGlyph = "rust";
  } else if (status.occupied) {
    statusLine = `${status.linkPath} already exists and is not a Plainsong link, so Plainsong leaves it alone.`;
    statusGlyph = "rust";
  } else {
    statusLine = `Not installed. Installing adds ${status.linkPath} so the plainsong command works in any terminal.`;
  }

  const canInstall =
    !!status && status.binaryPresent && !status.installed && !status.occupied && !installing;

  return (
    <div className="pt-4 border-t space-y-4">
      <div className="space-y-1">
        <p className="section-heading">Local tools</p>
        <p className="text-sm text-muted-foreground">
          Apps you run on this Mac, such as a terminal or an AI assistant, can read your
          meeting notes and transcripts. Nothing leaves the machine unless that app sends it.
        </p>
      </div>

      <SettingsSwitch
        className="py-0"
        label="Allow local tools"
        description="Lets the plainsong command, its read-only MCP server, and plainsong:// links work. Off by default. They can read your meetings and dictations and trigger a recording gesture; they cannot change or delete anything."
        checked={enabled}
        onCheckedChange={onEnabledChange}
      />

      <div className="space-y-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-medium">Command-line tool</p>
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <span
                aria-hidden="true"
                className={
                  statusGlyph === "lit"
                    ? "neume neume-lit mt-1.5 shrink-0"
                    : statusGlyph === "rust"
                      ? "neume neume-rust mt-1.5 shrink-0"
                      : "neume neume-hollow mt-1.5 shrink-0"
                }
              />
              <span data-testid="cli-tool-status">{statusLine}</span>
            </p>
          </div>
          <Button
            variant="secondary"
            onClick={() => void handleInstall()}
            disabled={!canInstall}
          >
            {installing ? "Installing…" : "Install command-line tool"}
          </Button>
        </div>

        {lastResult?.status === "unavailable" && (
          <p className="text-sm text-rust">{lastResult.reason}</p>
        )}

        {manualCommand && lastResult?.status === "manual" && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {lastResult.reason} Run this in Terminal to finish the install:
            </p>
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
              <code className="block flex-1 overflow-x-auto rounded-md bg-muted/40 px-3 py-2 font-mono text-sm">
                {manualCommand}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copyManualCommand(manualCommand)}
              >
                Copy command
              </Button>
            </div>
          </div>
        )}

        <p className="text-sm text-muted-foreground">
          Assistants that speak MCP connect with the command{" "}
          <code className="font-mono text-sm">plainsong mcp</code>. Everything it serves is
          read-only, and transcript text is marked as untrusted content.
        </p>
      </div>
    </div>
  );
}
