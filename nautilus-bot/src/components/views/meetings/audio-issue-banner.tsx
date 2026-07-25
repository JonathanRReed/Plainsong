import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Lock } from "lucide-react";

interface AudioIssueBannerProps {
  /** The meeting whose audio would not open, named as the reader named it. */
  meetingTitle: string;
  /** The backend's own words about what went wrong and what to do next. */
  message: string;
  onUnlockVault: () => void;
  onDismiss: () => void;
}

/**
 * What the reader sees when audio will not open. It lives in its own file
 * because the workspace and the meeting list are two exclusive branches of the
 * same view: the banner used to exist only in the list, so failing to play from
 * inside a meeting left a locked-vault user with a toast and no way to unlock.
 */
export function AudioIssueBanner({
  meetingTitle,
  message,
  onUnlockVault,
  onDismiss,
}: AudioIssueBannerProps) {
  const isLockedVault = /vault is locked/i.test(message);

  return (
    <Card className="border-rust/40 bg-rust/5">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-rust">
              Couldn't open the audio for {meetingTitle}
            </p>
            {/* The backend already said what went wrong and what to do
                about it; pass that through instead of a generic line. */}
            <p className="mt-1 text-sm text-muted-foreground">{message}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            {isLockedVault && (
              <Button size="sm" variant="outline" onClick={onUnlockVault}>
                <Lock className="mr-2 h-4 w-4" />
                Unlock vault
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Dismiss
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
