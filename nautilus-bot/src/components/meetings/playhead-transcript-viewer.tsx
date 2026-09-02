import { TranscriptViewer, type TranscriptViewerProps } from "@/components/transcript-viewer";
import { usePlayhead, type PlayheadStore } from "@/lib/playhead-store";

/**
 * The transcript, following the playhead on its own subscription.
 *
 * This is the whole state boundary: the audio player writes each `timeupdate`
 * into the store, this component reads it, and the meetings view around it
 * does not re-render four times a second to move one highlight.
 */
export function PlayheadTranscriptViewer({
  playhead,
  ...props
}: Omit<TranscriptViewerProps, "currentTime"> & { playhead: PlayheadStore }) {
  const currentTime = usePlayhead(playhead);
  return <TranscriptViewer {...props} currentTime={currentTime} />;
}
