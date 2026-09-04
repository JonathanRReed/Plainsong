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
    <div className="flex items-center justify-between rounded-md border p-4">
      <div className="space-y-0.5">
        <Label htmlFor="beta-channel-toggle" className="text-sm font-medium">
          Beta updates
        </Label>
        <p id="beta-channel-description" className="text-sm text-muted-foreground">
          Changes which release feed the check below reads. Beta builds arrive
          earlier and are tested less; stable is what everyone else gets.
        </p>
        {channel === "beta" && (
          <div className="mt-1 flex items-center gap-1.5 text-sm text-rust">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              You are on the beta feed, so the next update may be less stable
              than the release it replaces.
            </span>
          </div>
        )}
      </div>
      <Switch
        id="beta-channel-toggle"
        aria-describedby="beta-channel-description"
        checked={channel === "beta"}
        onCheckedChange={handleToggle}
        disabled={disabled || isLoading}
      />
    </div>
  );
}
