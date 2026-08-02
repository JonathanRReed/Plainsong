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
  "PLAINSONG_LOG",
  "PLAINSONG_CONFIG_DIR",
  "PLAINSONG_DATA_DIR",
  "PLAINSONG_MODELS_DIR",
  "PLAINSONG_QA_MODE",
  "PLAINSONG_PYTHON",
  "PLAINSONG_ASR_RUNNER",
  "PLAINSONG_WINDOWS_FOUNDRY_READY",
  "PLAINSONG_MLX_STUB_READY",
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

const QA_ONLY_PATH_OVERRIDES = new Set([
  "PLAINSONG_CONFIG_DIR",
  "PLAINSONG_DATA_DIR",
]);

type SidecarProcessEnv = Record<string, string | undefined>;

export function buildSidecarEnv(source: SidecarProcessEnv): SidecarProcessEnv {
  const env: SidecarProcessEnv = {};
  const qaModeEnabled = source.PLAINSONG_QA_MODE === "1";
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      SIDECAR_ENV_ALLOWLIST.has(key) &&
      (qaModeEnabled || !QA_ONLY_PATH_OVERRIDES.has(key))
    ) {
      env[key] = value;
    }
  }

  return env;
}
