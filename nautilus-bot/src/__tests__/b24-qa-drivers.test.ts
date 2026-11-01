import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = readFileSync(path.join(process.cwd(), "scripts/qa/candidate-b24-tools/meeting-editor.js"), "utf8")
  .replace("MARKER", JSON.stringify("B24 marker"));
const editMeeting = () => window.eval(script) as Promise<{label: string; value: string}>;

afterEach(() => {
  document.body.innerHTML = "";
  Reflect.deleteProperty(window, "__plainsongCanSuspend");
});

it("does not mistake the inert workspace behind setup for readiness", () => {
  const ready = readFileSync(path.join(process.cwd(), "scripts/qa/candidate-b24-tools/workspace-ready.js"), "utf8");
  Reflect.set(window, "__plainsongCanSuspend", () => true);
  document.body.innerHTML = '<div class="app-shell" inert><main id="main-content"><button aria-current="page">Home</button></main></div><div role="dialog"></div>';
  expect(window.eval(ready)).toBe(false);
  document.querySelector('[role="dialog"]')?.remove();
  expect(window.eval(ready)).toBe(false);
  document.querySelector('.app-shell')?.removeAttribute('inert');
  expect(window.eval(ready)).toBe(true);
  Reflect.set(window, "__plainsongCanSuspend", () => false);
  expect(window.eval(ready)).toBe(false);
});

describe("b24 meeting guard driver", () => {
  it("edits a renamed playbook section without touching unrelated textareas", async () => {
    document.body.innerHTML = `<textarea aria-label="Unrelated">Leave this alone</textarea>
      <div role="group" aria-label="Meeting notes"><textarea aria-label="Decisions notes">Keep the original</textarea></div>`;
    const changed: string[] = [];
    document.querySelectorAll("textarea").forEach(e => e.addEventListener("input", () => changed.push(e.value)));
    const result = await editMeeting();
    expect(result.label).toBe("Decisions notes");
    expect(result.value).toBe("Keep the original\nB24 marker");
    expect(changed).toEqual(["Keep the original\nB24 marker"]);
    expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Unrelated"]')?.value).toBe("Leave this alone");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Decisions notes");
  });

  it("opens the Summary editor when the meeting has no notes sections", async () => {
    document.body.innerHTML = '<button aria-label="Edit Summary">Edit</button>';
    document.querySelector("button")?.addEventListener("click", () => {
      const editor = document.createElement("textarea");
      editor.setAttribute("aria-label", "Summary");
      editor.value = "Existing summary";
      document.body.append(editor);
    });
    expect(await editMeeting()).toMatchObject({label: "Summary", value: "Existing summary\nB24 marker"});
  });
});
