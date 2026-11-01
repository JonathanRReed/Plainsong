import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionItemList } from "@/components/views/meetings/action-item-list";
import { editMeetingAction, mergeMeetingActionFields } from "@/lib/backend/meeting-actions";
import { invoke } from "@/lib/electron";
import type { Recording } from "@/types";

vi.mock("@/lib/electron", () => ({ invoke: vi.fn() }));

describe("meeting task editor wire", () => {
  it("sends the expected list and adopts canonical completion after a row edit", async () => {
    const original = "Send deck (Owner: Jane · Due: after approval)";
    const replacement = "Send deck (Owner: Sam · Due: after approval)";
    vi.mocked(invoke).mockResolvedValue({ recording: { id: "a", actionItems: [replacement] }, completedTasks: [replacement] });
    function Host() {
      const [items, setItems] = useState([original]);
      const [done, setDone] = useState(new Set([original]));
      return <ActionItemList sourceKey="a" items={items} completedTasks={done} onCompletionChange={() => {}}
        onEdit={async (old, next) => {
          const result = await editMeetingAction("a", items, items.indexOf(old), next);
          setItems(result.recording.actionItems ?? []);
          setDone(new Set(result.completedTasks));
        }} />;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "Edit task: Send deck" }));
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));
    await waitFor(() => expect(screen.getByText("Owner: Sam")).toBeInTheDocument());
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(invoke).toHaveBeenCalledWith("edit_meeting_action", {
      recordingId: "a", expectedItems: [original], index: 0, replacement,
    });
  });
});


const recordingFixture = (): Recording => ({
  id: "a", title: "Original title", projectId: "inbox", duration: 30,
  createdAt: "2026-10-12", updatedAt: "old", sourceType: "meeting", audioPath: "fixture.wav",
  status: "completed", summary: "Original summary", meetingNotes: "Original notes", meetingTemplateId: "original",
  actionItems: ["Send deck"],
});

describe("task acknowledgement ownership", () => {
  it("keeps newer meeting metadata when a delayed edit acknowledges task fields", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise<unknown>((done) => { resolve = done; });
    vi.mocked(invoke).mockReturnValueOnce(pending);
    const original = recordingFixture();
    function Host() {
      const [recording, setRecording] = useState<Recording | null>(original);
      return <>
        <button onClick={() => setRecording((current) => current && { ...current,
          title: "New title", summary: "New summary", meetingNotes: "New notes", meetingTemplateId: "new",
          updatedAt: "new timestamp", notesUpdatedAt: "new notes timestamp",
        })}>Save newer metadata</button>
        <output data-testid="record">{JSON.stringify(recording)}</output>
        <ActionItemList sourceKey="a" items={recording?.actionItems ?? []}
          onEdit={async (old, next) => {
            const result = await editMeetingAction("a", recording?.actionItems ?? [], 0, next);
            expect(old).toBe("Send deck");
            setRecording((current) => mergeMeetingActionFields(current, result.recording));
          }} />
      </>;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "Edit task: Send deck" }));
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Send revised deck" } });
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));
    fireEvent.click(screen.getByRole("button", { name: "Save newer metadata" }));
    await act(async () => {
      resolve({ recording: { ...original, actionItems: ["Send revised deck"], actionItemsProvenance: null }, completedTasks: [] });
      await pending;
    });
    const saved = JSON.parse(screen.getByTestId("record").textContent ?? "{}");
    expect(saved).toMatchObject({ title: "New title", summary: "New summary", meetingNotes: "New notes",
      meetingTemplateId: "new", updatedAt: "new timestamp", notesUpdatedAt: "new notes timestamp",
      actionItems: ["Send revised deck"], actionItemsProvenance: null });
  });

  it("uses the same task-only merge for conflict refresh and rejects another meeting", () => {
    const current: Recording = { ...recordingFixture(), title: "Newer title", summaryProvenance: {
      version: 1, contentHash: "newer", actualProvider: "fixture", actualModel: "fixture",
      promptSource: "fixture", completedAt: "2026-10-12", citations: [], grounded: true,
    } };
    const latest = { ...recordingFixture(), title: "Stale title", actionItems: ["External task"], actionItemsProvenance: null };
    const refreshed = mergeMeetingActionFields(current, latest);
    expect(refreshed).toEqual({ ...current, actionItems: ["External task"], actionItemsProvenance: null });
    expect(refreshed?.summaryProvenance).toBe(current.summaryProvenance);
    expect(mergeMeetingActionFields(current, { ...latest, id: "other" })).toBe(current);
    expect(mergeMeetingActionFields(null, latest)).toBeNull();
  });
});
