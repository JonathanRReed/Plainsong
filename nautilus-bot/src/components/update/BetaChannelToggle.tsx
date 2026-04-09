import { useState, useEffect } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle } from "lucide-react";
import {
  getUpdateChannel,
  setUpdateChannel,
  canUseBetaChannel,
  type UpdateChannel,
} from "@/lib/backend";

interface BetaChannelToggleProps {
  disabled?: boolean;
}

export function BetaChannelToggle({ disabled }: BetaChannelToggleProps) {
  const [channel, setChannelState] = useState<UpdateChannel>("stable");
  const [canUseBeta, setCanUseBeta] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    // Load current channel
    getUpdateChannel().then(setChannelState);
    // Check if user can use beta
    canUseBetaChannel().then(setCanUseBeta);
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

  if (!canUseBeta) {
    return (
      <div className="flex items-center justify-between rounded-md border p-4 opacity-60">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <Label className="text-sm font-medium">Beta Channel</Label>
            <Badge variant="secondary" className="text-xs">⭐ Friends Club</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Get early access to new features and improvements
          </p>
        </div>
        <Switch disabled checked={false} />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between rounded-md border p-4">
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <Label className="text-sm font-medium">Beta Channel</Label>
          <Badge variant="secondary" className="bg-amber-100 text-amber-800 text-xs">⭐ Friends Club</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Get early access to new features and improvements
        </p>
        {channel === "beta" && (
          <div className="flex items-center gap-1.5 text-xs text-amber-600 mt-1">
            <AlertTriangle className="h-3 w-3" />
            <span>Beta versions may be less stable than stable releases</span>
          </div>
        )}
      </div>
      <Switch
        checked={channel === "beta"}
        onCheckedChange={handleToggle}
        disabled={disabled || isLoading}
      />
    </div>
  );
}
