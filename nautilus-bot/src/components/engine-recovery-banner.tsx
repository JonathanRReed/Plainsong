import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusBanner } from "@/components/ui/status-banner";
import { invoke } from "@/lib/electron";
import type { SidecarLossNotice } from "@/lib/sidecar-runtime";

export function EngineRecoveryBanner({ notice, onDismiss }: {
  notice: SidecarLossNotice; onDismiss?: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  useEffect(() => {
    ++requestRef.current;
    setPending(false);
    setError(null);
    return () => { ++requestRef.current; };
  }, [notice]);
  const unlock = async () => {
    if (pending) return;
    const request = ++requestRef.current;
    setPending(true);
    setError(null);
    try {
      await invoke("retry_sidecar_with_credential_access");
      // Keep the action disabled until the engine recovers or reports a new failure.
    } catch {
      if (requestRef.current !== request) return;
      setPending(false);
      setError("Couldn't retry. Choose Unlock and retry again when you're ready.");
    }
  };
  return <StatusBanner
    tone={notice.recovering ? "muted" : "rust"}
    role={notice.recovering ? "status" : "alert"}
    title={notice.title}
    message={<>{notice.message}{error ? <p className="mt-2 text-sm">{error}</p> : null}</>}
    actions={<>
      {notice.action === "unlock_credentials" ? <Button size="sm" disabled={pending}
        onClick={() => { void unlock(); }}>{pending ? "Waiting for approval…" : "Unlock and retry"}</Button> : null}
      <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>
    </>}
  />;
}
