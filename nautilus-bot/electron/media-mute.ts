export type MediaMuteOutcome =
  | { kind: "restored" }
  | { kind: "skipped"; reason: string }
  | { kind: "deferred"; reason: string };

export type MediaMuteSession = {
  ready: Promise<boolean>;
  mute: () => Promise<boolean>;
  restore: () => Promise<MediaMuteOutcome>;
};

export type MediaMuteBackend = {
  open: () => Promise<MediaMuteSession | null>;
  recover: () => Promise<MediaMuteOutcome>;
};

const MUTE_DELAY_MS = 450;

export function createMediaMuteController(deps: {
  backend: MediaMuteBackend;
  schedule?: (callback: () => void, ms: number) => () => void;
  log?: (message: string, error?: unknown) => void;
}) {
  const schedule = deps.schedule ?? ((callback, ms) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  });
  let pending: (() => void) | null = null;
  let generation = 0;
  let armed = false;
  let active: MediaMuteSession | null = null;
  let opening: Promise<void> | null = null;
  let recovery: Promise<void> | null = null;

  const acknowledge = (outcome: MediaMuteOutcome): void => {
    if (outcome.kind === "deferred") deps.log?.("[media-mute] original output recovery remains pending", outcome.reason);
  };
  const finish = async (session: MediaMuteSession): Promise<void> => {
    try { acknowledge(await session.restore()); }
    catch (error) { deps.log?.("[media-mute] could not restore original output", error); }
    finally { if (active === session) active = null; }
  };
  const begin = async (mine: number): Promise<void> => {
    try {
      if (recovery) await recovery;
      if (active) await finish(active);
      if (mine !== generation || !armed) return;
      const session = await deps.backend.open();
      if (!session) return;
      active = session;
      if (mine !== generation || !armed) {
        await finish(session);
        return;
      }
      const ready = await session.ready;
      if (!ready || mine !== generation || !armed) {
        await finish(session);
        return;
      }
      const muted = await session.mute();
      if (!muted || mine !== generation || !armed) await finish(session);
    } catch (error) {
      deps.log?.("[media-mute] could not prepare output muting", error);
      if (active) await finish(active);
    }
  };
  const restore = async (): Promise<void> => {
    const mine = ++generation;
    const started = opening;
    const startup = recovery;
    armed = false;
    if (pending !== null) { pending(); pending = null; }
    if (active) await finish(active);
    if (started) await started;
    if (startup) await startup;
    if (mine === generation && active) await finish(active);
  };
  return {
    onPhase(phase: string, enabled: boolean): Promise<void> {
      if (!enabled || phase !== "recording") return restore();
      if (armed) return Promise.resolve();
      armed = true;
      const mine = ++generation;
      pending = schedule(() => {
        pending = null;
        const previous = opening;
        const work = (async () => { if (previous) await previous; await begin(mine); })();
        opening = work;
        void work.finally(() => { if (opening === work) opening = null; });
      }, MUTE_DELAY_MS);
      return Promise.resolve();
    },
    restore,
    recoverStaleMute(): Promise<void> {
      if (recovery) return recovery;
      const work = deps.backend.recover().then(acknowledge).catch(error => {
        deps.log?.("[media-mute] could not recover original output", error);
      });
      recovery = work;
      void work.finally(() => { if (recovery === work) recovery = null; });
      return work;
    },
    get hasPendingWork(): boolean {
      return pending !== null || active !== null || opening !== null || recovery !== null;
    },
  };
}
