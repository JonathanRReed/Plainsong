import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Download, Lock, RefreshCw } from "lucide-react";
import {
  checkForUpdates,
  installUpdate,
  getUpdateStatus,
  getUpdateLockReason,
  validateLicense,
  type UpdateStatusInfo,
  type LicenseInfo,
} from "@/lib/tauri";

export function UpdateStatusWidget() {
  const [license, setLicense] = useState<LicenseInfo | null>(null);
  const [status, setStatus] = useState<UpdateStatusInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lockReason, setLockReason] = useState<string | null>(null);

  // Load license info
  useEffect(() => {
    validateLicense().then(setLicense).catch(console.error);
  }, []);

  // Check if updates are locked
  useEffect(() => {
    if (license && !license.valid && !license.trialActive) {
      getUpdateLockReason().then(setLockReason);
    }
  }, [license]);

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

  // If updates are locked, show lock message
  if (lockReason) {
    return (
      <Card className="border-amber-200 bg-amber-50/50">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Lock className="h-4 w-4 text-amber-600" />
            Updates Locked
          </CardTitle>
          <CardDescription>{lockReason}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open("https://nautilusbot.lemonsqueezy.com", "_blank")}
          >
            Purchase License
          </Button>
        </CardContent>
      </Card>
    );
  }

  const getStatusBadge = () => {
    switch (status?.status) {
      case "checking":
        return <Badge variant="outline">Checking...</Badge>;
      case "updateAvailable":
        return <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100">Update Available</Badge>;
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
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">
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
