export const MAX_ASR_BENCHMARK_AUDIO_BYTES = 6 * 1024 * 1024;

export async function readAsrBenchmarkAudio(
  file: Pick<File, "size" | "arrayBuffer">,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new Error("Choose a nonempty WAV audio file.");
  }
  if (file.size > MAX_ASR_BENCHMARK_AUDIO_BYTES) {
    throw new Error("Choose a shorter WAV clip, up to 6 MiB.");
  }

  const buffer = await file.arrayBuffer();
  if (buffer.byteLength !== file.size) {
    throw new Error("The audio file changed while reading it. Choose it again.");
  }
  return new Uint8Array(buffer);
}
