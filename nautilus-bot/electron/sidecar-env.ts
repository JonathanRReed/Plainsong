const SIDECAR_ENV_ALLOWLIST = new Set([
  "HOME",
  "USER",
  "USERNAME",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "RUST_LOG",
  "RUST_BACKTRACE",
  "NAUTILUS_LOG",
  "NAUTILUS_DATA_DIR",
  "NAUTILUS_MODELS_DIR",
  "NAUTILUS_QA_MODE",
  "NAUTILUS_PYTHON",
  "NAUTILUS_ASR_RUNNER",
  "NAUTILUS_MACOS_SPEECH_HELPER_PATH",
  "NAUTILUS_WINDOWS_FOUNDRY_READY",
  "NAUTILUS_MLX_STUB_READY",
  "OPENAI_API_KEY",
  "ELEVENLABS_API_KEY",
  "MISTRAL_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
  "CO_API_KEY",
  "OLLAMA_CLOUD_API_KEY",
]);

type SidecarProcessEnv = Record<string, string | undefined>;

export function buildSidecarEnv(source: SidecarProcessEnv): SidecarProcessEnv {
  const env: SidecarProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && SIDECAR_ENV_ALLOWLIST.has(key)) {
      env[key] = value;
    }
  }

  return env;
}
