import { prepareMainRendererQuit } from "./renderer-quit-guard";

type RendererCloseWindow = {
  isDestroyed: () => boolean;
  hide: () => void;
  show: () => void;
  focus: () => void;
  close: () => void;
};

type RendererCloseEvent = {
  preventDefault: () => void;
};

type RendererCloseOptions = {
  minimizeToTray: boolean;
  isQuitting: boolean;
};

/** Flush renderer-owned drafts before allowing a destructive window close. */
export function createRendererCloseGuard(
  win: RendererCloseWindow,
  execute: (script: string) => Promise<unknown>,
) {
  let closeCheckPending = false;
  let approvedClose = false;

  return (event: RendererCloseEvent, options: RendererCloseOptions): void => {
    if (options.isQuitting) return;

    if (options.minimizeToTray) {
      event.preventDefault();
      approvedClose = false;
      win.hide();
      return;
    }

    if (approvedClose) {
      approvedClose = false;
      return;
    }

    event.preventDefault();
    if (closeCheckPending || win.isDestroyed()) return;
    closeCheckPending = true;

    void prepareMainRendererQuit(execute).then((allowed) => {
      closeCheckPending = false;
      if (win.isDestroyed()) return;
      if (!allowed) {
        win.show();
        win.focus();
        return;
      }

      approvedClose = true;
      win.close();
    });
  };
}
