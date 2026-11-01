import { useState, useEffect } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AlertTriangle } from "lucide-react";
import {
  getUpdateChannel,
  setUpdateChannel,
  type UpdateChannel,
} from "@/lib/backend/updates";

interface BetaChannelToggleProps {
  disabled?: boolean;
}

export function BetaChannelToggle({ disabled }: BetaChannelToggleProps) {
  const [channel, setChannelState] = useState<UpdateChannel>("stable");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    getUpdateChannel().then(setChannelState);
  }, []);

  const handleToggle = async (checked: boolean) => {
    const newChannel: UpdateChannel = checked ? "beta" : "stable";
    setIsLoading(true);
    try {
      await setUpdateChannel(newChannel);
      setChannelState(newChannel);
    } catch (error) {
      console.error("Failed to change update channel:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div id="setting-beta-updates" className="flex items-start justify-between gap-6 py-3.5">
      <div className="min-w-0 space-y-1">
        <Label htmlFor="beta-channel-toggle" className="text-sm font-medium leading-5">
          Beta updates
        </Label>
        <p id="beta-channel-description" className="text-sm leading-5 text-muted-foreground">
          Checks the beta feed instead of stable. Beta builds arrive earlier
          and are tested less.
        </p>
        {channel === "beta" && (
          <p className="flex items-center gap-1.5 text-sm text-rust">
            <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span>
              You are on the beta feed, so the next update may be less stable
              than the release it replaces.
            </span>
          </p>
        )}
      </div>
      <Switch
        id="beta-channel-toggle"
        className="mt-0.5"
        aria-describedby="beta-channel-description"
        checked={channel === "beta"}
        onCheckedChange={handleToggle}
        disabled={disabled || isLoading}
      />
    </div>
  );
}
