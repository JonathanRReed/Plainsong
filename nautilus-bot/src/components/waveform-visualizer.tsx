import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { getWaveformData } from "@/lib/backend/recordings";

interface WaveformVisualizerProps {
  data: number[];
  isRecording?: boolean;
  height?: number;
  className?: string;
  barWidth?: number;
  barGap?: number;
  /**
   * When true, the live canvas fades out and resolves into a short row of gold
   * neumes — the brand thesis (voice → notation → written record). Additive and
   * back-compat: omitted means the canvas behaves exactly as before.
   */
  settled?: boolean;
  /** Number of neumes in the settled row. */
  settledNeumeCount?: number;
}

/**
 * The settled row — the waveform's resolution into notation. Gold neumes settle
 * in (staggered) as the canvas fades, or sit static-seated under reduced motion.
 */
function SettledNeumeRow({ count = 6 }: { count?: number }) {
  return (
    <div
      aria-hidden="true"
      className="settle-stagger pointer-events-none flex items-center gap-1.5"
    >
      {Array.from({ length: count }, (_, i) => (
        <span key={`neume-${i}`} className="neume neume-lit" />
      ))}
    </div>
  );
}

// Canvas can't use CSS utility classes, so read the brand tokens at draw time.
// active/live stroke -> --brand-warm (gold); secondary stroke -> --gold-ambient (bronze).
// Falls back to the ink/foreground token so strokes still track light/dark + theme.
function resolveCanvasColor(
  token: "active" | "trusted" | "muted-foreground",
  alpha?: number,
): string {
  const tokenVar =
    token === "active" ? "--brand-warm" : token === "trusted" ? "--gold-ambient" : "--foreground";

  if (typeof window === "undefined") {
    // SSR fallback: neutral ink so we never emit a forbidden hue.
    return alpha === undefined ? "#4a4336" : `rgba(74, 67, 54, ${alpha})`;
  }

  const value = getComputedStyle(document.documentElement).getPropertyValue(tokenVar).trim();

  if (!value) {
    return alpha === undefined ? "#4a4336" : `rgba(74, 67, 54, ${alpha})`;
  }

  // Tokens may be raw color() values (oklch) or bare HSL channels.
  const color = value.includes("(") ? value : `hsl(${value})`;
  return alpha === undefined ? color : `color-mix(in oklab, ${color} ${alpha * 100}%, transparent)`;
}

export function WaveformVisualizer({
  data,
  isRecording = false,
  height = 60,
  className,
  barWidth = 3,
  barGap = 1,
  settled = false,
  settledNeumeCount = 6,
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

    // Accessibility guards.
    const forcedColors =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(forced-colors: active)").matches;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    if (data.length === 0) {
      // Draw flat line when no data
      ctx.beginPath();
      ctx.moveTo(0, centerY);
      ctx.lineTo(width, centerY);
      ctx.strokeStyle = forcedColors ? "CanvasText" : resolveCanvasColor("muted-foreground");
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
      
      // Scale amplitude (0-1) to bar height with amplification for mic input
      const barHeight = Math.max(2, Math.min(height - 4, avgAmplitude * (height - 10) * 8));
      
      const x = i * totalBarWidth;
      const y = centerY - barHeight / 2;
      
      if (forcedColors) {
        // High-contrast mode: solid system color, no gradient.
        ctx.fillStyle = "CanvasText";
        ctx.fillRect(x, y, barWidth, barHeight);
        continue;
      }

      // Create gradient: gold for the live recording moment, bronze when idle.
      const gradient = ctx.createLinearGradient(0, y, 0, y + barHeight);
      if (isRecording) {
        gradient.addColorStop(0, resolveCanvasColor("active"));
        gradient.addColorStop(1, resolveCanvasColor("active", 0.5));
      } else {
        gradient.addColorStop(0, resolveCanvasColor("trusted"));
        gradient.addColorStop(1, resolveCanvasColor("trusted", 0.5));
      }

      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, barWidth, barHeight);
    }

    // Add gold glow effect when recording (skip in forced-colors mode).
    if (isRecording && !forcedColors) {
      ctx.shadowColor = resolveCanvasColor("active");
      ctx.shadowBlur = 10;
    }
  }, [data, height, barWidth, barGap, isRecording]);

  // Settled: the live canvas has fully resolved into notation — render only the
  // gold neume row (the canvas is unmounted; nothing left to draw or fade).
  if (settled) {
    return (
      <div
        className={cn("inline-flex items-center", className)}
        style={{ height }}
      >
        <SettledNeumeRow count={settledNeumeCount} />
      </div>
    );
  }

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
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isRecording) return;

    // STYLE.md §4: JS-driven canvas motion must respect reduced motion. Slow
    // the poll to a calm once-a-second refresh instead of a 10fps animation
    // (matching ui/audio-waveform.tsx's reduced-motion behavior).
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Poll for waveform data every 100ms (1s under reduced motion)
    intervalRef.current = setInterval(() => {
      getWaveformData(recordingId)
        .then((data) => setWaveformData(data))
        .catch((error) => {
          console.error("Failed to get waveform data:", error);
        });
    }, reducedMotion ? 1000 : 100);

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
        <div className="settle-in absolute top-2 right-2 flex items-center gap-1.5">
          <span className="neume neume-lit motion-safe:animate-pulse" aria-hidden="true" />
          <span className="font-mono text-[0.6875rem] font-medium uppercase tracking-[0.18em] text-gold-text">
            LIVE
          </span>
        </div>
      )}
    </div>
  );
}
