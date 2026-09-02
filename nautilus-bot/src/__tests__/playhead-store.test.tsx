import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  createPlayheadStore,
  usePlayhead,
  usePlayheadStore,
  type PlayheadStore,
} from "@/lib/playhead-store";

describe("playhead store", () => {
  it("notifies subscribers only when the position actually changes", () => {
    const store = createPlayheadStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    expect(store.get()).toBeUndefined();
    store.set(1.5);
    expect(store.get()).toBe(1.5);
    expect(notifications).toBe(1);
    // `timeupdate` keeps firing while paused; the same position is not news.
    store.set(1.5);
    expect(notifications).toBe(1);
    store.set(undefined);
    expect(notifications).toBe(2);

    unsubscribe();
    store.set(9);
    expect(notifications).toBe(2);
    expect(store.get()).toBe(9);
  });
});

describe("playhead subscribers", () => {
  it("re-renders the transcript, not the view around it", () => {
    let viewRenders = 0;
    let followerRenders = 0;
    let store: PlayheadStore | null = null;

    function Follower({ playhead }: { playhead: PlayheadStore }) {
      followerRenders += 1;
      const currentTime = usePlayhead(playhead);
      return <span data-testid="playhead">{currentTime ?? "none"}</span>;
    }

    function MeetingView() {
      viewRenders += 1;
      const playhead = usePlayheadStore();
      store = playhead;
      return <Follower playhead={playhead} />;
    }

    render(<MeetingView />);
    expect(viewRenders).toBe(1);
    expect(followerRenders).toBe(1);
    expect(screen.getByTestId("playhead").textContent).toBe("none");

    // Four ticks: what a second of playback costs.
    for (const time of [0.25, 0.5, 0.75, 1]) {
      act(() => {
        store?.set(time);
      });
    }

    expect(screen.getByTestId("playhead").textContent).toBe("1");
    expect(followerRenders).toBe(5);
    // The regression this exists for: the whole meetings view re-rendered on
    // every one of those ticks.
    expect(viewRenders).toBe(1);
  });

  it("keeps the store across the owner's own re-renders", () => {
    const seen = new Set<PlayheadStore>();

    function Owner({ label }: { label: string }) {
      const playhead = usePlayheadStore();
      seen.add(playhead);
      return <span data-testid="label">{label}</span>;
    }

    const { rerender } = render(<Owner label="a" />);
    rerender(<Owner label="b" />);
    expect(screen.getByTestId("label").textContent).toBe("b");
    expect(seen.size).toBe(1);
  });
});
