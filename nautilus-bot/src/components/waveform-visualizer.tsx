import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { getWaveformData } from "@/lib/tauri";

interface WaveformVisualizerProps {
  data: number[];
  isRecording?: boolean;
  height?: number;
  className?: string;
  barWidth?: number;
  barGap?: number;
}

export function WaveformVisualizer({
  data,
  isRecording = false,
  height = 60,
  className,
  barWidth = 3,
  barGap = 1,
}: WaveformVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set canvas size
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const centerY = height / 2;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    if (data.length === 0) {
      // Draw flat line when no data
      ctx.beginPath();
      ctx.moveTo(0, centerY);
      ctx.lineTo(width, centerY);
      ctx.strokeStyle = "hsl(var(--muted-foreground))";
      ctx.lineWidth = 1;
      ctx.stroke();
      return;
    }

    // Calculate number of bars that fit
    const totalBarWidth = barWidth + barGap;
    const numBars = Math.floor(width / totalBarWidth);
    
    // Sample data to fit bars
    const samplesPerBar = Math.max(1, Math.floor(data.length / numBars));
    
    // Draw bars
    for (let i = 0; i < numBars && i * samplesPerBar < data.length; i++) {
      const startIdx = i * samplesPerBar;
      const endIdx = Math.min(startIdx + samplesPerBar, data.length);
      
      // Calculate average amplitude for this bar
      let sum = 0;
      for (let j = startIdx; j < endIdx; j++) {
        sum += Math.abs(data[j]);
      }
      const avgAmplitude = sum / (endIdx - startIdx);
      
      // Scale amplitude (0-1) to bar height
      const barHeight = Math.max(2, avgAmplitude * (height - 10));
      
      const x = i * totalBarWidth;
      const y = centerY - barHeight / 2;
      
      // Create gradient
      const gradient = ctx.createLinearGradient(0, y, 0, y + barHeight);
      if (isRecording) {
        gradient.addColorStop(0, "hsl(var(--active))");
        gradient.addColorStop(1, "hsl(var(--active) / 0.5)");
      } else {
        gradient.addColorStop(0, "hsl(var(--trusted))");
        gradient.addColorStop(1, "hsl(var(--trusted) / 0.5)");
      }
      
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, barWidth, barHeight);
    }

    // Add glow effect when recording
    if (isRecording) {
      ctx.shadowColor = "hsl(var(--active))";
      ctx.shadowBlur = 10;
    }
  }, [data, height, barWidth, barGap, isRecording]);

  return (
    <canvas
      ref={canvasRef}
      className={cn("w-full rounded-md", className)}
      style={{ height }}
    />
  );
}

interface RecordingWaveformProps {
  recordingId: string;
  isRecording?: boolean;
  height?: number;
  className?: string;
}

export function RecordingWaveform({
  recordingId,
  isRecording = false,
  height = 60,
  className,
}: RecordingWaveformProps) {
  const [waveformData, setWaveformData] = useState<number[]>([]);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!isRecording) return;

    // Poll for waveform data every 100ms
    intervalRef.current = setInterval(() => {
      getWaveformData(recordingId)
        .then((data) => setWaveformData(data))
        .catch((error) => {
          console.error("Failed to get waveform data:", error);
        });
    }, 100);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [recordingId, isRecording]);

  return (
    <div className={cn("relative", className)}>
      <WaveformVisualizer
        data={waveformData}
        isRecording={isRecording}
        height={height}
      />
      {isRecording && (
        <div className="absolute top-2 right-2 flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-active animate-pulse" />
          <span className="text-xs text-active font-medium">LIVE</span>
        </div>
      )}
    </div>
  );
}
