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
  /** Bar color, defaults to currentColor */
  barColor?: string;
  /** Accent color for the active glow */
  glowColor?: string;
  /** Enable the ambient glow behind active bars */
  glow?: boolean;
  /**
   * When true, the live bars fade out (opacity) so a caller can crossfade the
   * waveform into a settled neume row. Additive/back-compat: omitted leaves the
   * waveform fully visible exactly as before.
   */
  settled?: boolean;
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
  settled = false,
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

  // Canvas can't read CSS custom properties, so resolve var(--token) refs (and
  // fall back to warm brand colors) to concrete strings at draw time — keeps
  // strokes warm and theme-aware instead of raw white / cool defaults.
  const resolveColor = (input?: string, fallback = "rgba(200,149,67,0.5)") => {
    if (typeof window === "undefined") return fallback;
    const value = input?.trim() ?? "";
    const varMatch = value.match(/^var\((--[\w-]+)\)$/);
    if (varMatch) {
      const resolved = getComputedStyle(document.documentElement)
        .getPropertyValue(varMatch[1])
        .trim();
      return resolved || fallback;
    }
    return value || fallback;
  };

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

    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const forcedColors =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(forced-colors: active)").matches;
    const inkFallback = resolveColor("var(--foreground)", "rgba(241,237,228,0.9)");
    const barFill = resolveColor(barColor, inkFallback);
    const goldGlow = resolveColor(glowColor, barFill);

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

        const intensity = reducedMotion ? target : smoothedRef.current[i];
        const minBarH = variant === "pulse" ? 2 : config.barWidth;
        const barH = minBarH + intensity * (config.height - minBarH) * weight;
        const x = i * (config.barWidth + config.gap);
        const y = (config.height - barH) / 2;
        const radius = config.barWidth / 2;

        // Glow effect (skip under forced-colors so the system palette wins).
        if (glow && active && intensity > 0.3 && !forcedColors) {
          const glowAlpha = (intensity - 0.3) * 0.6;
          ctx.shadowColor = goldGlow;
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
        ctx.fillStyle = forcedColors ? "CanvasText" : barFill;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.roundRect(x, y, config.barWidth, barH, radius);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Honor reduced motion: paint one static frame, no animation loop.
      if (!reducedMotion) {
        animationRef.current = requestAnimationFrame(draw);
      }
    };

    if (reducedMotion) {
      draw();
    } else {
      animationRef.current = requestAnimationFrame(draw);
    }
    return () => cancelAnimationFrame(animationRef.current);
  }, [levels, active, variant, totalBars, barColor, glowColor, glow, config, weights, canvasWidth]);

  return (
    <canvas
      ref={canvasRef}
      className={cn(
        "pointer-events-none transition-opacity duration-500 ease-[var(--ease-settle)]",
        settled && "opacity-0",
        className,
      )}
      style={{ width: canvasWidth, height: config.height }}
      aria-hidden="true"
    />
  );
}
