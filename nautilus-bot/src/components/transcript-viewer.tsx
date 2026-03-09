import { useEffect, useState, useMemo, memo } from "react";
import { cn } from "@/lib/utils";
import { formatTimeWithMs } from "@/lib/format-time";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Edit2, Check, Trash2, User } from "lucide-react";
import type { TranscriptSegment } from "@/types";

interface TranscriptViewerProps {
  segments: TranscriptSegment[];
  className?: string;
  onSegmentClick?: (segment: TranscriptSegment) => void;
  currentTime?: number;
  speakerNames?: Record<string, string>;
  onRenameSpeaker?: (speakerId: string, newName: string) => Promise<void> | void;
  onEditSegment?: (segmentId: string, newText: string) => Promise<void> | void;
  onDeleteSegments?: (segmentIds: string[]) => Promise<void> | void;
}

interface SpeakerBadgeProps {
  speakerId: string;
  speakerName?: string;
  isEditing?: boolean;
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

const SpeakerBadge = memo(function SpeakerBadge({ speakerId, speakerName, isEditing, onRename }: SpeakerBadgeProps) {
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
          onClick={handleSave}
        >
          <Check className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 group">
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-trusted/10 text-trusted text-xs font-medium">
        <User className="h-3 w-3" />
        <span>{speakerName || defaultSpeakerLabel(speakerId)}</span>
      </div>
      {isEditing && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
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
  onRenameSpeaker,
  onEditSegment,
  onDeleteSegments,
}: TranscriptViewerProps) {
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [isEditingSpeakers, setIsEditingSpeakers] = useState(false);
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

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

  return (
    <div className={cn("flex h-full min-h-0 flex-col overflow-hidden", className)}>
      {/* Toolbar */}
      <div className="shrink-0 border-b bg-muted/50 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">
              {segments.length} segments
            </span>
            {segments.length > 0 && (
              <span className="text-xs text-muted-foreground">
                ({formatTimeWithMs(segments[segments.length - 1]?.endTime || 0)} total)
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsEditingSpeakers(!isEditingSpeakers)}
          >
            {isEditingSpeakers ? "Done" : "Rename Speakers"}
          </Button>
        </div>
      </div>

      {/* Transcript */}
      <ScrollArea className="h-full min-h-0 flex-1">
        <div className="p-4 space-y-4">
          {groupedSegments.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No transcript available. Transcription will appear here once processing is complete.
            </div>
          ) : (
            groupedSegments.map((group, groupIndex) => {
              const firstSegment = group[0];
              const rawSpeakerId = firstSegment.speakerId;
              // Generate a unique ID for this speaker group if none exists
              const speakerId = rawSpeakerId || `speaker-${groupIndex}`;
              const speakerName = speakerNames[speakerId];
              const canRenameSpeaker = true; // Always allow renaming
              
              // Check if this group is currently playing
              const isActive = currentTime !== undefined && 
                currentTime >= firstSegment.startTime && 
                currentTime <= group[group.length - 1].endTime;

              return (
                <div
                  key={groupIndex}
                  className={cn(
                    "group flex gap-3 p-3 rounded-lg transition-colors",
                    isActive ? "bg-trusted/10 border border-trusted/20" : "hover:bg-muted/50",
                    onSegmentClick && "cursor-pointer"
                  )}
                  onClick={() => onSegmentClick?.(firstSegment)}
                >
                  {/* Timestamp & Speaker */}
                  <div className="flex flex-col gap-1 min-w-[100px]">
                    <span className="text-xs text-muted-foreground font-mono">
                      {formatTimeWithMs(firstSegment.startTime)}
                    </span>
                    <SpeakerBadge
                      speakerId={speakerId}
                      speakerName={speakerName}
                      isEditing={isEditingSpeakers && canRenameSpeaker}
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
                          className="w-full text-sm bg-background border border-active rounded-md px-2 py-1 resize-none focus:outline-none focus:ring-1 focus:ring-active"
                          onKeyDown={(e) => {
                            if (e.key === "Escape") { setEditingSegmentId(null); }
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                              void onEditSegment?.(firstSegment.id, editingText);
                              setEditingSegmentId(null);
                            }
                          }}
                        />
                        <div className="flex gap-1 justify-end">
                          <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setEditingSegmentId(null)}>Cancel</Button>
                          <Button size="sm" className="h-6 text-xs" onClick={() => { void onEditSegment?.(firstSegment.id, editingText); setEditingSegmentId(null); }}><Check className="h-3 w-3 mr-1" />Save</Button>
                        </div>
                      </div>
                    ) : (
                      <div className="group/text relative">
                        <p
                          className="text-sm leading-relaxed"
                          onClick={(e) => { if (onEditSegment) { e.stopPropagation(); setEditingSegmentId(firstSegment.id); setEditingText(group.map(s => s.text).join(" ")); } }}
                        >
                          {group.map((segment, i) => (
                            <span
                              key={segment.id}
                              className={cn(
                                "transition-colors",
                                currentTime !== undefined &&
                                currentTime >= segment.startTime &&
                                currentTime <= segment.endTime &&
                                "bg-yellow-200/50 dark:bg-yellow-900/30 rounded px-0.5"
                              )}
                            >
                              {segment.text}{i < group.length - 1 ? " " : ""}
                            </span>
                          ))}
                        </p>
                        {onEditSegment && (
                          <div className="absolute top-0 right-0 flex items-center gap-1 opacity-0 group-hover/text:opacity-100 transition-opacity">
                            <button
                              type="button"
                              className="p-0.5 rounded hover:bg-muted"
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingSegmentId(firstSegment.id);
                                setEditingText(group.map(s => s.text).join(" "));
                              }}
                            >
                              <Edit2 className="h-3 w-3 text-muted-foreground" />
                            </button>
                            {onDeleteSegments && (
                              <button
                                type="button"
                                className="p-0.5 rounded hover:bg-destructive/10"
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
                          <p className="text-xs text-muted-foreground mt-1">
                            Confidence: {Math.round(firstSegment.confidence * 100)}%
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
