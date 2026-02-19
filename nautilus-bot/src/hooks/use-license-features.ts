import { useMemo } from "react";
import type { LicenseInfo, LicenseTier } from "@/lib/tauri";

export interface FeatureFlags {
  whisperLargeModel: boolean;
  intelligentPunctuation: boolean;
  autoDiarization: boolean;
  cloudSync: boolean;
  prioritySupport: boolean;
}

const TIER_FEATURES: Record<LicenseTier, FeatureFlags> = {
  none: {
    whisperLargeModel: false,
    intelligentPunctuation: false,
    autoDiarization: false,
    cloudSync: false,
    prioritySupport: false,
  },
  pro: {
    whisperLargeModel: true,
    intelligentPunctuation: true,
    autoDiarization: true,
    cloudSync: false,
    prioritySupport: false,
  },
  friends_club: {
    whisperLargeModel: true,
    intelligentPunctuation: true,
    autoDiarization: true,
    cloudSync: true,
    prioritySupport: true,
  },
};

export function useLicenseFeatures(license: LicenseInfo | null): FeatureFlags {
  return useMemo(() => {
    const tier = license?.valid ? license.tier : "none";
    return TIER_FEATURES[tier] ?? TIER_FEATURES.none;
  }, [license?.valid, license?.tier]);
}

export function isFeatureAllowed(
  license: LicenseInfo | null,
  feature: keyof FeatureFlags
): boolean {
  const tier = license?.valid ? license.tier : "none";
  return TIER_FEATURES[tier]?.[feature] ?? false;
}
