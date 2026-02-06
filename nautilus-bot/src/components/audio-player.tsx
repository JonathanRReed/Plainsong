import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Repeat,
} from "lucide-react";

interface AudioPlayerProps {
  src: string;
  onTimeUpdate?: (currentTime: number) => void;
  onSeek?: (time: number) => void;
  className?: string;
  showWaveform?: boolean;
  waveformData?: number[];
}

export function AudioPlayer({
  src,
  onTimeUpdate,
  onSeek,
  className,
  showWaveform = false,
  waveformData = [],
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const isPlayingRef = useRef(isPlaying);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isLooping, setIsLooping] = useState(false);

  // Keep ref in sync with state
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // Format time as MM:SS
  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  // Handle play/pause
  const togglePlay = useCallback(() => {
    if (!audioRef.current) return;
    
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setIsPlaying(!isPlaying);
  }, [isPlaying]);

  // Handle seek
  const handleSeek = useCallback((value: number[]) => {
    if (!audioRef.current) return;
    
    const newTime = value[0];
    audioRef.current.currentTime = newTime;
    setCurrentTime(newTime);
    onSeek?.(newTime);
  }, [onSeek]);

  // Skip forward/backward
  const skip = useCallback((seconds: number) => {
    if (!audioRef.current) return;
    
    const newTime = Math.max(0, Math.min(duration, currentTime + seconds));
    audioRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  }, [currentTime, duration]);

  // Handle volume change
  const handleVolumeChange = useCallback((value: number[]) => {
    if (!audioRef.current) return;
    
    const newVolume = value[0];
    audioRef.current.volume = newVolume;
    setVolume(newVolume);
    setIsMuted(newVolume === 0);
  }, []);

  // Toggle mute
  const toggleMute = useCallback(() => {
    if (!audioRef.current) return;
    
    if (isMuted) {
      audioRef.current.volume = volume || 1;
      setIsMuted(false);
    } else {
      audioRef.current.volume = 0;
      setIsMuted(true);
    }
  }, [isMuted, volume]);

  // Cycle playback rate
  const cyclePlaybackRate = useCallback(() => {
    const rates = [0.5, 0.75, 1, 1.25, 1.5, 2];
    const currentIndex = rates.indexOf(playbackRate);
    const nextRate = rates[(currentIndex + 1) % rates.length];
    
    if (audioRef.current) {
      audioRef.current.playbackRate = nextRate;
    }
    setPlaybackRate(nextRate);
  }, [playbackRate]);

  // Toggle loop
  const toggleLoop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.loop = !isLooping;
    }
    setIsLooping(!isLooping);
  }, [isLooping]);

  // Jump to specific time (for transcript sync) - exported via context
  const jumpToTime = useCallback((time: number) => {
    if (!audioRef.current) return;
    
    audioRef.current.currentTime = time;
    setCurrentTime(time);
    
    if (!isPlayingRef.current) {
      audioRef.current.play();
      setIsPlaying(true);
    }
  }, []);

  // Expose jumpToTime to parent components
  useEffect(() => {
    // Parent can call onSeek to trigger a jump
    (window as unknown as Record<string, unknown>).__audioPlayerJumpToTime = jumpToTime;
    return () => {
      delete (window as unknown as Record<string, unknown>).__audioPlayerJumpToTime;
    };
  }, [jumpToTime]);

  // Audio event handlers
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
      onTimeUpdate?.(audio.currentTime);
    };

    const handleLoadedMetadata = () => {
      setDuration(audio.duration);
    };

    const handleEnded = () => {
      setIsPlaying(false);
      if (!isLooping) {
        setCurrentTime(0);
      }
    };

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);

    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);

    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
    };
  }, [onTimeUpdate, isLooping]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if not in an input field
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          skip(-5);
          break;
        case "ArrowRight":
          e.preventDefault();
          skip(5);
          break;
        case "ArrowUp":
          e.preventDefault();
          handleVolumeChange([Math.min(1, volume + 0.1)]);
          break;
        case "ArrowDown":
          e.preventDefault();
          handleVolumeChange([Math.max(0, volume - 0.1)]);
          break;
        case "m":
          toggleMute();
          break;
        case "l":
          toggleLoop();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [togglePlay, skip, handleVolumeChange, volume, toggleMute, toggleLoop]);

  return (
    <div className={cn("bg-card rounded-lg p-4 space-y-4", className)}>
      <audio ref={audioRef} src={src} preload="metadata" />
      
      {/* Waveform visualization */}
      {showWaveform && waveformData.length > 0 && (
        <div className="h-16 bg-muted rounded-md overflow-hidden relative">
          <div className="flex items-center h-full gap-px px-1">
            {waveformData.map((value, i) => (
              <div
                key={i}
                className={cn(
                  "flex-1 rounded-full transition-colors",
                  (i / waveformData.length) <= (currentTime / duration)
                    ? "bg-primary"
                    : "bg-muted-foreground/30"
                )}
                style={{ height: `${Math.abs(value) * 100}%` }}
              />
            ))}
          </div>
          {/* Progress overlay */}
          <div
            className="absolute top-0 left-0 h-full bg-primary/10 pointer-events-none"
            style={{ width: `${(currentTime / duration) * 100}%` }}
          />
        </div>
      )}

      {/* Progress bar */}
      <div className="space-y-2">
        <Slider
          value={[currentTime]}
          max={duration || 100}
          step={0.1}
          onValueChange={handleSeek}
          className="cursor-pointer"
        />
        <div className="flex justify-between text-xs text-muted-foreground font-mono">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Skip back */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => skip(-10)}
            title="Skip back 10s"
          >
            <SkipBack className="h-4 w-4" />
          </Button>

          {/* Play/Pause */}
          <Button
            variant="default"
            size="icon"
            className="h-10 w-10"
            onClick={togglePlay}
          >
            {isPlaying ? (
              <Pause className="h-5 w-5" />
            ) : (
              <Play className="h-5 w-5 ml-0.5" />
            )}
          </Button>

          {/* Skip forward */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => skip(10)}
            title="Skip forward 10s"
          >
            <SkipForward className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-3">
          {/* Playback rate */}
          <Button
            variant="ghost"
            size="sm"
            onClick={cyclePlaybackRate}
            className="text-xs font-mono min-w-[3rem]"
            title="Playback speed"
          >
            {playbackRate}x
          </Button>

          {/* Loop */}
          <Button
            variant={isLooping ? "secondary" : "ghost"}
            size="icon"
            onClick={toggleLoop}
            title={isLooping ? "Loop on" : "Loop off"}
          >
            <Repeat className={cn("h-4 w-4", isLooping && "text-primary")} />
          </Button>

          {/* Volume */}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleMute}
              title={isMuted ? "Unmute" : "Mute"}
            >
              {isMuted ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </Button>
            <Slider
              value={[isMuted ? 0 : volume]}
              max={1}
              step={0.01}
              onValueChange={handleVolumeChange}
              className="w-20"
            />
          </div>
        </div>
      </div>

      {/* Keyboard shortcuts hint */}
      <div className="text-xs text-muted-foreground text-center">
        Space: play/pause | Arrow keys: seek/volume | M: mute | L: loop
      </div>
    </div>
  );
}

// Sync audio player with transcript
interface SyncedAudioPlayerProps extends AudioPlayerProps {
  transcriptSegments?: Array<{
    id: string;
    startTime: number;
    endTime: number;
    text: string;
  }>;
  onSegmentChange?: (segmentId: string) => void;
}

export function SyncedAudioPlayer({
  transcriptSegments = [],
  onSegmentChange,
  ...props
}: SyncedAudioPlayerProps) {
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);

  const handleTimeUpdate = useCallback((currentTime: number) => {
    // Find the segment that contains the current time
    const activeSegment = transcriptSegments.find(
      (seg) => currentTime >= seg.startTime && currentTime <= seg.endTime
    );

    if (activeSegment && activeSegment.id !== activeSegmentId) {
      setActiveSegmentId(activeSegment.id);
      onSegmentChange?.(activeSegment.id);
    }

    props.onTimeUpdate?.(currentTime);
  }, [transcriptSegments, activeSegmentId, onSegmentChange, props]);

  return (
    <AudioPlayer
      {...props}
      onTimeUpdate={handleTimeUpdate}
    />
  );
}
