import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

type WaveformVariant = "bars" | "pulse";
type WaveformSize = "sm" | "md" | "lg";

interface AudioWaveformProps {
  /** Audio level 0–1, or array of bar levels */
  levels?: number | number[];
  /** Whether the waveform is actively capturing audio */
  active?: boolean;
  /** Visual variant */
  variant?: WaveformVariant;
  /** Size preset */
  size?: WaveformSize;
  /** Number of bars (ignored if levels is an array) */
  barCount?: number;
  /** Bar color — defaults to currentColor */
  barColor?: string;
  /** Accent color for the active glow */
  glowColor?: string;
  /** Enable the ambient glow behind active bars */
  glow?: boolean;
  className?: string;
}

const SIZE_CONFIG: Record<WaveformSize, { height: number; barWidth: number; gap: number }> = {
  sm: { height: 16, barWidth: 2, gap: 1 },
  md: { height: 28, barWidth: 3, gap: 2 },
  lg: { height: 40, barWidth: 4, gap: 3 },
};

function generateSymmetricWeights(count: number): number[] {
  const half = Math.ceil(count / 2);
  const weights: number[] = [];
  for (let i = 0; i < half; i++) {
    weights.push(0.15 + (i / (half - 1)) * 0.85);
  }
  const mirrored = [...weights];
  if (count % 2 === 0) {
    mirrored.push(...[...weights].reverse());
  } else {
    mirrored.push(...[...weights].slice(0, -1).reverse());
  }
  return mirrored;
}

export function AudioWaveform({
  levels = 0,
  active = false,
  variant = "bars",
  size = "md",
  barCount = 13,
  barColor,
  glowColor,
  glow = false,
  className,
}: AudioWaveformProps) {
  const frameRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const smoothedRef = useRef<number[]>([]);

  const config = SIZE_CONFIG[size];
  const totalBars = Array.isArray(levels) ? levels.length : barCount;
  const weights = generateSymmetricWeights(totalBars);
  const canvasWidth = totalBars * (config.barWidth + config.gap) - config.gap;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasWidth * dpr;
    canvas.height = config.height * dpr;
    ctx.scale(dpr, dpr);

    if (smoothedRef.current.length !== totalBars) {
      smoothedRef.current = new Array(totalBars).fill(0.15);
    }

    const draw = () => {
      frameRef.current += 1;
      const frame = frameRef.current;

      ctx.clearRect(0, 0, canvasWidth, config.height);

      const barLevels = Array.isArray(levels)
        ? levels
        : new Array(totalBars).fill(levels as number);

      for (let i = 0; i < totalBars; i++) {
        const weight = weights[i];
        const drift = (Math.sin(frame * 0.04 + i * 0.6) + 1) / 2;

        let target: number;
        if (active) {
          const rawLevel = barLevels[i] ?? 0;
          target = Math.max(0.18, Math.min(1, rawLevel * (0.5 + weight * 0.8) + drift * 0.15));
        } else {
          target = 0.12 + drift * 0.06;
        }

        // Smooth interpolation
        const current = smoothedRef.current[i] ?? 0.15;
        const smoothing = active ? 0.18 : 0.06;
        smoothedRef.current[i] = current + (target - current) * smoothing;

        const intensity = smoothedRef.current[i];
        const minBarH = variant === "pulse" ? 2 : config.barWidth;
        const barH = minBarH + intensity * (config.height - minBarH) * weight;
        const x = i * (config.barWidth + config.gap);
        const y = (config.height - barH) / 2;
        const radius = config.barWidth / 2;

        // Glow effect
        if (glow && active && intensity > 0.3) {
          const glowAlpha = (intensity - 0.3) * 0.6;
          ctx.shadowColor = glowColor || barColor || "rgba(255,255,255,0.5)";
          ctx.shadowBlur = 6;
          ctx.globalAlpha = glowAlpha;
          ctx.beginPath();
          ctx.roundRect(x, y, config.barWidth, barH, radius);
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.globalAlpha = 1;
        }

        // Main bar
        const alpha = active ? 0.35 + intensity * 0.65 : 0.2 + intensity * 0.15;
        ctx.fillStyle = barColor || "currentColor";
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.roundRect(x, y, config.barWidth, barH, radius);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      animationRef.current = requestAnimationFrame(draw);
    };

    animationRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animationRef.current);
  }, [levels, active, variant, totalBars, barColor, glowColor, glow, config, weights, canvasWidth]);

  return (
    <canvas
      ref={canvasRef}
      className={cn("pointer-events-none", className)}
      style={{ width: canvasWidth, height: config.height }}
      aria-hidden="true"
    />
  );
}
