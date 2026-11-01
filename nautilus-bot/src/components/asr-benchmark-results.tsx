import type { BenchmarkResult } from "@/types/asr";

export function AsrBenchmarkResults({ results }: { results: BenchmarkResult[] }) {
  if (results.length === 0) return null;
  return (
    <div className="space-y-2">
      {results.map((result) => {
        const failed = result.runtimeStatus === "error";
        return (
          <div key={`${result.providerType}-${result.modelId}`} className="flex items-center justify-between p-3 border rounded-lg">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{result.providerName}</p>
              <p className="text-sm text-muted-foreground">
                {result.modelId} · {failed ? "Could not benchmark" : result.runtimeStatus}
              </p>
              <p className={`mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed${failed ? " text-rust" : ""}`}>
                {failed
                  ? result.errorMessage || "This model could not transcribe the clip. Check its setup and available memory, then try again."
                  : result.transcription || "No speech returned."}
              </p>
            </div>
            <div className="ml-4 shrink-0 text-right">
              <p className="font-mono font-medium tabular-nums">{(result.processingTimeMs / 1000).toFixed(2)}s</p>
              <p className="text-xs text-muted-foreground">{failed ? "Attempt duration" : "Processing time"}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
