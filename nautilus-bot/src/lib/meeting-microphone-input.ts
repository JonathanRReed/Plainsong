export interface MeetingMicrophoneInput {
  requestedName: string | null;
  resolvedName: string;
  usedFallback: boolean;
  advisory: string | null;
}

const name = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim().slice(0, 240) : null;

export function parseMeetingMicrophoneInput(value: unknown): MeetingMicrophoneInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const resolvedName = name(input.resolvedName);
  if (!resolvedName || typeof input.usedFallback !== "boolean") return null;
  return { requestedName: name(input.requestedName), resolvedName, usedFallback: input.usedFallback, advisory: name(input.advisory) };
}

export function sameMeetingMicrophoneInput(left: MeetingMicrophoneInput | null, right: MeetingMicrophoneInput | null): boolean {
  return left === right || Boolean(left && right && left.requestedName === right.requestedName
    && left.resolvedName === right.resolvedName && left.usedFallback === right.usedFallback && left.advisory === right.advisory);
}
