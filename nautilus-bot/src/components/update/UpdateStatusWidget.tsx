import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Download, RefreshCw } from "lucide-react";
import {
  checkForUpdates,
  installUpdate,
  getUpdateStatus,
  type UpdateStatusInfo,
} from "@/lib/backend/updates";

export function UpdateStatusWidget() {
  const [status, setStatus] = useState<UpdateStatusInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Load initial status
  useEffect(() => {
    getUpdateStatus().then(setStatus);
  }, []);

  const handleCheckForUpdates = async () => {
    setIsLoading(true);
    try {
      await checkForUpdates();
      const currentStatus = await getUpdateStatus();
      setStatus(currentStatus);
    } catch (error) {
      console.error("Failed to check for updates:", error);
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
            ? `Version ${status.info.version} is available`
            : "Check for the latest updates to get new features and bug fixes"}
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
            Check for Updates
          </Button>

          {status?.status === "updateAvailable" && (
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
              Install Update
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
