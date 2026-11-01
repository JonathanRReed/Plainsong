type DeliveryFeedback = {
  label: string;
  detail?: string;
} & (
  | { tone: "success"; sound: "done" }
  | { tone: "quiet"; sound: "attention" | null }
  | { tone: "alert"; sound: "error" }
);

// Wire outcomes from dictation_session.rs. The outcome is what delivery
// observed; where the words can be recovered travels separately as
// `recoveryLocation` on the done event.
export const DICTATION_DELIVERY_FEEDBACK = {
  pasted: { label: "Inserted", tone: "success", sound: "done" },
  replaced: { label: "Replaced", tone: "success", sound: "done" },
  paste_dispatched: {
    label: "Check text", tone: "quiet", sound: "attention",
    detail: "Plainsong couldn't confirm the text landed. If it's missing, use Copy result in Plainsong.",
  },
  copied: { label: "Copied", tone: "quiet", sound: "attention" },
  copied_replacement: { label: "Copied", tone: "quiet", sound: "attention" },
  copied_instead: {
    label: "Copied, press ⌘V", tone: "quiet", sound: "attention",
    detail: "Couldn't insert, so the text is on your clipboard. Press Cmd+V to paste it.",
  },
  secure_field: {
    label: "Secure field", tone: "alert", sound: "error",
    detail: "Not inserted: the field is a password or secure input. Copy the words from Plainsong.",
  },
  // Refused, and the clipboard fallback skipped because the user copied
  // something meanwhile. Their copy stays; the words are in Plainsong.
  clipboard_kept: {
    label: "Clipboard kept", tone: "alert", sound: "error",
    detail: "Not inserted. You copied something while Plainsong was working, so your clipboard was left alone. Copy the words from Plainsong.",
  },
  error: { label: "Not inserted", tone: "alert", sound: "error" },
  aborted: { label: "Cancelled", tone: "quiet", sound: null },
  previewed: { label: "Ready", tone: "quiet", sound: "attention" },
  ready: { label: "Ready", tone: "quiet", sound: "attention" },
  empty: { label: "No speech", tone: "quiet", sound: null },
  undone: { label: "Undone", tone: "quiet", sound: null },
} satisfies Record<string, DeliveryFeedback>;

export function dictationDeliveryFeedback(outcome: unknown): DeliveryFeedback {
  if (typeof outcome === "string" && Object.prototype.hasOwnProperty.call(DICTATION_DELIVERY_FEEDBACK, outcome)) {
    return DICTATION_DELIVERY_FEEDBACK[outcome as keyof typeof DICTATION_DELIVERY_FEEDBACK];
  }
  return { label: "Not inserted", tone: "alert", sound: "error" };
}
