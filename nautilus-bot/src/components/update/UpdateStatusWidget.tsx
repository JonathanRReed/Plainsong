import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Download, ExternalLink, RefreshCw } from "lucide-react";
import { listen } from "@/lib/electron";
import {
  checkForUpdates,
  installUpdate,
  getUpdateStatus,
  type UpdateStatusInfo,
} from "@/lib/backend/updates";

const RELEASES_URL = "https://github.com/JonathanRReed/Plainsong/releases";

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
  const showInvokeError = (error: unknown, fallback: string) => {
    const message = error instanceof Error ? error.message : String(error ?? fallback);
    setStatus({ status: "error", error: message || fallback });
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
      showInvokeError(error, "Couldn't install the update.");
    } finally {
      setIsLoading(false);
    }
  };

  const getStatusBadge = () => {
    switch (status?.status) {
      case "checking":
        return <Badge variant="outline">Checking...</Badge>;
      case "updateAvailable":
        return <Badge className="bg-gold/10 text-gold-text hover:bg-gold/10">Update Available</Badge>;
      case "upToDate":
        return <Badge variant="secondary">Up to Date</Badge>;
      case "downloading":
        return <Badge variant="outline">Downloading...</Badge>;
      case "installing":
        return <Badge variant="outline">Installing...</Badge>;
      case "error":
        return <Badge variant="destructive">Error</Badge>;
      default:
        return <Badge variant="outline">Unknown</Badge>;
    }
  };

  const installBlocked = status?.installBlockedReason === "unsigned";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <RefreshCw className="h-4 w-4" />
            Updates
          </CardTitle>
          {getStatusBadge()}
        </div>
        <CardDescription>
          {status?.status === "updateAvailable" && status.info
            ? `Version ${status.info.version} is available.`
            : "Plainsong never checks on its own. Pressing the button below is the only time it contacts the release feed."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status?.status === "updateAvailable" && status.info && (
          <div className="rounded-md bg-muted p-3 text-sm">
            <div className="font-medium mb-1">What's new in {status.info.version}:</div>
            <div className="text-muted-foreground whitespace-pre-wrap">
              {status.info.notes}
            </div>
          </div>
        )}

        {status?.status === "updateAvailable" && installBlocked && (
          <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
            This build isn't code-signed, so it can't update itself. Download the new
            version from GitHub Releases instead.
          </div>
        )}

        {status?.status === "downloading" && (
          <div className="text-sm text-muted-foreground">
            {typeof status.progress === "number"
              ? `Downloading update… ${Math.round(status.progress)}%`
              : "Downloading update…"}
          </div>
        )}

        {status?.status === "error" && (
          <div className="rounded-md bg-rust/10 p-3 text-sm text-rust">
            {status.error || "An error occurred while checking for updates"}
          </div>
        )}

        <div className="flex gap-2">
          <Button
            onClick={handleCheckForUpdates}
            disabled={isLoading || status?.status === "checking"}
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

          {status?.status === "updateAvailable" && !installBlocked && (
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
              Install update
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
