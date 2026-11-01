/** Renderer links may open only fixed documentation and model destinations.
 * Multi-tenant hosts also serve attacker-controlled pages and redirects, so a
 * hostname alone cannot authorize a path or a query carrying private text.
 */
export const ALLOWED_EXTERNAL_HOSTS: readonly string[] = [
  // Cohere Transcribe → rust-sidecar/src/asr/cohere.rs
  "docs.cohere.com",
  // ASR provider docs → rust-sidecar/src/asr/{groq,openai_cloud,elevenlabs_scribe}.rs
  "console.groq.com",
  "developers.openai.com",
  "elevenlabs.io",
  // Deepgram Nova → rust-sidecar/src/asr/deepgram.rs
  "developers.deepgram.com",
  // Mistral Voxtral → rust-sidecar/src/asr/mistral_voxtral.rs
  "console.mistral.ai",
  "docs.mistral.ai",
  // xAI Grok speech-to-text → rust-sidecar/src/asr/xai_stt.rs. Its key-setup
  // host (console.x.ai) only appears in plain-text diagnostics, so it stays out.
  "docs.x.ai",
  // Gemini Transcribe → rust-sidecar/src/asr/gemini_transcribe.rs
  "ai.google.dev",
  // macOS Apple Speech / Windows SDK dictation provider docs
  "developer.apple.com",
  "learn.microsoft.com",
  // Release downloads when the updater cannot install
  "github.com",
  // Every local ASR model card and weight file
  "huggingface.co",
  // The product site. Nothing links to it from the renderer today; it is listed
  // so a first-party docs or support link does not have to widen this list in a
  // hurry, and because it is the same origin the app already trusts for updates.
  "plainsong.jonathanrreed.com",
];

const ALLOWED_EXTERNAL_PATHS: Readonly<Record<string, readonly string[]>> = {
  "github.com": [
    "/", "/JonathanRReed/Plainsong", "/JonathanRReed/Plainsong/releases",
    ...["fluid-speech-mini-LICENSE.txt", "fluid-speech-mini-NOTICE.txt",
      "underdog-bark-3.0-pro-LICENSE.txt", "underdog-bark-3.0-pro-NOTICE.txt"]
      .map((file) => `/JonathanRReed/Plainsong/releases/download/models-2026-10/${file}`),
  ],
  "docs.cohere.com": ["/docs/transcribe", "/docs/audio-transcription-quickstart"],
  "console.groq.com": ["/docs/speech-to-text"],
  "developers.openai.com": ["/guides/stt", "/api/docs/guides/speech-to-text"],
  "elevenlabs.io": ["/docs/api-reference", "/docs/api-reference/speech-to-text"],
  "developers.deepgram.com": ["/docs/pre-recorded-audio"],
  "console.mistral.ai": ["/"],
  "docs.mistral.ai": ["/capabilities/audio/speech_to_text/offline_transcription"],
  "docs.x.ai": ["/"],
  "ai.google.dev": ["/gemini-api/docs/transcribe", "/gemma/terms", "/gemma/prohibited_use_policy"],
  "developer.apple.com": ["/documentation/speech"],
  "learn.microsoft.com": ["/windows/ai/speech", "/en-us/windows/ai/apis/speech-recognition"],
  "plainsong.jonathanrreed.com": ["/"],
};

const HUGGINGFACE_MODEL_CARDS = new Set([
  "openai/whisper-large-v3", "openai/whisper-large-v3-turbo",
  "distil-whisper/distil-large-v3.5", "Cactus-Compute/whistle",
  "UsefulSensors/moonshine", "UsefulSensors/moonshine-tiny", "UsefulSensors/moonshine-base",
  "onnx-community/cohere-transcribe-03-2026-ONNX", "andrewleech/qwen3-asr-0.6b-onnx",
  "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
  "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
  "csukuangfj/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000",
  "handy-computer/parakeet-tdt-0.6b-v3-gguf", "oruk/orukeet",
  "Qwen/Qwen3-ASR-1.7B", "Qwen/Qwen3-ASR-0.6B", "nvidia/parakeet-unified-en-0.6b",
  "handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf",
  "moonshine-ai/moonshine-streaming-medium", "FluidVoice-Labs/fluid-speech-mini-gguf",
  "ConwayResearch/Underdog-Bark-3.0-Pro", "handy-computer/Voxtral-Mini-3B-2507-gguf",
  "handy-computer/Voxtral-Mini-4B-Realtime-2602-gguf",
]);

const HUGGINGFACE_LICENSE_PATHS = new Set([
  "/oruk/orukeet/resolve/b59c13a733fce5cf193230d0fa317ee7f145a108/LICENSE-WEIGHTS",
  "/oruk/orukeet/resolve/b59c13a733fce5cf193230d0fa317ee7f145a108/NOTICE.md",
  "/nvidia/parakeet-unified-en-0.6b/resolve/fe53cd885760c96b6a5f51a0bfd362cb4584a98b/README.md",
]);

const ALLOWED_EXTERNAL_HOST_SET = new Set(ALLOWED_EXTERNAL_HOSTS);

/**
 * Whether `rawUrl` may be opened in the user's browser.
 *
 * Fails closed on anything unparseable, on any scheme other than `https:`, and
 * on any host not named above. `url.hostname` is compared (not `url.host`) so a
 * port cannot be used to smuggle a different authority past the check, and the
 * URL parser has already lowercased and punycoded the hostname by this point,
 * so `GitHub.com` and `xn--` spoofs both resolve before comparison.
 */
export function isAllowedExternalUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") {
    return false;
  }

  // A URL carrying credentials is never something the renderer legitimately
  // produced, and `https://github.com@evil.example/` parses with hostname
  // `evil.example` anyway — reject it explicitly so the intent is on record.
  if (url.username || url.password) {
    return false;
  }

  // Non-standard ports (anything other than empty/default port 443) are rejected
  // to prevent port smuggling or connecting to non-standard services on allowed hosts.
  if (url.port !== "") {
    return false;
  }

  // Account controls link to this fixed usage page. Keep arbitrary ChatGPT
  // paths, query strings and fragments outside the renderer's egress policy.
  if (url.href === "https://chatgpt.com/settings/usage") {
    return true;
  }

  // Strip trailing dot if present so DNS root-relative hostnames (e.g., github.com.) normalize properly
  const hostname = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  if (!ALLOWED_EXTERNAL_HOST_SET.has(hostname) || url.search || url.hash) {
    return false;
  }
  if (hostname === "huggingface.co") {
    return HUGGINGFACE_MODEL_CARDS.has(url.pathname.slice(1)) ||
      HUGGINGFACE_LICENSE_PATHS.has(url.pathname) ||
      /^\/ggerganov\/whisper\.cpp\/resolve\/5359861c739e955e79d9a303bcbc70fb988958b1\/ggml-(?:tiny|base|small|medium|large-v[123](?:-turbo)?)(?:\.en)?(?:-q[58]_0)?\.bin$/.test(url.pathname);
  }
  return ALLOWED_EXTERNAL_PATHS[hostname]?.includes(url.pathname) === true;
}
