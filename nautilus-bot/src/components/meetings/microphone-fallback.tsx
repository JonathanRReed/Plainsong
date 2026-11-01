import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@/lib/electron";
import type { MeetingMicrophoneInput } from "@/lib/meeting-microphone-input";

export function MeetingMicrophoneFallback({ recordingId, input, dismissed = false, active, onSettings }: {
  recordingId: string | null; input: MeetingMicrophoneInput | null | undefined; dismissed?: boolean;
  active: boolean; onSettings: () => void | Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const scopeRef = useRef({ recordingId, input, active });
  if (scopeRef.current.recordingId !== recordingId || scopeRef.current.input !== input || scopeRef.current.active !== active) {
    scopeRef.current = { recordingId, input, active };
  }
  const scope = scopeRef.current;
  useEffect(() => { setError(null); }, [scope]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (!active || !recordingId || !input?.usedFallback || dismissed) return null;
  const dismiss = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(true); setError(null);
    try {
      await invoke("dismiss_meeting_microphone_warning", { recordingId });
    } catch {
      if (mounted.current && scopeRef.current === scope) setError("Could not dismiss this warning. Try again.");
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return <section aria-label="Meeting microphone" className="rounded-md border border-rust/30 bg-rust/10 p-3 text-sm">
    <p role="status">Using {input.resolvedName}.</p>
    <p className="mt-1">{input.requestedName ? `${input.requestedName} is unavailable, so Plainsong is using this microphone.` : "Plainsong is using a fallback microphone."}</p>
    <p className="mt-1 text-xs text-muted-foreground">Microphone changes apply to the next recording.</p>
    <div className="mt-2 flex gap-2">
      <Button type="button" variant="outline" size="sm" onClick={() => {
        void Promise.resolve().then(onSettings).catch(() => {
          if (mounted.current && scopeRef.current === scope) setError("Could not open settings. Try again.");
        });
      }}>Settings</Button>
      <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => { void dismiss(); }}>{pending ? "Dismissing…" : "Dismiss warning"}</Button>
    </div>
    {error && <p role="alert" className="mt-2">{error}</p>}
  </section>;
}
