const SIDECAR_ENV_ALLOWLIST = new Set([
  "HOME",
  "USER",
  "USERNAME",
  "LOGNAME",
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
  "PLAINSONG_RCLONE_PATH",
  "PLAINSONG_WINDOWS_FOUNDRY_READY",
  "PLAINSONG_MLX_STUB_READY",
]);

const SIDECAR_SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";

const QA_ONLY_PATH_OVERRIDES = new Set([
  "PLAINSONG_CONFIG_DIR",
  "PLAINSONG_DATA_DIR",
]);

type SidecarProcessEnv = Record<string, string | undefined>;

export function buildSidecarEnv(source: SidecarProcessEnv): SidecarProcessEnv {
  const env: SidecarProcessEnv = { PATH: SIDECAR_SYSTEM_PATH };
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
