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
  "PLAINSONG_QA_EPHEMERAL_SECRETS",
  // Lets the packaged footprint gate make the sidecar plan for a smaller Mac
  // (rust-sidecar/src/hardware_tier.rs). QA mode only, below.
  "PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB",
  // ...and for the memory a call app, browser and chat leave free on it.
  "PLAINSONG_SIMULATE_AVAILABLE_GB",
  "PLAINSONG_QA_PRESSURE_FILE",
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
  "PLAINSONG_QA_EPHEMERAL_SECRETS",
  "PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB",
  "PLAINSONG_SIMULATE_AVAILABLE_GB",
  "PLAINSONG_QA_PRESSURE_FILE",
]);

type SidecarProcessEnv = Record<string, string | undefined>;

export function buildSidecarEnv(
  source: SidecarProcessEnv,
  platform: NodeJS.Platform = process.platform,
): SidecarProcessEnv {
  const env: SidecarProcessEnv = {
    PATH: platform === "win32" ? source.PATH : SIDECAR_SYSTEM_PATH,
  };
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
