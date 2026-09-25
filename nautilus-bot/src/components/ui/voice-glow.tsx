import type { ReactNode } from "react";
import { VoiceBeam, type VoiceBeamLevel } from "voice-glow";
import { useDocumentTheme } from "@/hooks/use-document-theme";

// House gold, centre first then outward: --brand-warm on dark, the brand gold
// the waveform glows with, then --brand-warm-strong's deeper bronze. The
// library parses hex/rgb only, so these mirror the OKLCH tokens.
const HOUSE_GOLDS = ["#dcb366", "#c89543", "#b5823a", "#96692e"];
// The band's defaults carry teal and rose fringes; keep the ridge in gold too.
const HOUSE_BAND = { core: "#f1dcaa", above: "#dcb366", mid: "#c89543", below: "#96692e" };

function forcedColorsActive(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(forced-colors: active)").matches
  );
}

interface GoldVoiceGlowProps {
  children: ReactNode;
  /** Whether a voice is being captured or processed right now. */
  active: boolean;
  /** Level getter (0-1) or a live stream; a stream wins. */
  level?: VoiceBeamLevel;
  stream?: MediaStream | null;
  /** After speech: the glow gathers into a slow travelling beam. */
  processing?: boolean;
  className?: string;
}

/**
 * The live-voice glow (voice-glow's VoiceBeam) in Plainsong's burnished gold,
 * reserved for the moments STYLE.md lets gold move: the microphone is live or
 * the words are being set down. Wraps exactly one element that carries its own
 * border radius; content that must stay crisp above the bloom needs
 * `relative z-[5]`. Decorative only: the wrapped surface keeps its text status.
 * The library drops its sweep and breathing under reduced motion; under forced
 * colors the glow stays off.
 */
export function GoldVoiceGlow({
  children,
  active,
  level,
  stream,
  processing = false,
  className,
}: GoldVoiceGlowProps) {
  const theme = useDocumentTheme();
  return (
    <VoiceBeam
      className={className}
      active={active && !forcedColorsActive()}
      level={level}
      stream={stream}
      processing={processing}
      theme={theme}
      colorVariant="gold"
      colors={HOUSE_GOLDS}
      bandColors={HOUSE_BAND}
      staticColors
    >
      {children}
    </VoiceBeam>
  );
}
