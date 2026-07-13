# Plan: live streaming partial transcription

**Status: IMPLEMENTED** (the re-decode-a-separate-accumulator approach below),
hardened via a 4-reviewer adversarial pass. The partial path is UI-only and
provably never changes the final inserted text; it is gated behind the existing
Live Preview setting and local providers only. What still needs a real
microphone is *feel tuning* — the 700ms tick, 0.5s minimum, ~30s re-decode
window, and greedy whole-window decode are first-cut values to validate and
adjust on-device. The design notes below are retained as the rationale of
record; see commit "feat: live streaming partial transcription".

## Why it isn't done blind

The whole point of streaming is *feel*, which can't be judged headlessly, and
`transcription.dictation_live_preview_enabled` defaults to `true`, so emitting
partials turns the feature on for everyone. The safety-critical property —
**the inserted text must always be correct** — is easy to guarantee by
construction (see below), but partial *quality* is a UX judgment that needs a
human with a mic.

## Hard guarantee to preserve

The final inserted text MUST remain exactly today's batch result. The partial
path is **UI-only**: it reads a copy of the audio and emits preview events. It
never feeds `stop_dictation`'s transcription or the insertion path. Worst case
if partials are poor: the live preview looks rough and the user toggles Live
Preview off — the inserted text is unaffected.

## Current state (verified in code)

- `AudioCapture.dictation_buffer` (`SegQueue<f32>`, `audio.rs:56`) is filled by
  the capture callbacks and **drained only at stop** (`audio.rs:675`). It is not
  peekable, so partials need a separate accumulator.
- `DictationOverlayState.partial_text` (`lib.rs:298`) is only ever set to `None`
  (`lib.rs:332,16642`). The popup already renders a preview area when
  `dictation_live_preview_enabled` is set; it just never receives partials.
- `StreamingTranscriber` (`streaming.rs`) exists with `start_session` /
  `feed_audio` / `finalize_session` but is wired only to meeting recording.
- A complete Apple Speech live-dictation session
  (`asr/platform/macos_speech.rs::start_live_dictation_session`) exists with a
  partial event stream and a final oneshot — and has **zero callers**.

## Recommended approach: re-decode a separate accumulator (provider-agnostic)

Simplest, highest-quality, works with the default whisper.cpp path. Re-decoding
the whole utterance each tick (rather than concatenating chunks) avoids the
overlap-duplication bug noted in `streaming.rs` and keeps partials coherent. At
the measured ~74× real-time for `base.en` on real speech
(`scripts/fixtures/real-speech-44s.wav`), re-decoding a 10 s buffer costs
~135 ms — cheap enough to run every ~700 ms.

### Steps

1. **`audio.rs` — add a UI-only accumulator.**
   - Add `dictation_partial_buffer: Arc<Mutex<Vec<f32>>>` (std `Mutex`).
   - In each of the three capture callbacks (F32/I16/U8), after computing the
     mono samples for `buffer`, also `extend` the partial buffer under one lock
     per callback (one lock, not per-sample). Clear it where `dictation_buffer`
     is cleared (`audio.rs:400`) and at stop.
   - Expose `pub fn partial_buffer_handle(&self) -> Arc<Mutex<Vec<f32>>>` and
     reuse the existing `dictation_sample_rate`.

2. **`lib.rs` — spawn a partial task at dictation start.**
   - In `start_dictation_for_sidecar`, after capture is confirmed live and only
     when `settings.transcription.dictation_live_preview_enabled` is true and the
     resolved provider is local, spawn a tokio task that holds: the partial
     buffer `Arc`, the sample rate, a clone of the resolved provider (via
     `AsrProviderFactory::create_with_model`), the `SidecarHandle`, and the
     `is_dictating` flag.
   - Loop every ~700 ms while dictating: snapshot the buffer (clone under lock),
     skip if too short (<~0.5 s) or unchanged in length since last tick,
     `transcribe_bytes` it (greedy/fast params), and if the text changed emit a
     `dictation-partial` event `{ sessionId, text }` and set
     `overlay.partial_text`. Use `spawn_blocking`/the provider's own async as
     appropriate; never hold a lock across the transcription.
   - Stop the task when `is_dictating` goes false; it is best-effort and must
     swallow its own errors (log at debug).

3. **Renderer — render partials.** The popup already has the preview slot; wire
   the `dictation-partial` event into it so the text streams in, replaced by the
   final text on the existing `dictation-text-ready` event.

4. **Test.** Unit-test the tick/debounce decision (snapshot length thresholds,
   "changed since last" logic) as a pure function so it's covered without a mic.

### Tuning knobs to validate on-device

- Tick interval (start 700 ms), minimum buffer length before first partial,
  whether to cap re-decode to the last N seconds for very long dictations,
  and greedy-vs-beam params for partials (greedy is faster and fine for preview;
  the final pass keeps beam search).

## Alternative: Apple SpeechAnalyzer live session (macOS 26+)

`start_live_dictation_session` already streams partials natively and cheaply. It
could power both partials and the final transcript when the user selects Apple
Speech, but it captures its own audio (so it replaces, not augments, the
cpal+whisper path for that session) and is macOS-26-only and less accurate. Good
as an opt-in "instant, zero-download" engine; not the default streaming path.

## Acceptance

- With Live Preview on, text visibly streams during a multi-second dictation.
- With it off, behavior is byte-for-byte identical to today.
- Inserted final text is unchanged in both cases.
- No measurable regression to start/stop latency from the partial task.
