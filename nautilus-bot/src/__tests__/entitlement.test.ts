import { describe, it, expect } from "vitest";
import {
  canUseFormattingAssistant,
  deriveEntitlement,
  getThemeAccessLevel,
} from "@/hooks/use-license-features";
import type { LicenseInfo } from "@/lib/tauri";

function makeLicense(
  overrides: Partial<LicenseInfo> = {}
): LicenseInfo {
  return {
    key: "",
    instanceId: "",
    tier: "none",
    valid: false,
    lsStatus: "",
    activationsLimit: 5,
    activationsUsage: 0,
    lastValidatedAt: "",
    trialDaysRemaining: 0,
    nagRequired: false,
    trialActive: false,
    ...overrides,
  };
}

describe("deriveEntitlement", () => {
  it("trial active grants pro features and update access", () => {
    const ent = deriveEntitlement(makeLicense({ trialActive: true, trialDaysRemaining: 20 }));
    expect(ent.trialActive).toBe(true);
    expect(ent.licenseValid).toBe(false);
    expect(ent.tier).toBe("pro");
    expect(ent.proEnabled).toBe(true);
    expect(ent.experimentalEnabled).toBe(false);
    expect(ent.canUpdate).toBe(true);
    expect(ent.features.whisperLargeModel).toBe(true);
    expect(ent.features.cloudSync).toBe(false);
    expect(canUseFormattingAssistant(makeLicense({ trialActive: true, trialDaysRemaining: 20 }))).toBe(false);
    expect(getThemeAccessLevel(makeLicense({ trialActive: true, trialDaysRemaining: 20 }))).toBe("basic");
  });

  it("valid pro license grants pro features", () => {
    const ent = deriveEntitlement(makeLicense({ valid: true, tier: "pro" }));
    expect(ent.licenseValid).toBe(true);
    expect(ent.tier).toBe("pro");
    expect(ent.proEnabled).toBe(true);
    expect(ent.experimentalEnabled).toBe(false);
    expect(ent.canUpdate).toBe(true);
    expect(ent.features.autoDiarization).toBe(true);
    expect(ent.features.cloudSync).toBe(false);
    expect(canUseFormattingAssistant(makeLicense({ valid: true, tier: "pro" }))).toBe(true);
    expect(getThemeAccessLevel(makeLicense({ valid: true, tier: "pro" }))).toBe("pro");
  });

  it("valid friends_club license grants experimental features", () => {
    const ent = deriveEntitlement(makeLicense({ valid: true, tier: "friends_club" }));
    expect(ent.tier).toBe("friends");
    expect(ent.proEnabled).toBe(true);
    expect(ent.experimentalEnabled).toBe(true);
    expect(ent.canUpdate).toBe(true);
    expect(ent.features.cloudSync).toBe(true);
    expect(ent.features.prioritySupport).toBe(true);
    expect(canUseFormattingAssistant(makeLicense({ valid: true, tier: "friends_club" }))).toBe(true);
    expect(getThemeAccessLevel(makeLicense({ valid: true, tier: "friends_club" }))).toBe("friends");
  });

  it("expired trial with no license locks everything", () => {
    const ent = deriveEntitlement(makeLicense({ trialActive: false, valid: false }));
    expect(ent.tier).toBe("free");
    expect(ent.proEnabled).toBe(false);
    expect(ent.experimentalEnabled).toBe(false);
    expect(ent.canUpdate).toBe(false);
    expect(ent.features.whisperLargeModel).toBe(false);
    expect(ent.features.cloudSync).toBe(false);
    expect(canUseFormattingAssistant(makeLicense({ trialActive: false, valid: false }))).toBe(false);
    expect(getThemeAccessLevel(makeLicense({ trialActive: false, valid: false }))).toBe("basic");
  });

  it("null license defaults to free tier", () => {
    const ent = deriveEntitlement(null);
    expect(ent.tier).toBe("free");
    expect(ent.proEnabled).toBe(false);
    expect(ent.canUpdate).toBe(false);
  });
});
