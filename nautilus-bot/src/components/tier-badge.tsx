import { Shield, Star, Lock, Check } from "lucide-react";
import { cn } from "@/lib/utils";

type TierRequirement = "pro" | "friends";

type TierBadgeProps = {
  required: TierRequirement;
  unlocked?: boolean;
  className?: string;
};

export function TierBadge({ required, unlocked = false, className }: TierBadgeProps) {
  const isFriends = required === "friends";
  const label = isFriends ? "Friends Club" : "Pro";

  const tierIcon = isFriends ? (
    <Star className="h-3 w-3 shrink-0" />
  ) : (
    <Shield className="h-3 w-3 shrink-0" />
  );

  const statusIcon = unlocked ? (
    <Check className="h-3 w-3 shrink-0" />
  ) : (
    <Lock className="h-3 w-3 shrink-0" />
  );

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium leading-tight select-none",
        unlocked
          ? isFriends
            ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
            : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
          : "bg-muted text-muted-foreground",
        className
      )}
    >
      {tierIcon}
      {label}
      {statusIcon}
    </span>
  );
}
