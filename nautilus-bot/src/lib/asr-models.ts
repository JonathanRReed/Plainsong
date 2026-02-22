export interface AsrModelOption {
  id: string;
  label: string;
}

export interface AsrModelOptionGroup {
  label: string;
  options: AsrModelOption[];
}

export interface QuickDownloadAsrModel {
  id: string;
  name: string;
  description: string;
  size: string;
}

export const LOCAL_ASR_MODEL_GROUPS: AsrModelOptionGroup[] = [
  {
    label: "Fast (edge friendly)",
    options: [
      { id: "tiny", label: "Whisper tiny - 39M params, fastest" },
      { id: "tiny.en", label: "Whisper tiny.en - English only" },
      { id: "base", label: "Whisper base - 74M params" },
      { id: "base.en", label: "Whisper base.en - English only" },
    ],
  },
  {
    label: "Balanced",
    options: [
      { id: "small", label: "Whisper small - 244M params" },
      { id: "small.en", label: "Whisper small.en - English only" },
      { id: "medium", label: "Whisper medium - 769M params" },
      { id: "medium.en", label: "Whisper medium.en - English only" },
    ],
  },
  {
    label: "Best accuracy",
    options: [
      { id: "large-v3", label: "Whisper large-v3 - 1.5B params, 99+ languages" },
      { id: "large-v3-turbo", label: "Whisper large-v3-turbo - fast and accurate" },
    ],
  },
  {
    label: "Provider-specific alternatives",
    options: [
      { id: "parakeet-tdt-ctc-110m", label: "Parakeet TDT CTC 110M - ultra low latency" },
      { id: "canary-qwen-2.5b", label: "Canary Qwen 2.5B - max English accuracy" },
      { id: "distil-large-v3.5", label: "Distil-Whisper Large V3.5 - 6x faster" },
    ],
  },
  {
    label: "Other local providers",
    options: [
      { id: "moonshine", label: "Moonshine - UsefulSensors, edge-optimized" },
      { id: "vibevoice-asr", label: "VibeVoice - Microsoft, streaming ASR" },
      { id: "voxtral-local", label: "Voxtral Mini (Local) - Mistral, multilingual" },
    ],
  },
  {
    label: "Cloud providers",
    options: [
      { id: "elevenlabs_scribe", label: "ElevenLabs Scribe - cloud transcription" },
      { id: "openai_cloud", label: "OpenAI Whisper (Cloud) - API-based" },
    ],
  },
];

export const QUICK_DOWNLOAD_ASR_MODELS: QuickDownloadAsrModel[] = [
  {
    id: "large-v3-turbo",
    name: "Whisper Large V3 Turbo",
    description: "Fast and accurate",
    size: "1.6 GB",
  },
  {
    id: "large-v3",
    name: "Whisper Large V3",
    description: "99+ languages",
    size: "2.9 GB",
  },
  {
    id: "base.en",
    name: "Whisper Base EN",
    description: "Fast English",
    size: "142 MB",
  },
  {
    id: "small.en",
    name: "Whisper Small EN",
    description: "Balanced English",
    size: "466 MB",
  },
  {
    id: "medium.en",
    name: "Whisper Medium EN",
    description: "Best English",
    size: "1.5 GB",
  },
];
