import type { LicenseInfo, LicenseTier } from "@/lib/backend/license";

interface FeatureFlags {
  whisperLargeModel: boolean;
  intelligentPunctuation: boolean;
  autoDiarization: boolean;
  cloudSync: boolean;
  prioritySupport: boolean;
}

interface Entitlement {
  trialActive: boolean;
  licenseValid: boolean;
  tier: "free" | "pro" | "friends";
  proEnabled: boolean;
  experimentalEnabled: boolean;
  canUpdate: boolean;
  features: FeatureFlags;
}

type ThemeAccessLevel = "basic" | "pro" | "friends";

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

export function deriveEntitlement(license: LicenseInfo | null): Entitlement {
  const trialActive = license?.trialActive ?? false;
  const licenseValid = license?.valid ?? false;
  const rawTier = license?.tier ?? "none";

  const tier: Entitlement["tier"] =
    licenseValid && rawTier === "friends_club"
      ? "friends"
      : licenseValid || trialActive
        ? "pro"
        : "free";

  const proEnabled = licenseValid || trialActive;
  const experimentalEnabled = licenseValid && rawTier === "friends_club";
  const canUpdate = licenseValid || trialActive;

  const effectiveTier: LicenseTier =
    licenseValid ? rawTier : trialActive ? "pro" : "none";
  const features = TIER_FEATURES[effectiveTier] ?? TIER_FEATURES.none;

  return {
    trialActive,
    licenseValid,
    tier,
    proEnabled,
    experimentalEnabled,
    canUpdate,
    features,
  };
}

export function isFeatureAllowed(
  license: LicenseInfo | null,
  feature: keyof FeatureFlags
): boolean {
  return deriveEntitlement(license).features[feature];
}

export function canUseFormattingAssistant(license: LicenseInfo | null): boolean {
  // Product rule: trial users do not get Formatting Assistant Mode.
  return Boolean(license?.valid);
}

export function getThemeAccessLevel(license: LicenseInfo | null): ThemeAccessLevel {
  if (!license?.valid) {
    return "basic";
  }

  if (license.tier === "friends_club") {
    return "friends";
  }

  return "pro";
}
