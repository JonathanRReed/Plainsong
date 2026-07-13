import { useEffect, useState, useMemo, memo } from "react";
import { cn } from "@/lib/utils";
import { formatTimeWithMs } from "@/lib/format-time";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Edit2, Check, Trash2, User } from "lucide-react";
import type { TranscriptSegment } from "@/types";

/**
 * Where this transcript was set down. Local-first by default; cloud must be
 * named explicitly by the caller (honesty contract — never claim local when a
 * named provider did the work). Absent the prop, we assume on-device.
 */
type TranscriptProvenance =
  | { source: "local" }
  | { source: "cloud"; provider: string };

interface TranscriptViewerProps {
  segments: TranscriptSegment[];
  className?: string;
  onSegmentClick?: (segment: TranscriptSegment) => void;
  currentTime?: number;
  speakerNames?: Record<string, string>;
  /** Provenance of the transcript; defaults to on-device when omitted. */
  provenance?: TranscriptProvenance;
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

export function TranscriptViewer({
  segments,
  className,
  onSegmentClick,
  currentTime,
  speakerNames: externalSpeakerNames,
  provenance,
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

  // Provenance defaults to on-device. Cloud is only ever shown when the caller
  // names a provider — we never fabricate a "Local" claim.
  const isLocal = provenance?.source !== "cloud";
  const cloudProvider = provenance?.source === "cloud" ? provenance.provider : null;

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

  return (
    <div className={cn("flex h-full min-h-0 flex-col overflow-hidden", className)}>
      {/* Toolbar */}
      <div className="shrink-0 border-b border-border bg-muted/30 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <p className="rubric">TRANSCRIPT</p>
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
              title={
                isLocal
                  ? "Transcribed on this device."
                  : `Transcribed by ${cloudProvider}, a named cloud provider.`
              }
            >
              <span
                className={cn("neume", isLocal ? "neume-lit" : "neume-hollow")}
                aria-hidden="true"
              />
              {isLocal ? "Local transcript" : `Cloud (${cloudProvider})`}
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
              {isLocal ? "Local" : `Cloud (${cloudProvider})`}
            </span>
          </div>
        )}
      </div>

      {/* Transcript */}
      <ScrollArea className="h-full min-h-0 flex-1">
        <div className="p-4 space-y-4">
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
              const isActive = currentTime !== undefined &&
                currentTime >= firstSegment.startTime &&
                currentTime <= group[group.length - 1].endTime;

              // The very first group opens the leaf with a gilded versal.
              const isLeafOpening = groupIndex === 0;
              // Session ribbon: a thin gold left-edge on the last-read group.
              const isLastRead = lastReadSegmentId === firstSegment.id;

              return (
                <div
                  key={groupIndex}
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
                  {/* Playhead neume — the moment being spoken, settling in */}
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
                        <p
                          className="manuscript max-w-prose text-[0.95rem] leading-[1.85]"
                          onClick={(e) => { if (onEditSegment) { e.stopPropagation(); beginEditingGroup(group); } }}
                        >
                          {group.map((segment, i) => {
                            const isPlaying =
                              currentTime !== undefined &&
                              currentTime >= segment.startTime &&
                              currentTime <= segment.endTime;
                            const underline = isPlaying
                              ? "underline decoration-dotted decoration-gold underline-offset-2"
                              : "";
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
                                  {segment.text}{i < group.length - 1 ? " " : ""}
                                </span>
                              );
                            }
                            return (
                              <span key={segment.id} className={cn("transition-colors", underline)}>
                                {segment.text}{i < group.length - 1 ? " " : ""}
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
  onSearch: (query: string) => void;
  className?: string;
}

export function TranscriptSearch({ onSearch, className }: TranscriptSearchProps) {
  const [query, setQuery] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(query);
  };

  return (
    <form onSubmit={handleSubmit} className={cn("flex gap-2", className)}>
      <Input
        placeholder="Search transcript..."
        value={query}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
        className="flex-1"
      />
      <Button type="submit" size="sm">
        Search
      </Button>
    </form>
  );
}
