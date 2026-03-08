import { DictationPopup } from "@/components/popups/dictation-popup";
import { RecordingPopup } from "@/components/popups/recording-popup";
import { ThemeProvider } from "@/components/theme-provider";

export type OverlayMode = "dictation" | "recording";

export function OverlayRoot({ overlayMode }: { overlayMode: OverlayMode }) {
  return (
    <ThemeProvider>
      {overlayMode === "dictation" ? <DictationPopup /> : <RecordingPopup />}
    </ThemeProvider>
  );
}
