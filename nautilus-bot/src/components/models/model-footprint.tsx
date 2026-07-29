import { formatModelSize } from "@/lib/asr-capabilities";
import {
  bytesToMib,
  type DownloadedModelIndex,
} from "@/components/models/downloaded-models";

interface ModelFootprintProps {
  index: DownloadedModelIndex | null;
  /** All three promoted routes at full size, summed from the catalogue. */
  promotedTotalMib: number | null;
  /** What the current four lanes still have to fetch before they can run. */
  pendingMib: number;
}

export function ModelFootprint({
  index,
  promotedTotalMib,
  pendingMib,
}: ModelFootprintProps) {
  return (
    <div>
      <p className="section-heading">Disk</p>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
        {index
          ? `Speech models on this Mac: ${formatModelSize(bytesToMib(index.totalBytes))} across ${index.fileCount} ${index.fileCount === 1 ? "file" : "files"}. Measured off the files themselves, not the sizes we expected.`
          : "Could not read the models folder, so there is no measured total to show."}
      </p>
      {pendingMib > 0 ? (
        <p className="mt-1 max-w-2xl text-sm leading-6 text-rust">
          {formatModelSize(pendingMib)} still to download before every choice
          above can run.
        </p>
      ) : null}
      {promotedTotalMib !== null ? (
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
          Keeping all three of the models above at once costs{" "}
          {formatModelSize(promotedTotalMib)}. Nothing on this screen deletes a
          model you have already downloaded.
        </p>
      ) : null}
    </div>
  );
}
