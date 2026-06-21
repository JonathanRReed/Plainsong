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
        <Label htmlFor="beta-channel-toggle" className="text-sm font-medium">Beta Channel</Label>
        <p className="text-sm text-muted-foreground">
          Get early access to new features and improvements
        </p>
        {channel === "beta" && (
          <div className="flex items-center gap-1.5 text-xs text-rust mt-1">
            <AlertTriangle className="h-3 w-3" />
            <span>Beta versions may be less stable than stable releases</span>
          </div>
        )}
      </div>
      <Switch
        id="beta-channel-toggle"
        checked={channel === "beta"}
        onCheckedChange={handleToggle}
        disabled={disabled || isLoading}
      />
    </div>
  );
}
