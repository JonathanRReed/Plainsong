import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Edit2, Check, User } from "lucide-react";
import type { TranscriptSegment } from "@/types";

interface TranscriptViewerProps {
  segments: TranscriptSegment[];
  className?: string;
  onSegmentClick?: (segment: TranscriptSegment) => void;
  currentTime?: number;
  speakerNames?: Record<string, string>;
  onRenameSpeaker?: (speakerId: string, newName: string) => Promise<void> | void;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${mins}:${secs.toString().padStart(2, "0")}.${ms.toString().padStart(2, "0")}`;
}

interface SpeakerBadgeProps {
  speakerId: string;
  speakerName?: string;
  isEditing?: boolean;
  onRename?: (newName: string) => void;
}

function SpeakerBadge({ speakerId, speakerName, isEditing, onRename }: SpeakerBadgeProps) {
  const [isEditMode, setIsEditMode] = useState(false);
  const [editValue, setEditValue] = useState(speakerName || speakerId);

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
        <span>{speakerName || speakerId}</span>
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
}

export function TranscriptViewer({
  segments,
  className,
  onSegmentClick,
  currentTime,
  speakerNames: externalSpeakerNames,
  onRenameSpeaker,
}: TranscriptViewerProps) {
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [isEditingSpeakers, setIsEditingSpeakers] = useState(false);

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
  const groupedSegments = segments.reduce((acc, segment, index) => {
    const prevSegment = index > 0 ? segments[index - 1] : null;
    
    if (prevSegment && prevSegment.speakerId === segment.speakerId && 
        segment.startTime - prevSegment.endTime < 2) {
      // Merge with previous group
      acc[acc.length - 1].push(segment);
    } else {
      // Start new group
      acc.push([segment]);
    }
    
    return acc;
  }, [] as TranscriptSegment[][]);

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Toolbar */}
      <div className="flex items-center justify-between p-3 border-b bg-muted/50">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">
            {segments.length} segments
          </span>
          {segments.length > 0 && (
            <span className="text-xs text-muted-foreground">
              ({formatTime(segments[segments.length - 1]?.endTime || 0)} total)
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

      {/* Transcript */}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {groupedSegments.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No transcript available. Transcription will appear here once processing is complete.
            </div>
          ) : (
            groupedSegments.map((group, groupIndex) => {
              const firstSegment = group[0];
              const speakerId = firstSegment.speakerId || "Unknown";
              const speakerName = speakerNames[speakerId];
              const canRenameSpeaker = speakerId !== "Unknown";
              
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
                      {formatTime(firstSegment.startTime)}
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
                    <p className="text-sm leading-relaxed">
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
                    {firstSegment.confidence < 0.8 && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Confidence: {Math.round(firstSegment.confidence * 100)}%
                      </p>
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
