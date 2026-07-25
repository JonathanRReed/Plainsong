import { useCallback, useEffect, useRef, useState, useMemo, memo } from "react";
import { cn } from "@/lib/utils";
import { formatTimeWithMs } from "@/lib/format-time";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Edit2, Check, ChevronDown, ChevronUp, Trash2, User, X } from "lucide-react";
import type { TranscriptSegment } from "@/types";

/**
 * Where this transcript was set down. A local claim has to be earned: the
 * caller names the provider it actually got back from the backend. Absent the
 * prop we say the provider is unknown rather than inventing an on-device claim.
 */
export type TranscriptProvenance =
  | { source: "local" }
  | { source: "cloud"; provider: string }
  | { source: "unknown" };

/** One highlighted hit inside the rendered transcript, in reading order. */
export interface TranscriptMatch {
  segmentId: string;
  startTime: number;
}

interface TranscriptViewerProps {
  segments: TranscriptSegment[];
  className?: string;
  onSegmentClick?: (segment: TranscriptSegment) => void;
  currentTime?: number;
  speakerNames?: Record<string, string>;
  /** Provenance of the transcript; reported as unknown when omitted. */
  provenance?: TranscriptProvenance;
  /**
   * Search term highlighted in place. Segments are never filtered out — a
   * search with no hits must not read as a transcript that lost its text.
   */
  highlightQuery?: string;
  /** Which highlighted hit is the current one, as an index into the matches. */
  activeMatchIndex?: number;
  /** Reports the hits found for `highlightQuery`, in reading order. */
  onMatchesChange?: (matches: TranscriptMatch[]) => void;
  onRenameSpeaker?: (speakerId: string, newName: string) => Promise<void> | void;
  /**
   * Save an edited speaker turn. Receives every segment id in the turn: the
   * edited text replaces the first segment and the rest must be removed by
   * the caller, otherwise their old text would survive and duplicate.
   */
  onEditSegment?: (segmentIds: string[], newText: string) => Promise<void> | void;
  onDeleteSegments?: (segmentIds: string[]) => Promise<void> | void;
}

interface SpeakerBadgeProps {
  speakerId: string;
  speakerName?: string;
  isEditing?: boolean;
  isActive?: boolean;
  isFirstMention?: boolean;
  onRename?: (newName: string) => void;
}

function defaultSpeakerLabel(speakerId: string) {
  const normalized = speakerId.trim().toLowerCase();
  if (normalized === "me") {
    return "Me";
  }
  if (normalized === "them") {
    return "Them";
  }
  return speakerId;
}

const SpeakerBadge = memo(function SpeakerBadge({ speakerId, speakerName, isEditing, isActive, isFirstMention, onRename }: SpeakerBadgeProps) {
  const [isEditMode, setIsEditMode] = useState(false);
  const [editValue, setEditValue] = useState(speakerName || defaultSpeakerLabel(speakerId));

  useEffect(() => {
    setEditValue(speakerName || defaultSpeakerLabel(speakerId));
  }, [speakerId, speakerName]);

  const handleSave = () => {
    if (onRename && editValue.trim()) {
      onRename(editValue.trim());
    }
    setIsEditMode(false);
  };

  if (isEditMode) {
    return (
      <div className="flex items-center gap-1">
        <Input
          value={editValue}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditValue(e.target.value)}
          className="h-6 w-24 text-xs"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") setIsEditMode(false);
          }}
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label="Save speaker name"
          onClick={handleSave}
        >
          <Check className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 group">
      <div
        className={cn(
          "rubric-muted flex items-center gap-1.5 rounded-md px-2 py-1 transition-smooth",
          isActive
            ? "bg-gold/10 text-gold-text"
            : isFirstMention
              ? "bg-gold/10 text-gold-text"
              : "bg-muted/40 text-muted-foreground"
        )}
      >
        <User className="h-3 w-3" aria-hidden="true" />
        <span>{speakerName || defaultSpeakerLabel(speakerId)}</span>
      </div>
      {isEditing && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
          aria-label="Edit speaker name"
          onClick={() => setIsEditMode(true)}
        >
          <Edit2 className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
});

/** Split `text` into plain runs and case-insensitive hits on `query`. */
function splitOnQuery(
  text: string,
  query: string
): Array<{ text: string; isMatch: boolean }> {
  if (!query) {
    return [{ text, isMatch: false }];
  }

  const parts: Array<{ text: string; isMatch: boolean }> = [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  let cursor = 0;

  for (;;) {
    const found = haystack.indexOf(needle, cursor);
    if (found === -1) {
      break;
    }
    if (found > cursor) {
      parts.push({ text: text.slice(cursor, found), isMatch: false });
    }
    parts.push({ text: text.slice(found, found + needle.length), isMatch: true });
    cursor = found + needle.length;
  }

  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), isMatch: false });
  }
  return parts;
}

export function TranscriptViewer({
  segments,
  className,
  onSegmentClick,
  currentTime,
  speakerNames: externalSpeakerNames,
  provenance,
  highlightQuery,
  activeMatchIndex = 0,
  onMatchesChange,
  onRenameSpeaker,
  onEditSegment,
  onDeleteSegments,
}: TranscriptViewerProps) {
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [isEditingSpeakers, setIsEditingSpeakers] = useState(false);
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [isSavingSegmentEdit, setIsSavingSegmentEdit] = useState(false);
  // Session-scoped ribbon: the last segment the reader played/opened, by id.
  // State only — no persistence backend (honest about what we keep).
  const [lastReadSegmentId, setLastReadSegmentId] = useState<string | null>(null);

  // Provenance is only ever what the caller could actually establish. With no
  // prop we say so; we never fabricate a "Local" claim for an unnamed provider.
  const isLocal = provenance?.source === "local";
  const cloudProvider = provenance?.source === "cloud" ? provenance.provider : null;
  const provenanceLabel = isLocal
    ? "Local transcript"
    : cloudProvider
      ? `Cloud (${cloudProvider})`
      : "Provider unknown";
  const provenanceShortLabel = isLocal
    ? "Local"
    : cloudProvider
      ? `Cloud (${cloudProvider})`
      : "Provider unknown";
  const provenanceTitle = isLocal
    ? "Transcribed on this device."
    : cloudProvider
      ? `Transcribed by ${cloudProvider}, a named cloud provider.`
      : "This meeting did not record which transcription provider produced it.";

  // Info-strip figures, all defensible from the actual transcript data.
  const stats = useMemo(() => {
    const wordCount = segments.reduce(
      (total, segment) => total + segment.text.trim().split(/\s+/).filter(Boolean).length,
      0
    );
    const lastEnd = segments.length > 0 ? segments[segments.length - 1].endTime : 0;
    const firstStart = segments.length > 0 ? segments[0].startTime : 0;
    const spanSeconds = Math.max(0, lastEnd - firstStart);
    const minutes = Math.max(spanSeconds > 0 ? 1 : 0, Math.round(spanSeconds / 60));
    const avgConfidence =
      segments.length > 0
        ? segments.reduce((sum, segment) => sum + segment.confidence, 0) / segments.length
        : 0;
    return { wordCount, minutes, avgConfidence };
  }, [segments]);

  useEffect(() => {
    if (externalSpeakerNames) {
      setSpeakerNames(externalSpeakerNames);
    }
  }, [externalSpeakerNames]);

  const handleRenameSpeaker = async (speakerId: string, newName: string) => {
    setSpeakerNames(prev => ({ ...prev, [speakerId]: newName }));
    if (onRenameSpeaker) {
      await onRenameSpeaker(speakerId, newName);
    }
  };

  const beginEditingGroup = (group: TranscriptSegment[]) => {
    if (!onEditSegment) return;
    setEditingSegmentId(group[0].id);
    setEditingText(group.map((segment) => segment.text).join(" "));
  };

  // Await the save and only close the editor on success, so a failed write
  // never silently discards the user's correction.
  const saveSegmentEdit = async (group: TranscriptSegment[]) => {
    if (!onEditSegment || isSavingSegmentEdit) return;
    setIsSavingSegmentEdit(true);
    try {
      await onEditSegment(group.map((segment) => segment.id), editingText);
      setEditingSegmentId(null);
    } catch (error) {
      // The caller surfaces the failure (toast); keep the editor open so the
      // correction is still on screen.
      console.error("Failed to save transcript segment edit:", error);
    } finally {
      setIsSavingSegmentEdit(false);
    }
  };

  // Group segments by speaker for better readability
  // When no speaker IDs exist, create groups based on pauses (>2s gap = new speaker)
  const groupedSegments = useMemo(() => {
    return segments.reduce((acc, segment, index) => {
      const prevSegment = index > 0 ? segments[index - 1] : null;
      
      const sameSpeaker = prevSegment && 
        prevSegment.speakerId === segment.speakerId && 
        prevSegment.speakerId != null;
      const closeInTime = prevSegment && segment.startTime - prevSegment.endTime < 2;
      
      // Group together if: same speaker with ID, OR no speaker ID but close in time
      if ((sameSpeaker || (!prevSegment?.speakerId && !segment.speakerId && closeInTime)) && prevSegment) {
        acc[acc.length - 1].push(segment);
      } else {
        acc.push([segment]);
      }
      
      return acc;
    }, [] as TranscriptSegment[][]);
  }, [segments]);

  // Track which group indices are the FIRST appearance of each speaker, so the
  // first badge of a voice may be gilded once and later mentions stay neutral.
  const firstSpeakerGroupIndices = useMemo(() => {
    const seen = new Set<string>();
    const firsts = new Set<number>();
    groupedSegments.forEach((group, index) => {
      const key = group[0].speakerId ?? `speaker-${index}`;
      if (!seen.has(key)) {
        seen.add(key);
        firsts.add(index);
      }
    });
    return firsts;
  }, [groupedSegments]);

  // Every hit for the current search term, in reading order. Highlighting is
  // additive: nothing is removed from the transcript, so an empty result set
  // reads as "0 of 0" rather than as a transcript that lost its text.
  const normalizedHighlightQuery = highlightQuery?.trim().toLowerCase() ?? "";
  const matches = useMemo(() => {
    if (!normalizedHighlightQuery) {
      return [] as TranscriptMatch[];
    }
    const found: TranscriptMatch[] = [];
    for (const segment of segments) {
      const haystack = segment.text.toLowerCase();
      let cursor = haystack.indexOf(normalizedHighlightQuery);
      while (cursor !== -1) {
        found.push({ segmentId: segment.id, startTime: segment.startTime });
        cursor = haystack.indexOf(normalizedHighlightQuery, cursor + normalizedHighlightQuery.length);
      }
    }
    return found;
  }, [normalizedHighlightQuery, segments]);

  useEffect(() => {
    onMatchesChange?.(matches);
  }, [matches, onMatchesChange]);

  // Which turn the reading position sits in. Resolved here rather than per
  // group so the scroll effect can depend on it: a deep link cues a time before
  // the transcript has loaded, and the group only exists on a later render.
  const activeGroupIndex = useMemo(() => {
    if (currentTime === undefined) {
      return -1;
    }
    return groupedSegments.findIndex(
      (group) =>
        currentTime >= group[0].startTime &&
        currentTime <= group[group.length - 1].endTime
    );
  }, [currentTime, groupedSegments]);

  // Scroll targets: the current search hit, and the group the reading position
  // sits in. `block: "nearest"` so a target already on screen never jumps.
  const activeMatchRef = useRef<HTMLElement | null>(null);
  const activeGroupRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeMatchRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeMatchIndex, matches]);

  useEffect(() => {
    if (matches.length > 0) {
      return;
    }
    activeGroupRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeGroupIndex, currentTime, matches.length]);

  // Reading position moves turn by turn from the keyboard, so a transcript can
  // be walked without a mouse. Callers use it to jump other surfaces in step.
  const moveReadingPosition = useCallback(
    (direction: 1 | -1) => {
      if (groupedSegments.length === 0) {
        return;
      }
      const currentIndex = groupedSegments.findIndex(
        (group) => group[0].id === lastReadSegmentId
      );
      const nextIndex =
        currentIndex === -1
          ? direction === 1
            ? 0
            : groupedSegments.length - 1
          : Math.min(Math.max(currentIndex + direction, 0), groupedSegments.length - 1);
      const nextSegment = groupedSegments[nextIndex][0];
      setLastReadSegmentId(nextSegment.id);
      onSegmentClick?.(nextSegment);
    },
    [groupedSegments, lastReadSegmentId, onSegmentClick]
  );

  // Running index across groups so each rendered hit knows whether it is the
  // active one. Reset per render pass, walked in the same order as `matches`.
  let renderedMatchCount = 0;

  return (
    <div className={cn("flex h-full min-h-0 flex-col overflow-hidden", className)}>
      {/* Toolbar */}
      <div className="shrink-0 border-b border-border bg-muted/30 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            {/* No heading here. The rail this viewer sits in already names the
                pane "Transcript" with a count under it; repeating the pair read
                as two stacked headers for one pane. This is the readout only. */}
            <div className="flex items-baseline gap-2 font-mono text-xs text-muted-foreground tabular-nums">
              <span className="text-foreground">{segments.length} segments</span>
              {segments.length > 0 && (
                <span>
                  ({formatTimeWithMs(segments[segments.length - 1]?.endTime || 0)} total)
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Trust badge — provenance, honestly named */}
            <span
              className={cn(
                "rubric-muted inline-flex items-center gap-1.5 rounded-md border px-2 py-1",
                isLocal ? "border-gold/30 text-gold-text" : "border-border text-muted-foreground"
              )}
              title={provenanceTitle}
            >
              <span
                className={cn("neume", isLocal ? "neume-lit" : "neume-hollow")}
                aria-hidden="true"
              />
              {provenanceLabel}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsEditingSpeakers(!isEditingSpeakers)}
            >
              {isEditingSpeakers ? "Done" : "Rename Speakers"}
            </Button>
          </div>
        </div>

        {/* Info strip — defensible figures, mono rubric, tabular */}
        {segments.length > 0 && (
          <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 rubric-muted">
            <span className="inline-flex items-baseline gap-1">
              <span className="time-spec text-foreground">{stats.wordCount}</span>
              words
            </span>
            <span className="inline-flex items-baseline gap-1">
              <span className="time-spec text-foreground">~{stats.minutes}</span>
              min
            </span>
            <span className="inline-flex items-baseline gap-1">
              avg conf
              <span className="time-spec text-foreground">{Math.round(stats.avgConfidence * 100)}%</span>
            </span>
            <span className="inline-flex items-baseline gap-1">
              <span
                className={cn("neume", isLocal ? "neume-lit" : "neume-hollow")}
                aria-hidden="true"
              />
              {provenanceShortLabel}
            </span>
          </div>
        )}
      </div>

      {/* Transcript. The scrollbar is always drawn, never hover-revealed:
          testers could not tell a long transcript from a short one, because
          nothing on screen said there was more of it below. */}
      <ScrollArea type="always" className="h-full min-h-0 flex-1">
        <div
          className="p-4 space-y-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          role="group"
          aria-label="Transcript turns"
          tabIndex={0}
          onKeyDown={(event) => {
            if (editingSegmentId) {
              return;
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveReadingPosition(1);
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              moveReadingPosition(-1);
            }
          }}
        >
          {groupedSegments.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <span className="neume neume-hollow" aria-hidden="true" />
              <p className="font-serif text-base text-foreground">No transcript available</p>
              <p className="max-w-xs text-sm text-muted-foreground">
                Transcription will appear here once processing is complete.
              </p>
            </div>
          ) : (
            groupedSegments.map((group, groupIndex) => {
              const firstSegment = group[0];
              const rawSpeakerId = firstSegment.speakerId;
              // Generate a unique ID for this speaker group if none exists
              const speakerId = rawSpeakerId || `speaker-${groupIndex}`;
              const speakerName = speakerNames[speakerId];
              const canRenameSpeaker = true; // Always allow renaming
              const isFirstSpeakerMention = firstSpeakerGroupIndices.has(groupIndex);

              // Check if this group is currently playing
              const isActive = groupIndex === activeGroupIndex;

              // The very first group opens the leaf with a gilded versal.
              const isLeafOpening = groupIndex === 0;
              // Session ribbon: a thin gold left-edge on the last-read group.
              const isLastRead = lastReadSegmentId === firstSegment.id;

              return (
                <div
                  key={groupIndex}
                  ref={isActive ? activeGroupRef : undefined}
                  className={cn(
                    "group relative flex gap-3 rounded-lg p-3 transition-colors",
                    // Faint gold-ambient hairline separating speaker turns.
                    groupIndex > 0 && "border-t border-gold-ambient/15",
                    isActive ? "bg-gold/5" : "hover:bg-muted/50",
                    onSegmentClick && "cursor-pointer"
                  )}
                  onClick={() => {
                    setLastReadSegmentId(firstSegment.id);
                    onSegmentClick?.(firstSegment);
                  }}
                >
                  {/* Reading-position neume — the turn in focus, settling in */}
                  {isActive && (
                    <span
                      className="neume neume-lit settle-in absolute left-0 top-1/2 -translate-y-1/2"
                      aria-hidden="true"
                    />
                  )}
                  {/* Session ribbon bookmark — last-read position */}
                  {isLastRead && !isActive && (
                    <span
                      className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-gold-ambient"
                      aria-hidden="true"
                    />
                  )}
                  {/* Timestamp & Speaker */}
                  <div className="flex flex-col gap-1 min-w-[100px]">
                    <span className="rubric-muted time-spec">
                      {formatTimeWithMs(firstSegment.startTime)}
                    </span>
                    <SpeakerBadge
                      speakerId={speakerId}
                      speakerName={speakerName}
                      isEditing={isEditingSpeakers && canRenameSpeaker}
                      isActive={isActive}
                      isFirstMention={isFirstSpeakerMention}
                      onRename={canRenameSpeaker ? (name) => handleRenameSpeaker(speakerId, name) : undefined}
                    />
                  </div>

                  {/* Text */}
                  <div className="flex-1">
                    {editingSegmentId === firstSegment.id ? (
                      <div className="flex flex-col gap-1">
                        <textarea
                          autoFocus
                          value={editingText}
                          onChange={(e) => setEditingText(e.target.value)}
                          rows={3}
                          className="w-full text-sm bg-background border border-gold rounded-md px-2 py-1 resize-none focus:outline-none focus:ring-1 focus:ring-gold"
                          onKeyDown={(e) => {
                            if (e.key === "Escape") { setEditingSegmentId(null); }
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                              void saveSegmentEdit(group);
                            }
                          }}
                        />
                        <div className="flex gap-1 justify-end">
                          <Button size="sm" variant="ghost" className="h-6 text-xs" disabled={isSavingSegmentEdit} onClick={() => setEditingSegmentId(null)}>Cancel</Button>
                          <Button size="sm" className="h-6 text-xs" disabled={isSavingSegmentEdit} onClick={() => { void saveSegmentEdit(group); }}><Check className="h-3 w-3 mr-1" />{isSavingSegmentEdit ? "Saving…" : "Save"}</Button>
                        </div>
                      </div>
                    ) : (
                      <div className="group/text relative">
                        {/* A single click sets the reading ribbon and leaves the
                            words selectable and copyable. Editing is the hover
                            Edit button or a double-click — never a stray click,
                            which used to swallow the whole paragraph mid-quote. */}
                        <p
                          className="manuscript max-w-prose select-text text-[0.95rem] leading-[1.85]"
                          onDoubleClick={(e) => { if (onEditSegment) { e.stopPropagation(); beginEditingGroup(group); } }}
                        >
                          {group.map((segment, i) => {
                            const isPlaying =
                              currentTime !== undefined &&
                              currentTime >= segment.startTime &&
                              currentTime <= segment.endTime;
                            const underline = isPlaying
                              ? "underline decoration-dotted decoration-gold underline-offset-2"
                              : "";
                            const trailingSpace = i < group.length - 1 ? " " : "";
                            // With no search running the words stay one text node,
                            // exactly as they were; only a live query splits them
                            // so hits can be marked without removing anything.
                            const body = normalizedHighlightQuery
                              ? splitOnQuery(segment.text, normalizedHighlightQuery).map(
                                  (part, partIndex) => {
                                    if (!part.isMatch) {
                                      return <span key={partIndex}>{part.text}</span>;
                                    }
                                    const isActiveMatch = renderedMatchCount === activeMatchIndex;
                                    renderedMatchCount += 1;
                                    return (
                                      <mark
                                        key={partIndex}
                                        ref={isActiveMatch ? activeMatchRef : undefined}
                                        className={cn(
                                          "rounded-sm text-foreground",
                                          isActiveMatch
                                            ? "bg-gold/25"
                                            : "bg-gold-ambient/20"
                                        )}
                                      >
                                        {part.text}
                                      </mark>
                                    );
                                  }
                                )
                              : segment.text;
                            // Open the whole leaf with a gilded versal. The entire
                            // first word stays a single text node — the real letter
                            // is never pulled out of the DOM (screen readers read
                            // the word whole) — and the gilded drop-cap is rendered
                            // by gilding the first letter via ::first-letter.
                            if (isLeafOpening && i === 0) {
                              return (
                                <span
                                  key={segment.id}
                                  className={cn(
                                    "transition-colors",
                                    // Gilded versal drop-cap on the rendered first
                                    // letter; the letter itself stays in the text
                                    // node so the word reads whole to AT.
                                    "[&::first-letter]:float-left [&::first-letter]:pr-[0.07em] [&::first-letter]:font-serif [&::first-letter]:text-[2.6em] [&::first-letter]:font-medium [&::first-letter]:leading-[0.82]",
                                    "[&::first-letter]:[background:var(--gold-leaf)] [&::first-letter]:[-webkit-background-clip:text] [&::first-letter]:[background-clip:text] [&::first-letter]:[-webkit-text-fill-color:transparent] [&::first-letter]:[text-shadow:0_1px_0_color-mix(in_oklab,var(--bole)_70%,transparent)]",
                                    underline
                                  )}
                                >
                                  {body}{trailingSpace}
                                </span>
                              );
                            }
                            return (
                              <span key={segment.id} className={cn("transition-colors", underline)}>
                                {body}{trailingSpace}
                              </span>
                            );
                          })}
                        </p>
                        {onEditSegment && (
                          <div className="absolute top-0 right-0 flex items-center gap-1 opacity-0 group-hover/text:opacity-100 focus-within:opacity-100 transition-opacity">
                            <button
                              type="button"
                              aria-label="Edit segment"
                              className="p-0.5 rounded hover:bg-muted focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={(e) => {
                                e.stopPropagation();
                                beginEditingGroup(group);
                              }}
                            >
                              <Edit2 className="h-3 w-3 text-muted-foreground" />
                            </button>
                            {onDeleteSegments && (
                              <button
                                type="button"
                                aria-label="Delete segment lines"
                                className="p-0.5 rounded hover:bg-destructive/10 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void onDeleteSegments(group.map((segment) => segment.id));
                                }}
                              >
                                <Trash2 className="h-3 w-3 text-destructive" />
                              </button>
                            )}
                          </div>
                        )}
                        {firstSegment.confidence < 0.8 && (
                          <p className="rubric-muted mt-1 inline-flex items-center gap-1.5">
                            <span className="neume neume-hollow" aria-hidden="true" />
                            Low confidence
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

interface TranscriptSearchProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** How many hits the transcript found for the current query. */
  matchCount: number;
  /** Zero-based index of the hit currently in view. */
  activeMatchIndex: number;
  onStepMatch: (direction: 1 | -1) => void;
  className?: string;
}

/**
 * Find-in-transcript. It steps through hits; it never filters the transcript,
 * so a query with no hits reads as "0 of 0" instead of an emptied record.
 */
export function TranscriptSearch({
  query,
  onQueryChange,
  matchCount,
  activeMatchIndex,
  onStepMatch,
  className,
}: TranscriptSearchProps) {
  const hasQuery = query.trim().length > 0;

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Input
        placeholder="Find in transcript..."
        aria-label="Find in transcript"
        value={query}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onStepMatch(e.shiftKey ? -1 : 1);
          }
        }}
        className="flex-1"
      />
      {hasQuery && (
        <>
          <span
            className="rubric-muted time-spec whitespace-nowrap"
            role="status"
            aria-live="polite"
          >
            {matchCount === 0 ? "0 of 0" : `${activeMatchIndex + 1} of ${matchCount}`}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="Previous match"
            disabled={matchCount === 0}
            onClick={() => onStepMatch(-1)}
          >
            <ChevronUp className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="Next match"
            disabled={matchCount === 0}
            onClick={() => onStepMatch(1)}
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="Clear transcript search"
            onClick={() => onQueryChange("")}
          >
            <X className="h-4 w-4" />
          </Button>
        </>
      )}
    </div>
  );
}
