import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Download, ExternalLink, RefreshCw } from "lucide-react";
import { listen } from "@/lib/electron";
import {
  checkForUpdates,
  installUpdate,
  getUpdateStatus,
  type UpdateStatusInfo,
} from "@/lib/backend/updates";

const RELEASES_URL = "https://github.com/JonathanRReed/Plainsong/releases";

const OFFLINE =
  /net::ERR_(?:INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|CONNECTION_\w+|ADDRESS_UNREACHABLE|TIMED_OUT|PROXY_\w+)|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|network (?:is )?unreachable|offline/i;
const SERVER_STATUS = /\b(?:HttpError|status code|HTTP)\b:?\s*(?:4|5)\d\d/i;

/**
 * The updater's errors arrive as Chromium and Node network codes inside
 * Electron's "Error invoking remote method" wrapper. Say what happened.
 */
function describeUpdateError(raw: string | null | undefined, fallback: string): string {
  const message = (raw ?? "")
    .trim()
    .replace(/^(?:(?:Error invoking remote method ['"][^'"]+['"]:\s*)|(?:Error:\s*))+/i, "")
    .trim();
  if (OFFLINE.test(message)) {
    return "Plainsong couldn't reach the update server. Check your internet connection, then try again.";
  }
  if (SERVER_STATUS.test(message)) {
    return "The update server didn't answer as expected. Try again later.";
  }
  return message || fallback;
}

export function UpdateStatusWidget() {
  const [status, setStatus] = useState<UpdateStatusInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Load the initial status, then let main-process pushes drive the UI so
  // download progress, install transitions, and async errors all render.
  useEffect(() => {
    getUpdateStatus()
      .then(setStatus)
      .catch((error) => {
        console.error("Failed to load update status:", error);
      });
    const unlistenPromise = listen<UpdateStatusInfo>("update-status-changed", (event) => {
      setStatus(event.payload);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // Route invoke failures into the widget's error panel so an offline check
  // doesn't end as a spinner that stops with no explanation.
  const showInvokeError = (error: unknown, fallback: string, keepUpdate = false) => {
    const message = error instanceof Error ? error.message : String(error ?? "");
    // Keep the version a failed install was for, so it can be retried.
    setStatus((current) => ({
      status: "error",
      info: keepUpdate ? current?.info : undefined,
      installBlockedReason: keepUpdate ? current?.installBlockedReason : undefined,
      error: describeUpdateError(message, fallback),
    }));
  };

  const handleCheckForUpdates = async () => {
    setIsLoading(true);
    try {
      await checkForUpdates();
    } catch (error) {
      console.error("Failed to check for updates:", error);
      showInvokeError(error, "Couldn't check for updates. Are you offline?");
    } finally {
      setIsLoading(false);
    }
  };

  const handleInstallUpdate = async () => {
    setIsLoading(true);
    try {
      await installUpdate();
      // App will restart automatically
    } catch (error) {
      console.error("Failed to install update:", error);
      showInvokeError(error, "Couldn't install the update.", true);
    } finally {
      setIsLoading(false);
    }
  };

  // Sentence-case state words with a neume, the way every other settings
  // status reads; gold only for an update that is actually waiting.
  const statusLabel = (): { text: string; glyph: "lit" | "hollow" | "rust" } | null => {
    switch (status?.status) {
      case "checking":
        return { text: "Checking…", glyph: "hollow" };
      case "updateAvailable":
        return { text: "Update available", glyph: "lit" };
      case "upToDate":
        return { text: "Up to date", glyph: "hollow" };
      case "downloading":
        return { text: "Downloading…", glyph: "hollow" };
      case "installing":
        return { text: "Installing…", glyph: "hollow" };
      case "error":
        return { text: "Error", glyph: "rust" };
      default:
        // Nothing has been checked yet: no state word is better than "Unknown".
        return null;
    }
  };

  const installBlocked = status?.installBlockedReason === "unsigned";
  const state = statusLabel();
  const busy = status?.status === "checking" || status?.status === "downloading" || status?.status === "installing";
  // A failed install keeps the version it was for; offer it again instead of
  // making the reader check (and download) all over.
  const canRetryInstall =
    status?.status === "error" &&
    Boolean(status.info) &&
    !installBlocked &&
    !/was rejected because it is not newer/i.test(status.error ?? "");

  return (
    <div id="setting-updates" className="py-3.5">
      <div className="flex flex-col gap-3 @md:flex-row @md:items-start @md:justify-between @md:gap-6">
        <div className="min-w-0 space-y-1">
          <p className="flex items-center gap-2 text-sm font-medium leading-5">
            Updates
            {state ? (
              <span
                className={`inline-flex items-center gap-1.5 text-sm font-normal ${
                  state.glyph === "lit"
                    ? "text-gold-text"
                    : state.glyph === "rust"
                      ? "text-rust"
                      : "text-muted-foreground"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`neume ${state.glyph === "lit" ? "neume-lit" : state.glyph === "rust" ? "neume-rust" : "neume-hollow"}`}
                />
                {state.text}
              </span>
            ) : null}
          </p>
          <p className="text-sm leading-5 text-muted-foreground">
            {status?.status === "updateAvailable" && status.info
              ? `Version ${status.info.version} is available.`
              : "Plainsong never checks on its own. This button is the only time it contacts the release feed."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            onClick={handleCheckForUpdates}
            disabled={isLoading || busy}
            variant="outline"
            size="sm"
          >
            {isLoading || status?.status === "checking" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Check for updates
          </Button>

          {status?.status === "updateAvailable" && installBlocked && (
            <Button onClick={() => window.open(RELEASES_URL)} size="sm">
              <ExternalLink className="mr-2 h-4 w-4" />
              Download from GitHub
            </Button>
          )}

          {((status?.status === "updateAvailable" && !installBlocked) || canRetryInstall) && (
            <Button
              onClick={handleInstallUpdate}
              disabled={isLoading}
              size="sm"
            >
              {isLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              {canRetryInstall ? "Try installing again" : "Install update"}
            </Button>
          )}
        </div>
      </div>

      {status?.status === "updateAvailable" && status.info && (
        <div className="mt-3 rounded-md bg-muted/50 p-3 text-sm">
          <div className="mb-1 font-medium">What's new in {status.info.version}:</div>
          <div className="whitespace-pre-wrap text-muted-foreground">
            {status.info.notes}
          </div>
        </div>
      )}

      {status?.status === "updateAvailable" && installBlocked && (
        <p className="mt-3 text-sm text-muted-foreground">
          This build isn't code-signed, so it can't update itself. Download the new
          version from GitHub Releases instead.
        </p>
      )}

      {status?.status === "downloading" && (
        <p className="mt-3 text-sm text-muted-foreground">
          {typeof status.progress === "number"
            ? `Downloading update… ${Math.round(status.progress)}%`
            : "Downloading update…"}
        </p>
      )}

      {status?.status === "error" && (
        <p role="alert" className="mt-3 rounded-md bg-rust/10 p-3 text-sm text-rust">
          {describeUpdateError(status.error, "Something went wrong with the update. Try again.")}
        </p>
      )}
    </div>
  );
}
