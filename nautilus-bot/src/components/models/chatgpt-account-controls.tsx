import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listen } from "@/lib/electron";
import {
  cancelChatGptPlanConnect,
  connectChatGptPlan,
  EMPTY_CHATGPT_PLAN_STATUS,
  getChatGptPlanStatus,
  refreshChatGptPlanAccounts,
  selectChatGptPlanAccount,
  signOutChatGptPlan,
  type ChatGptPlanStatus,
} from "@/lib/backend/chatgpt-plan";

interface ChatGptAccountControlsProps {
  remoteProcessingEnabled: boolean;
  onStatusChange: (status: ChatGptPlanStatus) => void;
}

type Action = "load" | "connect" | "select" | "signout" | "cancel";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ChatGptAccountControls({
  remoteProcessingEnabled,
  onStatusChange,
}: ChatGptAccountControlsProps) {
  const [status, setStatus] = useState(EMPTY_CHATGPT_PLAN_STATUS);
  const [busy, setBusy] = useState<Action | null>(null);
  const [busyClientId, setBusyClientId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const applyStatus = useCallback((next: ChatGptPlanStatus) => {
    if (!mountedRef.current) return;
    setStatus(next);
    setError(null);
    onStatusChange(next);
  }, [onStatusChange]);

  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;
    void getChatGptPlanStatus().then(next => { if (!disposed) applyStatus(next); }).catch((cause) => {
      if (!disposed && mountedRef.current) setError(errorMessage(cause));
    });
    let unlisten = () => {};
    void listen<ChatGptPlanStatus>("chatgpt-account-changed", (event) => {
      if (!disposed) applyStatus(event.payload);
    }).then((stop) => {
      if (!disposed) {
        unlisten = stop;
      } else {
        stop();
      }
    });
    return () => {
      disposed = true;
      mountedRef.current = false;
      unlisten();
    };
  }, [applyStatus]);

  const run = useCallback(async (
    action: Action,
    task: () => Promise<ChatGptPlanStatus>,
    clientId?: string,
  ) => {
    setBusy(action);
    setBusyClientId(clientId ?? null);
    setError(null);
    try {
      applyStatus(await task());
    } catch (cause) {
      if (mountedRef.current) setError(errorMessage(cause));
    } finally {
      if (mountedRef.current) setBusy(null);
      if (mountedRef.current) setBusyClientId(null);
    }
  }, [applyStatus]);

  const active = status.accounts.find((account) => account.active) ?? null;
  const cloudDisabled = !remoteProcessingEnabled;

  return (
    <section className="space-y-3 rounded-lg border bg-muted/20 p-4" aria-labelledby="chatgpt-account-heading">
      <div>
        <p id="chatgpt-account-heading" className="font-medium">ChatGPT account</p>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Use models available to a saved ChatGPT account for dictation cleanup or meeting notes. Plainsong sends text only.
        </p>
        <a
          className="mt-2 inline-block text-sm underline underline-offset-4"
          href="https://chatgpt.com/settings/usage"
          target="_blank"
          rel="noreferrer"
        >
          Manage ChatGPT usage
        </a>
      </div>

      {cloudDisabled ? (
        <p className="text-sm leading-6 text-muted-foreground">
          Cloud AI is off. Allow it under Privacy &amp; data to load, connect or switch accounts.
        </p>
      ) : null}

      {!status.loaded ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Saved accounts have not been checked yet.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={cloudDisabled || busy !== null}
            onClick={() => void run("load", refreshChatGptPlanAccounts)}
          >
            {busy === "load" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Load saved accounts
          </Button>
          <Button
            className="ml-2"
            size="sm"
            disabled={cloudDisabled || busy !== null}
            onClick={() => void run("connect", () => connectChatGptPlan())}
          >
            {busy === "connect" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Continue with ChatGPT
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {status.accounts.length > 0 ? (
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="chatgpt-saved-account">Saved account</label>
              <select
                id="chatgpt-saved-account"
                className="w-full rounded-md border bg-background p-2 text-sm"
                value={active?.clientId ?? ""}
                disabled={cloudDisabled || busy !== null}
                onChange={(event) => {
                  const clientId = event.target.value;
                  const account = status.accounts.find((item) => item.clientId === clientId);
                  if (!account) return;
                  if (account.connected) {
                    void run("select", () => selectChatGptPlanAccount(clientId), clientId);
                  } else {
                    void run("connect", () => connectChatGptPlan(clientId), clientId);
                  }
                }}
              >
                <option value="" disabled>Choose an account</option>
                {status.accounts.map((account) => (
                  <option key={account.clientId} value={account.clientId}>
                    {account.label}{account.connected ? "" : " (signed out)"}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No saved ChatGPT account was found.</p>
          )}

          {active?.connected && !active.planEnabled ? (
            <p className="text-sm leading-6 text-rust">
              This account is signed in, but it has not granted access to ChatGPT plan models. Reconnect it and approve the requested access.
            </p>
          ) : null}
          {busy === "connect" && busyClientId ? (
            <p className="text-sm text-muted-foreground">
              Connecting {status.accounts.find((account) => account.clientId === busyClientId)?.label ?? "saved account"}…
            </p>
          ) : null}
          {status.modelError ? <p className="text-sm leading-6 text-rust">{status.modelError}</p> : null}
          {status.remoteRevocation === "unconfirmed" ? (
            <p className="text-sm leading-6 text-rust">
              The local session was removed, but ChatGPT could not confirm remote revocation. Review connected access in{" "}
              <a className="underline" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">ChatGPT settings</a>.
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={cloudDisabled || busy !== null}
              onClick={() => void run("connect", () => connectChatGptPlan(active?.clientId), active?.clientId)}
            >
              {busy === "connect" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {active ? "Reconnect with ChatGPT" : "Continue with ChatGPT"}
            </Button>
            {active ? (
              <Button
                variant="outline"
                size="sm"
                disabled={cloudDisabled || busy !== null}
                onClick={() => void run("connect", () => connectChatGptPlan())}
              >
                Add another account
              </Button>
            ) : null}
            <Button variant="outline" size="sm" disabled={cloudDisabled || busy !== null} onClick={() => void run("load", refreshChatGptPlanAccounts)}>
              Refresh accounts
            </Button>
            {busy === "connect" ? (
              <Button variant="ghost" size="sm" onClick={() => void run("cancel", cancelChatGptPlanConnect)}>Cancel</Button>
            ) : null}
            {active ? (
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void run("signout", () => signOutChatGptPlan(active.clientId))}>
                Sign out
              </Button>
            ) : null}
          </div>
        </div>
      )}

      {error ? <p role="alert" className="text-sm leading-6 text-rust">{error}</p> : null}
    </section>
  );
}
