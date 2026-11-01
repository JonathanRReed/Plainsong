// Evaluated in the owned renderer. The API and workspace label can exist
// before React mounts, or behind the first-run wizard.
export const PACKAGED_QA_UI_STATE = `(() => {
  const modal = document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]');
  if (modal) return document.querySelector('.app-shell[inert]') ? 'wizard' : null;
  const shell = document.querySelector('.app-shell:not([inert])');
  return shell?.querySelector('button[aria-current="page"]') &&
    shell.querySelector('main#main-content .view-enter') ? 'workspace' : null;
})()`;

export async function waitForPackagedQaUi({
  evaluate,
  deadline,
  workspaceOnly = false,
}: {
  evaluate: (expression: string) => Promise<unknown>;
  deadline: number;
  workspaceOnly?: boolean;
}): Promise<"wizard" | "workspace"> {
  while (Date.now() < deadline) {
    const state = await evaluate(PACKAGED_QA_UI_STATE).catch(() => null);
    if (state === "workspace" || (state === "wizard" && !workspaceOnly)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(workspaceOnly
    ? "The packaged workspace remained unmounted or covered by a modal."
    : "The packaged renderer did not mount its workspace or setup wizard.");
}
