import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseTranscriptTime, transcriptNavigationEnd, transcriptSections, transcriptSegmentAt, transcriptTimeLabel } from "@/lib/meeting-transcript-navigation";
import type { TranscriptSegment } from "@/types";

export function TranscriptNavigator({ segments, speakerNames, onNavigate }: {
  segments: TranscriptSegment[];
  speakerNames: Record<string, string>;
  onNavigate: (time: number, segmentId: string) => void;
}) {
  const [speaker, setSpeaker] = useState("");
  const [time, setTime] = useState("");
  const [error, setError] = useState("");
  const speakers = useMemo(() => [...new Set(segments.map(segment => segment.speakerId).filter((id): id is string => Boolean(id)))], [segments]);
  if (speaker && !speakers.includes(speaker)) setSpeaker("");
  const sections = useMemo(() => transcriptSections(segments, speaker), [segments, speaker]);
  const end = transcriptNavigationEnd(segments);
  return <details className="mb-3 shrink-0 rounded-md border p-3">
    <summary className="cursor-pointer text-sm font-medium">Browse transcript</summary>
    <p className="mt-2 text-xs text-muted-foreground">Five-minute sections from the transcript. Select a section to read it and cue audio when playback is available.</p>
    <div className="mt-3 flex flex-wrap items-end gap-3">
      <label className="text-xs">Speaker
        <select aria-label="Browse transcript by speaker" className="ml-2 rounded-md border bg-background p-2" value={speaker} onChange={event => setSpeaker(event.target.value)}>
          <option value="">All speakers</option>
          {speakers.map(id => <option key={id} value={id}>{speakerNames[id] || id}</option>)}
        </select>
      </label>
      <form className="flex items-end gap-2" onSubmit={event => {
        event.preventDefault();
        const parsed = parseTranscriptTime(time);
        if (parsed === null || parsed > end) { setError(`Enter m:ss or h:mm:ss up to ${transcriptTimeLabel(end)}.`); return; }
        const segment = transcriptSegmentAt(segments, parsed);
        if (segment) { setError(""); onNavigate(parsed, segment.id); }
      }}>
        <label className="text-xs">Jump to time<Input aria-label="Jump to transcript time" value={time} placeholder="12:30" className="mt-1 w-28" onChange={event => { setTime(event.target.value); setError(""); }} /></label>
        <Button type="submit" size="sm" variant="outline">Go</Button>
      </form>
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    <nav aria-label="Transcript sections" className="mt-3 max-h-48 overflow-y-auto">
      {sections.map(section => <button key={section.interval} type="button" className="flex w-full gap-3 rounded-md px-2 py-2 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2" onClick={() => onNavigate(section.first.startTime, section.first.id)}>
        <span className="shrink-0 text-xs tabular-nums">{transcriptTimeLabel(section.first.startTime)}</span>
        <span className="min-w-0"><span className="block truncate text-sm">{section.first.text || "Transcript segment"}</span><span className="block text-xs text-muted-foreground">{section.count} {section.count === 1 ? "segment" : "segments"}{section.speakers.length > 0 ? ` · ${section.speakers.map(id => speakerNames[id] || id).join(", ")}` : ""}</span></span>
      </button>)}
      {sections.length === 0 && <p className="text-xs text-muted-foreground">No transcript sections for this speaker.</p>}
    </nav>
  </details>;
}
