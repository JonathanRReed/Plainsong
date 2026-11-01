import { afterEach, describe, expect, it, vi } from "vitest";
import { PACKAGED_QA_UI_STATE, waitForPackagedQaUi } from "../../scripts/lib/packaged-qa-ui";

const readState = () => new Function("document", `return ${PACKAGED_QA_UI_STATE}`)(document);
const workspace = '<div class="app-shell"><button aria-current="page">Dictation</button><main id="main-content" aria-label="Dictation workspace"><div class="view-enter">Capture</div></main></div>';

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("packaged QA launch readiness", () => {
  it("does not count the API or workspace label as a mounted view", () => {
    document.body.innerHTML = '<main id="main-content" aria-label="Dictation workspace"></main>';
    expect(readState()).toBeNull();
    document.body.innerHTML = workspace.replace('<div class="view-enter">Capture</div>', 'Loading workspace...');
    expect(readState()).toBeNull();
  });

  it("distinguishes setup from the workspace underneath it", () => {
    document.body.innerHTML = workspace.replace('class="app-shell"', 'class="app-shell" inert') +
      '<div role="dialog" aria-modal="true">Speech model</div>';
    expect(readState()).toBe("wizard");
  });

  it("rejects an unrelated modal over a mounted workspace", () => {
    document.body.innerHTML = workspace + '<div role="alertdialog">Confirm</div>';
    expect(readState()).toBeNull();
  });

  it("waits for setup to leave before confirming the workspace", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = workspace.replace('class="app-shell"', 'class="app-shell" inert') +
      '<div role="dialog" aria-modal="true">Speech model</div>';
    const evaluate = vi.fn(async () => readState());
    const ready = waitForPackagedQaUi({ evaluate, deadline: Date.now() + 1000, workspaceOnly: true });
    await vi.advanceTimersByTimeAsync(200);
    document.body.innerHTML = workspace;
    await vi.advanceTimersByTimeAsync(100);
    await expect(ready).resolves.toBe("workspace");
  });

  it("fails when a modal never clears", async () => {
    vi.useFakeTimers();
    const ready = waitForPackagedQaUi({ evaluate: async () => "wizard", deadline: Date.now() + 200, workspaceOnly: true });
    const failed = expect(ready).rejects.toThrow("covered by a modal");
    await vi.advanceTimersByTimeAsync(200);
    await failed;
  });
});
