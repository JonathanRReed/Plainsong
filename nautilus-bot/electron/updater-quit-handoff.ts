export function createUpdaterQuitHandoff() {
  let pending: { resolve: () => void; reject: (error: unknown) => void } | null = null;

  return {
    requestQuit(quit: () => void): Promise<void> {
      if (pending) return Promise.reject(new Error("Update quit is already pending"));
      return new Promise<void>((resolve, reject) => {
        pending = { resolve, reject };
        try {
          quit();
        } catch (error) {
          pending = null;
          reject(error);
        }
      });
    },
    cancelled(error?: unknown): void {
      const request = pending;
      pending = null;
      request?.reject(error ?? new Error("Quit was canceled because open drafts could not be saved."));
    },
    complete(): void {
      const request = pending;
      pending = null;
      request?.resolve();
    },
    hasPending(): boolean {
      return pending !== null;
    },
  };
}
