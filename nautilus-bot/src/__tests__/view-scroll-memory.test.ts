import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readViewScroll, restoreViewScroll } from "@/lib/view-scroll-memory";

/** jsdom has no layout, so each element says how tall it is. */
function sized<T extends HTMLElement>(element: T, clientHeight: number, scrollHeight = clientHeight): T {
  Object.defineProperty(element, "clientHeight", { configurable: true, value: clientHeight });
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(element, "scrollTop", { configurable: true, writable: true, value: 0 });
  return element;
}

function scroller(clientHeight: number, scrollHeight: number): HTMLDivElement {
  const element = document.createElement("div");
  element.setAttribute("data-radix-scroll-area-viewport", "");
  return sized(element, clientHeight, scrollHeight);
}

/** A Meetings-like view: a full-height list, a full-height transcript, and a small nested list. */
function meetingsView() {
  const main = sized(document.createElement("main"), 800);
  const list = scroller(800, 4000);
  const transcript = scroller(800, 9000);
  const chips = scroller(120, 600);
  transcript.append(chips);
  main.append(list, transcript);
  document.body.append(main);
  return { main, list, transcript, chips };
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("readViewScroll", () => {
  it("records which main column scrolled", () => {
    const { main, transcript } = meetingsView();
    transcript.scrollTop = 1200;
    expect(readViewScroll(main, transcript)).toEqual({ index: 1, top: 1200 });
  });

  it("ignores nested lists and the workspace itself", () => {
    const { main, chips } = meetingsView();
    expect(readViewScroll(main, chips)).toBeNull();
    expect(readViewScroll(main, main)).toBeNull();
    expect(readViewScroll(main, null)).toBeNull();
  });
});

describe("restoreViewScroll", () => {
  it("puts the offset back on the column it came from, not the first tall one", () => {
    const { main, list, transcript } = meetingsView();
    restoreViewScroll(main, { index: 1, top: 1200 });
    expect(transcript.scrollTop).toBe(1200);
    expect(list.scrollTop).toBe(0);
  });

  it("leaves the view alone when that column never appears", async () => {
    const main = sized(document.createElement("main"), 800);
    const only = scroller(800, 4000);
    main.append(only);
    document.body.append(main);

    restoreViewScroll(main, { index: 1, top: 1200 });
    await new Promise((resolve) => window.setTimeout(resolve, 100));

    expect(only.scrollTop).toBe(0);
  });

  it("waits for a column that mounts after the view paints", async () => {
    const main = sized(document.createElement("main"), 800);
    const list = scroller(800, 4000);
    main.append(list);
    document.body.append(main);

    restoreViewScroll(main, { index: 1, top: 1200 });
    const transcript = scroller(800, 9000);
    main.append(transcript);
    await new Promise((resolve) => window.setTimeout(resolve, 20));

    expect(transcript.scrollTop).toBe(1200);
    expect(list.scrollTop).toBe(0);
  });
});
