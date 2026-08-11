export const REQUIRED_AUTOMATED_MEETING_SCENARIOS: string[];
export const REQUIRED_REAL_DEVICE_MEETING_SCENARIOS: string[];

export interface MeetingLifecycleCheck {
  id: string;
  mode: "automated" | "real_device";
  pass: boolean;
  evidence: string;
  detail: string;
}

export interface MeetingLifecycleReceipt {
  schemaVersion: number;
  generatedAt: string;
  candidateIdentityTarget?: string;
  candidateAppSha256: string | null;
  pass: boolean;
  summary: {
    total: number;
    passed: number;
    automated: number;
    realDevice: number;
  };
  checks: MeetingLifecycleCheck[];
}

export function evaluateMeetingLifecycleEvidence(
  evidence: Record<string, any>,
): MeetingLifecycleReceipt;
