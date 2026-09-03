import { Fragment, useCallback, useEffect, useId, useRef, useState, useMemo, memo } from "react";
import { cn } from "@/lib/utils";
import { formatTimeWithMs } from "@/lib/format-time";
import { rangeIndexAtTime, SEEK_STEP_SECONDS } from "@/lib/playback";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Edit2, Check, ChevronDown, ChevronUp, Trash2, User, X } from "lucide-react";
import type { PauseSpan, TranscriptSegment } from "@/types";
import { placePauseMarkers, type PauseMarker } from "@/lib/pause-markers";

/**
 * Where this transcript was set down. A local claim has to be earned: the
 * caller names the provider it actually got back from the backend. Absent the
 * prop we say the provider is unknown rather than inventing an on-device claim.
 */
export type TranscriptProvenance =
  | { source: "local" }
  | { source: "apple_on_device" }
  | { source: "cloud"; provider: string }
  | { source: "unknown" };

/**
 * What Plainsong has matched, or is offering to match, for one speaker cluster.
 *
 * Deliberately carries no vector: the voice signature stays in the sidecar.
 */
export interface SpeakerVoiceState {
  /**
   * `"auto"` while Plainsong applied a remembered name without being asked —
   * the header keeps saying so until a human confirms it. `"confirmed"` once
   * one has. `null` when no remembered voice is attached.
   */
  matchState: "auto" | "confirmed" | null;
  /** The offer to make, or null when there is nothing honest to suggest. */
  suggestion: { profileId: string; displayName: string; percent: number } | null;
}

/** One highlighted hit inside the rendered transcript, in reading order. */
export interface TranscriptMatch {
  segmentId: string;
  startTime: number;
}

export interface TranscriptViewerProps {
  segments: TranscriptSegment[];
  /**
   * Pauses taken while recording. The audio skips them, so the timeline
   * marks where each one sat: "[Paused 2 min 10 s]" before the first turn
   * that starts at or after the pause.
   */
  pauseSpans?: PauseSpan[] | null;
  className?: string;
  onSegmentClick?: (segment: TranscriptSegment) => void;
  currentTime?: number;
  /** Play or pause the meeting audio; bound to Space over the transcript. */
  onTogglePlayback?: () => void;
  /** Skip the meeting audio; bound to ← → over the transcript. */
  onSeekBy?: (deltaSeconds: number) => void;
  speakerNames?: Record<string, string>;
  /** Offered while renaming a speaker. See `SpeakerBadgeProps`. */
  speakerNameSuggestions?: readonly string[];
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
  /**
   * Rename one speaker. `remember` is true when the reader also asked
   * Plainsong to remember the voice under that name; it is only ever true
   * while `rememberVoicesEnabled` is on.
   */
  onRenameSpeaker?: (
    speakerId: string,
    newName: string,
    remember?: boolean
  ) => Promise<void> | void;
  /**
   * What the voiceprint store has to say about each speaker cluster, keyed by
   * speaker id. Omitted entirely when "Remember voices" is off, which is what
   * makes the whole affordance disappear rather than sit there disabled.
   */
  speakerVoices?: Record<string, SpeakerVoiceState>;
  /**
   * Whether "Remember voices" is on. Controls whether the rename editor offers
   * to remember, and whether that offer starts checked.
   */
  rememberVoicesEnabled?: boolean;
  /** Accept a suggested voice. Applies the name and adds this turn as a sample. */
  onConfirmSpeakerVoice?: (speakerId: string, profileId: string) => Promise<void> | void;
  /** "Not them": stop suggesting this voice for this speaker. */
  onRejectSpeakerVoice?: (speakerId: string, profileId: string) => Promise<void> | void;
  /**
   * Names the rename editor suggests, in the order the sidecar ranked them:
   * this meeting's known attendees first, then the voices already remembered.
   * Only a hint — the field stays free text.
   */
  speakerNameOptions?: string[];
  /**
   * Save an edited speaker turn. Receives every segment id in the turn so the
   * caller can replace the first and remove the rest as one atomic mutation.
   */
  onEditSegment?: (segmentIds: string[], newText: string) => Promise<void> | void;
  /**
   * Remove a whole speaker turn. Always asked about first — the viewer will not
   * call this until the reader has confirmed the named turn in the dialog.
   */
  onDeleteSegments?: (segmentIds: string[]) => Promise<void> | void;
  /**
   * One sentence the caller can prove about getting the words back (e.g. the
   * audio is still on disk and the meeting can be re-transcribed). Shown in the
   * delete confirmation. Omitted when the caller cannot promise a way back.
   */
  deleteRecoveryNote?: string;
}

/** Word count for a turn, counted the same way the info strip counts them. */
function countWords(segments: TranscriptSegment[]): number {
  return segments.reduce(
    (total, segment) => total + segment.text.trim().split(/\s+/).filter(Boolean).length,
    0
  );
}

interface SpeakerBadgeProps {
  speakerId: string | null;
  speakerName?: string;
  isEditing?: boolean;
  isActive?: boolean;
  isFirstMention?: boolean;
  onRename?: (newName: string, remember: boolean) => Promise<void> | void;
  /** Whether the editor may offer to remember the voice, and start checked. */
  canRememberVoice?: boolean;
  /** True while a remembered name was applied without being asked. */
  isAutoNamed?: boolean;
  /** Names to suggest while typing, already in the order to offer them. */
  nameOptions?: string[];
  /**
   * Names to offer while renaming: the meeting's attendees, when it started
   * from a calendar event. A suggestion list, not a constraint -- diarization
   * finds voices, not invitations, and the reader can always type something
   * that was never on the invite. Offered after `nameOptions`, which is
   * already ranked.
   */
  nameSuggestions?: readonly string[];
}

/** How long the reader's own scroll holds off the playhead's auto-scroll. */
const USER_SCROLL_HOLD_MS = 4000;

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("button, a, input, textarea, select, [contenteditable=true]") !== null
  );
}

function normalizePersistedSpeakerId(speakerId: string | null | undefined): string | null {
  const normalized = speakerId?.trim();
  return normalized ? normalized : null;
}

function defaultSpeakerLabel(speakerId: string | null | undefined) {
  const normalized = normalizePersistedSpeakerId(speakerId);
  if (!normalized) {
    return "Unattributed";
  }
  if (normalized.toLowerCase() === "me") {
    return "Me";
  }
  if (normalized.toLowerCase() === "them") {
    return "Them";
  }
  return normalized;
}

const SpeakerBadge = memo(function SpeakerBadge({ speakerId, speakerName, isEditing, isActive, isFirstMention, onRename, canRememberVoice, isAutoNamed, nameOptions, nameSuggestions }: SpeakerBadgeProps) {
  const [isEditMode, setIsEditMode] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editValue, setEditValue] = useState(speakerName || defaultSpeakerLabel(speakerId));
  const nameListId = useId();
  // Checked by default only when voiceprints are on; turning the feature off
  // has to leave the rename flow exactly as it was before it existed.
  const [rememberVoice, setRememberVoice] = useState(Boolean(canRememberVoice));

  useEffect(() => {
    setEditValue(speakerName || defaultSpeakerLabel(speakerId));
  }, [speakerId, speakerName]);

  useEffect(() => {
    setRememberVoice(Boolean(canRememberVoice));
  }, [canRememberVoice]);

  const handleSave = async () => {
    const trimmedName = editValue.trim();
    if (!onRename || !trimmedName || isSaving) {
      return;
    }

    setIsSaving(true);
    try {
      await onRename(trimmedName, Boolean(canRememberVoice) && rememberVoice);
      setIsEditMode(false);
    } catch (error) {
      // The caller owns the visible error treatment. Keep the editor and the
      // attempted value open so a failed persistence request never looks saved.
      console.error("Failed to rename transcript speaker:", error);
    } finally {
      setIsSaving(false);
    }
  };

  // One list, two sources: the ranked options the sidecar produced for this
  // meeting, then any calendar attendee it did not already name. Order is the
  // offer order, and a name never appears twice -- de-duplicated
  // case-insensitively, the same rule `confirm_name_options` applies in the
  // sidecar, so "Devon" from one source and "devon" from the other are one
  // entry rather than two lines that look like a bug.
  const offeredNames = useMemo(() => {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const name of [...(nameOptions ?? []), ...(nameSuggestions ?? [])]) {
      const trimmed = name.trim();
      // An identity key, not display text: pin the locale so a Turkish
      // system does not fold "I" to a dotless i and let two different
      // names collide (see src/lib/string-registry.ts for the same rule).
      const key = trimmed.toLocaleLowerCase("en-US");
      if (!trimmed || seen.has(key)) continue;
      seen.add(key);
      merged.push(trimmed);
    }
    return merged;
  }, [nameOptions, nameSuggestions]);

  if (isEditMode) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1">
          <Input
            value={editValue}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditValue(e.target.value)}
            className="h-6 w-24 text-xs"
            aria-label="Speaker name"
            list={offeredNames.length > 0 ? nameListId : undefined}
            autoFocus
            disabled={isSaving}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSave();
              if (e.key === "Escape" && !isSaving) setIsEditMode(false);
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label="Save speaker name"
            disabled={isSaving || !editValue.trim()}
            onClick={() => void handleSave()}
          >
            <Check className="h-3 w-3" />
          </Button>
        </div>
        {offeredNames.length > 0 && (
          <datalist id={nameListId} data-testid="speaker-name-options">
            {offeredNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        )}
        {canRememberVoice && (
          <label className="flex items-start gap-2 text-sm text-muted-foreground">
            <Switch
              size="sm"
              checked={rememberVoice}
              disabled={isSaving}
              onCheckedChange={setRememberVoice}
              aria-label={`Remember this voice as ${editValue.trim() || "this speaker"}`}
            />
            <span className="leading-tight">
              Remember this voice as{" "}
              <span className="text-foreground">{editValue.trim() || "this speaker"}</span>
            </span>
          </label>
        )}
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
      {isAutoNamed && (
        <span
          className="rubric-muted whitespace-nowrap"
          title="Plainsong matched this voice on its own. Confirm it to keep the name."
        >
          auto
        </span>
      )}
      {isEditing && onRename && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
          aria-label="Edit speaker name"
          onClick={() => setIsEditMode(true)}
        >
          <Edit2 className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
});


interface SpeakerVoiceSuggestionProps {
  speakerId: string;
  suggestion: NonNullable<SpeakerVoiceState["suggestion"]>;
  isAuto: boolean;
  onConfirm: (speakerId: string, profileId: string) => Promise<void> | void;
  onReject: (speakerId: string, profileId: string) => Promise<void> | void;
}

/**
 * The offer to name a speaker from a voice this Mac already knows.
 *
 * Shown once per speaker, on their first turn, and only while the match is
 * unresolved. The percentage is the measured cosine similarity, not a
 * confidence the app invented; "auto" means the name is already on the
 * transcript and is waiting to be agreed with rather than chosen.
 */
function SpeakerVoiceSuggestion({
  speakerId,
  suggestion,
  isAuto,
  onConfirm,
  onReject,
}: SpeakerVoiceSuggestionProps) {
  const [isBusy, setIsBusy] = useState(false);

  const run = async (action: (speakerId: string, profileId: string) => Promise<void> | void) => {
    if (isBusy) {
      return;
    }
    setIsBusy(true);
    try {
      await action(speakerId, suggestion.profileId);
    } catch (error) {
      // The caller owns the visible failure; leaving the chip up is the honest
      // outcome, because nothing changed.
      console.error("Failed to resolve the speaker voice suggestion:", error);
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-gold/30 bg-gold/5 px-2 py-1.5">
      <span className="neume neume-lit" aria-hidden="true" />
      <p className="text-sm text-foreground">
        {isAuto ? "Named from a remembered voice: " : "Looks like "}
        <span className="text-gold-text">{suggestion.displayName}</span>, {suggestion.percent}%
      </p>
      <div className="ml-auto flex items-center gap-1">
        <Button
          size="sm"
          variant="secondary"
          className="h-7"
          disabled={isBusy}
          onClick={() => void run(onConfirm)}
        >
          Confirm
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          disabled={isBusy}
          onClick={() => void run(onReject)}
        >
          Not them
        </Button>
      </div>
    </div>
  );
}

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

/**
 * Memoized: the meetings view around it re-renders for reasons that have
 * nothing to do with the transcript, and re-rendering hundreds of speaker
 * turns to redraw a toolbar is work nobody asked for. The playhead reaches it
 * through `PlayheadTranscriptViewer`, so following the audio does not depend
 * on the parent re-rendering either.
 */
export const TranscriptViewer = memo(function TranscriptViewer({
  segments,
  pauseSpans,
  className,
  onSegmentClick,
  currentTime,
  onTogglePlayback,
  onSeekBy,
  speakerNames: externalSpeakerNames,
  speakerNameSuggestions,
  provenance,
  highlightQuery,
  activeMatchIndex = 0,
  onMatchesChange,
  onRenameSpeaker,
  speakerVoices,
  rememberVoicesEnabled,
  onConfirmSpeakerVoice,
  onRejectSpeakerVoice,
  speakerNameOptions,
  onEditSegment,
  onDeleteSegments,
  deleteRecoveryNote,
}: TranscriptViewerProps) {
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [isEditingSpeakers, setIsEditingSpeakers] = useState(false);
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [isSavingSegmentEdit, setIsSavingSegmentEdit] = useState(false);
  // A delete request parks here until the reader confirms it. The unit removed
  // is a whole speaker turn, which on a single-source recording can be most of
  // the transcript — so the turn is named and counted before anything is cut,
  // and nothing is written until the reader says so.
  const [pendingDelete, setPendingDelete] = useState<{
    segments: TranscriptSegment[];
    speakerLabel: string;
  } | null>(null);
  const [isDeletingSegments, setIsDeletingSegments] = useState(false);
  // Session-scoped ribbon: the last segment the reader played/opened, by id.
  // State only — no persistence backend (honest about what we keep).
  const [lastReadSegmentId, setLastReadSegmentId] = useState<string | null>(null);

  // Provenance is only ever what the caller could actually establish. With no
  // prop we say so; we never fabricate a "Local" claim for an unnamed provider.
  const isAppleOnDevice = provenance?.source === "apple_on_device";
  const isLocal = provenance?.source === "local" || isAppleOnDevice;
  const cloudProvider = provenance?.source === "cloud" ? provenance.provider : null;
  const provenanceLabel = isAppleOnDevice
    ? "Apple Speech · on-device"
    : isLocal
      ? "Local transcript"
      : cloudProvider
        ? `Cloud (${cloudProvider})`
        : "Provider unknown";
  const provenanceShortLabel = isAppleOnDevice
    ? "Apple on-device"
    : isLocal
      ? "Local"
      : cloudProvider
        ? `Cloud (${cloudProvider})`
        : "Provider unknown";
  const provenanceTitle = isAppleOnDevice
    ? "Transcribed by Apple Speech on this device with server fallback disabled."
    : isLocal
      ? "Transcribed on this device."
      : cloudProvider
        ? `Transcribed by ${cloudProvider}, a named cloud provider.`
        : "This meeting did not record which transcription provider produced it.";

  // Info-strip figures, all defensible from the actual transcript data.
  const stats = useMemo(() => {
    const wordCount = countWords(segments);
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

  const canRenameSpeakers = useMemo(
    () =>
      Boolean(
        onRenameSpeaker &&
          segments.some((segment) => normalizePersistedSpeakerId(segment.speakerId))
      ),
    [onRenameSpeaker, segments]
  );

  useEffect(() => {
    if (!canRenameSpeakers) {
      setIsEditingSpeakers(false);
    }
  }, [canRenameSpeakers]);

  const handleRenameSpeaker = async (
    speakerId: string,
    newName: string,
    remember?: boolean
  ) => {
    if (!onRenameSpeaker) {
      return;
    }

    await onRenameSpeaker(speakerId, newName, remember);
    setSpeakerNames((prev) => ({ ...prev, [speakerId]: newName }));
  };

  const beginEditingGroup = (group: TranscriptSegment[]) => {
    if (!onEditSegment) return;
    setEditingSegmentId(group[0].id);
    setEditingText(group.map((segment) => segment.text).join(" "));
  };

  // Await the save and only close the editor on success, so a failed write
  // never silently discards the user's correction.
  const saveSegmentEdit = async (group: TranscriptSegment[]) => {
    if (!onEditSegment || isSavingSegmentEdit || !editingText.trim()) return;
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

  // Only fires after the reader has confirmed the named turn. If the caller
  // rejects, the dialog is left open with the turn still quoted in it rather
  // than closing on a write that did not happen.
  const confirmDeleteSegments = async () => {
    if (!onDeleteSegments || !pendingDelete || isDeletingSegments) return;
    setIsDeletingSegments(true);
    try {
      await onDeleteSegments(pendingDelete.segments.map((segment) => segment.id));
      setPendingDelete(null);
    } catch (error) {
      console.error("Failed to delete transcript segments:", error);
    } finally {
      setIsDeletingSegments(false);
    }
  };

  // What the reader is about to lose, named in full: how many lines, how many
  // words, whose turn, and where it starts.
  const pendingDeleteSummary = useMemo(() => {
    if (!pendingDelete) return null;
    const lineCount = pendingDelete.segments.length;
    const wordCount = countWords(pendingDelete.segments);
    return {
      lineCount,
      wordCount,
      sentence:
        `Removes ${lineCount} transcript ${lineCount === 1 ? "line" : "lines"} ` +
        `(${wordCount} ${wordCount === 1 ? "word" : "words"}) from one speaker turn by ` +
        `${pendingDelete.speakerLabel}, starting at ${formatTimeWithMs(pendingDelete.segments[0].startTime)}. ` +
        `The words are cut from the record and this cannot be undone here.`,
      preview: pendingDelete.segments.map((segment) => segment.text).join(" "),
    };
  }, [pendingDelete]);

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

  // Where the pause markers go, keyed by the turn they precede. A pause past
  // the last turn is keyed by `groupedSegments.length` and rendered after it.
  const pauseMarkersByGroup = useMemo(() => {
    const byGroup = new Map<number, PauseMarker[]>();
    for (const marker of placePauseMarkers(
      groupedSegments.map((group) => group[0].startTime),
      pauseSpans,
    )) {
      const list = byGroup.get(marker.beforeGroupIndex) ?? [];
      list.push(marker);
      byGroup.set(marker.beforeGroupIndex, list);
    }
    return byGroup;
  }, [groupedSegments, pauseSpans]);

  const renderPauseMarkers = (beforeGroupIndex: number) => {
    const markers = pauseMarkersByGroup.get(beforeGroupIndex);
    if (!markers || markers.length === 0) return null;
    return markers.map((marker) => (
      // The apparatus, not the manuscript: mono, muted, a hollow neume for a
      // gap that was chosen. It is a fact about the record, so it reads as a
      // status line, never as a speaker turn.
      <p
        key={`pause-${marker.atSeconds}-${marker.durationMs}`}
        role="status"
        className="rubric-muted my-1 inline-flex items-center gap-2 px-3"
      >
        <span className="neume neume-hollow" aria-hidden="true" />
        [{marker.label}]
      </p>
    ));
  };

  // Track which group indices are the FIRST appearance of each speaker, so the
  // first badge of a voice may be gilded once and later mentions stay neutral.
  const firstSpeakerGroupIndices = useMemo(() => {
    const seen = new Set<string>();
    const firsts = new Set<number>();
    groupedSegments.forEach((group, index) => {
      const key = normalizePersistedSpeakerId(group[0].speakerId) ?? "unattributed";
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
  const groupRanges = useMemo(
    () =>
      groupedSegments.map((group) => ({
        start: group[0].startTime,
        end: group[group.length - 1].endTime,
      })),
    [groupedSegments]
  );
  const activeGroupIndex = useMemo(() => {
    if (currentTime === undefined) {
      return -1;
    }
    // Binary search: the playhead reports a few times a second, and a long
    // meeting has hundreds of turns.
    return rangeIndexAtTime(groupRanges, currentTime);
  }, [currentTime, groupRanges]);

  // Scroll targets: the current search hit, and the group the reading position
  // sits in. `block: "nearest"` so a target already on screen never jumps.
  const activeMatchRef = useRef<HTMLElement | null>(null);
  const activeGroupRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeMatchRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeMatchIndex, matches]);

  // The reader's own scrolling wins over the playhead for a few seconds: a
  // transcript that snaps back to the current line every time the reader
  // wheels up to check something earlier is unreadable while audio plays.
  const lastUserScrollAtRef = useRef(0);
  const markUserScroll = useCallback(() => {
    lastUserScrollAtRef.current = Date.now();
  }, []);

  useEffect(() => {
    if (matches.length > 0) {
      return;
    }
    if (Date.now() - lastUserScrollAtRef.current < USER_SCROLL_HOLD_MS) {
      return;
    }
    // Instant, not smooth: the same move under reduced motion, and a turn that
    // is already on screen does not move at all (`nearest`).
    activeGroupRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeGroupIndex, matches.length]);

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
            {canRenameSpeakers && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsEditingSpeakers(!isEditingSpeakers)}
              >
                {isEditingSpeakers ? "Done" : "Rename Speakers"}
              </Button>
            )}
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
          onWheel={markUserScroll}
          onTouchMove={markUserScroll}
          onKeyDown={(event) => {
            if (editingSegmentId) {
              return;
            }
            if (
              event.key === "PageUp" ||
              event.key === "PageDown" ||
              event.key === "Home" ||
              event.key === "End"
            ) {
              markUserScroll();
              return;
            }
            // Reading and playback keys act only when focus is on the
            // transcript itself, not on a button, badge, or field inside it:
            // ↑/↓ move a listbox or a menu that has focus, and stealing them
            // there breaks the control the reader is actually using.
            if (isInteractiveTarget(event.target)) {
              return;
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveReadingPosition(1);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              moveReadingPosition(-1);
              return;
            }
            if ((event.key === " " || event.key === "Spacebar") && onTogglePlayback) {
              event.preventDefault();
              onTogglePlayback();
            } else if (event.key === "ArrowLeft" && onSeekBy) {
              event.preventDefault();
              onSeekBy(-SEEK_STEP_SECONDS);
            } else if (event.key === "ArrowRight" && onSeekBy) {
              event.preventDefault();
              onSeekBy(SEEK_STEP_SECONDS);
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
              const speakerId = normalizePersistedSpeakerId(firstSegment.speakerId);
              const speakerName = speakerId ? speakerNames[speakerId] : undefined;
              const speakerLabel = speakerName || defaultSpeakerLabel(speakerId);
              const timestampLabel = formatTimeWithMs(firstSegment.startTime);
              const editHintId = `transcript-edit-hint-${groupIndex}`;
              const canRenameSpeaker = Boolean(speakerId && onRenameSpeaker);
              const renameSpeakerForGroup =
                speakerId && canRenameSpeaker
                  ? (name: string, remember: boolean) =>
                      handleRenameSpeaker(speakerId, name, remember)
                  : undefined;
              const voiceState = speakerId ? speakerVoices?.[speakerId] : undefined;
              // Remembering a voice needs a signature for this cluster, and
              // only clusters the sidecar has one for appear in `speakerVoices`.
              // Without that check the switch showed up on a meeting diarized
              // before the feature existed, defaulted to on, and the save
              // failed at the RPC — so an ordinary rename became impossible.
              const canRememberVoiceForGroup = Boolean(
                rememberVoicesEnabled && speakerId && voiceState
              );
              const isFirstSpeakerMention = firstSpeakerGroupIndices.has(groupIndex);

              // Check if this group is currently playing
              const isActive = groupIndex === activeGroupIndex;

              // The very first group opens the leaf with a gilded versal.
              const isLeafOpening = groupIndex === 0;
              // Session ribbon: a thin gold left-edge on the last-read group.
              const isLastRead = lastReadSegmentId === firstSegment.id;

              return (
                <Fragment key={groupIndex}>
                {renderPauseMarkers(groupIndex)}
                <div
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
                      {timestampLabel}
                    </span>
                    <SpeakerBadge
                      speakerId={speakerId}
                      speakerName={speakerName}
                      isEditing={isEditingSpeakers && canRenameSpeaker}
                      isActive={isActive}
                      isFirstMention={isFirstSpeakerMention}
                      onRename={renameSpeakerForGroup}
                      canRememberVoice={canRememberVoiceForGroup}
                      isAutoNamed={voiceState?.matchState === "auto"}
                      nameOptions={speakerNameOptions}
                      nameSuggestions={speakerNameSuggestions}
                    />
                  </div>

                  {/* Text */}
                  <div className="flex-1">
                    {/* The voice offer sits once per speaker, on their first
                        turn, so a long meeting is not a wall of chips. */}
                    {isFirstSpeakerMention &&
                      speakerId &&
                      voiceState?.suggestion &&
                      onConfirmSpeakerVoice &&
                      onRejectSpeakerVoice && (
                        <SpeakerVoiceSuggestion
                          speakerId={speakerId}
                          suggestion={voiceState.suggestion}
                          isAuto={voiceState.matchState === "auto"}
                          onConfirm={onConfirmSpeakerVoice}
                          onReject={onRejectSpeakerVoice}
                        />
                      )}
                    {editingSegmentId === firstSegment.id ? (
                      <div className="flex flex-col gap-1">
                        <textarea
                          autoFocus
                          value={editingText}
                          onChange={(e) => setEditingText(e.target.value)}
                          rows={3}
                          aria-label={`Edit transcript for ${speakerLabel} at ${timestampLabel}`}
                          aria-describedby={editHintId}
                          className="w-full text-sm bg-background border border-gold rounded-md px-2 py-1 resize-none focus:outline-none focus:ring-1 focus:ring-gold"
                          onKeyDown={(e) => {
                            if (e.key === "Escape") { setEditingSegmentId(null); }
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                              e.preventDefault();
                              void saveSegmentEdit(group);
                            }
                          }}
                        />
                        <div className="flex items-center justify-between gap-2">
                          <p id={editHintId} className="text-xs text-muted-foreground">
                            Cmd/Ctrl+Enter to save
                          </p>
                          <div className="flex gap-1">
                            <Button size="sm" variant="ghost" className="h-6 text-xs" disabled={isSavingSegmentEdit} onClick={() => setEditingSegmentId(null)}>Cancel</Button>
                            <Button size="sm" className="h-6 text-xs" disabled={isSavingSegmentEdit || !editingText.trim()} onClick={() => { void saveSegmentEdit(group); }}><Check className="h-3 w-3 mr-1" />{isSavingSegmentEdit ? "Saving…" : "Save"}</Button>
                          </div>
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
                        {/* Both controls are 24×24 (WCAG 2.5.8) and sit a full
                            12px apart: they used to be ~16px targets 4px from
                            each other, and the copy above the transcript sends
                            people to this exact corner for Edit. */}
                        {onEditSegment && (
                          <div className="absolute top-0 right-0 flex items-center gap-3 opacity-0 group-hover/text:opacity-100 focus-within:opacity-100 transition-opacity">
                            <button
                              type="button"
                              aria-label="Edit segment"
                              className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-muted focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={(e) => {
                                e.stopPropagation();
                                beginEditingGroup(group);
                              }}
                            >
                              <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
                            </button>
                            {onDeleteSegments && (
                              <button
                                type="button"
                                aria-label="Delete this speaker turn"
                                className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-destructive/10 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPendingDelete({
                                    segments: group,
                                    speakerLabel:
                                      speakerName || defaultSpeakerLabel(speakerId),
                                  });
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5 text-destructive" />
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
                </Fragment>
              );
            })
          )}
          {groupedSegments.length > 0 ? renderPauseMarkers(groupedSegments.length) : null}
        </div>
      </ScrollArea>

      {/* Deleting a turn is permanent and the record keeps no snapshot, so the
          question is asked once, with the turn named and quoted back. */}
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !isDeletingSegments) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cut this speaker turn from the transcript?</DialogTitle>
            <DialogDescription>
              {pendingDeleteSummary?.sentence}
              {deleteRecoveryNote ? ` ${deleteRecoveryNote}` : ""}
            </DialogDescription>
          </DialogHeader>
          {pendingDeleteSummary && (
            <p className="manuscript max-h-40 overflow-y-auto rounded-md border border-border bg-muted/30 p-3 text-sm leading-relaxed">
              {pendingDeleteSummary.preview}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={isDeletingSegments}
              onClick={() => setPendingDelete(null)}
            >
              Keep this turn
            </Button>
            <Button
              variant="destructive"
              disabled={isDeletingSegments}
              onClick={() => {
                void confirmDeleteSegments();
              }}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              {isDeletingSegments
                ? "Removing…"
                : `Delete ${pendingDeleteSummary?.lineCount ?? 0} ${
                    pendingDeleteSummary?.lineCount === 1 ? "line" : "lines"
                  }`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
});

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
