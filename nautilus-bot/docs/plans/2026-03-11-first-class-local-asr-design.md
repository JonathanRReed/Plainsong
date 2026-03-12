# First-Class Local ASR Design

## Goal

Make Nautilus first class on local speech transcription for the supported launch platforms:

- macOS Apple Silicon
- Windows x86
- Windows ARM

The redesign must:

- use truthful model family names
- migrate existing settings cleanly
- expose stable and clearly labeled experimental local options
- support on-demand downloads only
- remove misleading provider claims

## Product Principles

- Product-facing choices are `model families`, not arbitrary backend names.
- Runtime engines are implementation details unless the user opts into an experimental engine path.
- Stable models are benchmarked, recommended, and eligible for defaults.
- Experimental models and engines are visible and downloadable, but never silently chosen as defaults.
- Historical recording metadata remains untouched for auditability.

## Supported Local Families

### Stable

- Whisper
  - `base.en`
  - `small.en`
  - `large-v3-turbo`
  - `large-v3`
- Distil-Whisper
  - `distil-large-v3.5`
- Parakeet
  - `parakeet-tdt-0.6b-v3`
- Moonshine
  - `moonshine-tiny`
  - `moonshine-base`
- Voxtral
  - `voxtral-local`
- Apple Native Speech
- Windows Native Speech

### Experimental

- Parakeet Legacy
  - `parakeet-tdt-ctc-110m`
- Whisper Candle
  - local `whisper-large-v3-turbo` execution via Candle
- Canary
  - only if backed by a real Canary model/runtime
- WhisperKit runtime path
- Parakeet-MLX runtime path
- additional Moonshine language variants

## Architecture

### Model family taxonomy

The ASR layer moves from ambiguous provider naming to explicit family naming:

- `whisper`
- `distil_whisper`
- `parakeet`
- `parakeet_legacy`
- `moonshine`
- `voxtral`
- `whisper_candle`
- `macos_apple_speech`
- `windows_sdk_dictation`
- cloud families remain separate and explicit

### Runtime engines

Each family can run through one or more engines:

- `whisper.cpp`
- `onnxruntime`
- `candle`
- `managed_python`
- `platform_native`
- future experimental engines:
  - `whisperkit`
  - `parakeet_mlx`

Runtime engines appear in diagnostics and advanced settings, not as the primary product taxonomy.

## Migration

### Settings migration

- old `canary` provider selections migrate to `whisper_candle`
- old `canary-qwen-2.5b` model selections migrate to `whisper-large-v3-turbo`
- old `parakeet-tdt-ctc-110m` remains valid but moves under `parakeet_legacy`
- old `moonshine` model selections migrate to `moonshine-base`
- old `voxtral-mini-4b` selections migrate to `voxtral-local`

Migration applies to:

- shared ASR selection
- dictation selection
- meeting selection
- provider model maps
- custom dictation modes with provider/model overrides

### Historical data

- recording transcript metadata is not rewritten
- old provider strings remain as historical facts in saved recordings

## Download UX

- Downloads are grouped by family and model, not just provider ID.
- Each option shows:
  - exact model
  - approximate size
  - supported platforms
  - intended use
  - stability label
- Platform-native engines do not appear as downloadable model bundles.
- Experimental runtime bundles are explicitly labeled as optional.

## Defaults

### Dictation

- macOS Apple Silicon: `whisper large-v3-turbo`
- Windows x86/ARM: `distil-large-v3.5`

### Meetings

- preferred: `parakeet-tdt-0.6b-v3`
- fallback: `distil-large-v3.5`
- fallback: `whisper large-v3-turbo`

## Implementation Order

1. Write the migration and taxonomy layer.
2. Rename misleading families and surface truthful labels.
3. Add `moonshine-tiny`.
4. Add `parakeet-tdt-0.6b-v3`.
5. Reclassify `whisper_candle` as experimental.
6. Rebuild provider manager, setup, and onboarding around stable vs experimental tiers.
7. Benchmark and adjust recommendations.

## Non-Goals For This Pass

- shipping fake Canary branding
- keeping Intel Mac optimization paths
- bundling large local models in the installer
- making experimental engines default routes
