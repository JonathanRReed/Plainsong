type Diagnostics = Readonly<Record<string, string | boolean | readonly string[] | undefined>>;

type Dependencies = {
  platform: string;
  getStatus: () => string;
  ask: () => Promise<boolean>;
  log?: (event: string, fields: Diagnostics) => void;
};

type Request = {
  allowed: boolean;
  permission: string;
  mediaTypes?: readonly string[];
  isCurrent: () => boolean;
  callback: (allowed: boolean) => void;
};

type Check = {
  allowed: boolean;
  permission: string;
  mediaType?: string;
};

export function checkMicrophonePermission(
  deps: Pick<Dependencies, "platform" | "getStatus" | "log">,
  check: Check,
): boolean {
  if (!check.allowed) return false;
  if (deps.platform !== "darwin" || check.permission !== "media" || check.mediaType !== "audio") {
    return true;
  }
  try {
    const status = deps.getStatus();
    deps.log?.("check-os-status", { status });
    // Electron asks only after a denied check. Keep cold access on the native request path.
    return status === "granted";
  } catch {
    deps.log?.("check-os-status", { error: true });
    return false;
  }
}

export function createMicrophonePermissionHandler(deps: Dependencies) {
  let pending: Promise<boolean> | undefined;
  return (request: Request): void => {
    let completed = false;
    const finish = (allowed: boolean): void => {
      if (completed) return;
      completed = true;
      request.callback(allowed);
    };
    deps.log?.("handler-entry", {
      permission: request.permission,
      mediaTypes: request.mediaTypes,
      trusted: request.allowed,
    });
    if (!request.allowed) { finish(false); return; }
    if (deps.platform !== "darwin" || request.permission !== "media" ||
        request.mediaTypes?.length !== 1 || request.mediaTypes[0] !== "audio") {
      finish(true);
      return;
    }
    try {
      const status = deps.getStatus();
      deps.log?.("os-status-before", { status });
      if (status !== "not-determined") { finish(status === "granted"); return; }
      if (!pending) {
        pending = deps.ask().then((granted) => {
          deps.log?.("native-settled", { granted });
          return granted;
        }, () => {
          deps.log?.("native-settled", { rejected: true });
          return false;
        }).finally(() => {
          pending = undefined;
          try {
            deps.log?.("os-status-after", { status: deps.getStatus() });
          } catch {
            deps.log?.("os-status-after", { error: true });
          }
        });
      }
      void pending.then((granted) => {
        let allowed = false;
        try { allowed = granted && request.isCurrent(); } catch { /* Deny a disposed requester. */ }
        finish(allowed);
      });
    } catch {
      deps.log?.("native-error", { error: true });
      finish(false);
    }
  };
}


export function createMicrophoneAccessRequest(handle: ReturnType<typeof createMicrophonePermissionHandler>) {
  return async (request: Pick<Request, "allowed" | "isCurrent">): Promise<boolean> => {
    try {
      if (!request.allowed || !request.isCurrent()) return false;
      const granted = await new Promise<boolean>((callback) => {
        handle({ ...request, permission: "media", mediaTypes: ["audio"], callback });
      });
      return granted && request.isCurrent();
    } catch {
      return false;
    }
  };
}
