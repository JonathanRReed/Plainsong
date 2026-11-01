type MainWindowRequest = "main-view-requested" | "meeting-call-capture-requested";

/** Retain the latest requested destination while a new renderer mounts. */
export function createMainWindowRequests(send: (event: MainWindowRequest, payload: unknown) => void) {
  let ready = false;
  let pending: { event: MainWindowRequest; payload: unknown } | undefined;
  return {
    request(event: MainWindowRequest, payload: unknown) {
      if (ready) send(event, payload);
      else pending = { event, payload };
    },
    ready() {
      ready = true;
      const request = pending;
      pending = undefined;
      if (request) send(request.event, request.payload);
    },
    reset() { ready = false; },
  };
}
