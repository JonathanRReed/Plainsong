# Recorded audio storage

On macOS, Plainsong captures mono PCM16 WAV tracks at the device rate. Mixed
meetings use the higher source rate for the primary, mic and system tracks.
Kept dictation tracks retain the microphone rate. Imports normalize to 16 kHz
mono PCM16 before transcription.

Finalized meetings store mono 16 kHz PCM16 FLAC by default. Dual-source meetings
retain the microphone and call tracks without a stored mix. The
`meeting-audio-16k` feature is in Cargo defaults and the macOS shipping wrapper.
Capture and first-pass ASR resampling stay unchanged. Saved transcripts never
change during conversion. A later manual re-transcription or speaker relabel
uses compact audio, so results can differ slightly from the original.

The worker reuses the shipping Rust 95-tap centered anti-alias filter, its
7.8 kHz cutoff and the whole-file ASR reader's interpolation. A bounded reader
avoids loading a whole source-rate meeting into memory. It rounds to PCM16
and verifies every integer before encoding. FLAC preserves those integers
exactly. Older experimental PCM24 tracks remain readable.

The earlier synthetic meeting projected about 118 MB per meeting-hour for two
compact source tracks, versus 472 MB for three native-rate FLAC tracks. This
is a content-dependent layout projection, not a measured dual-source capture.

Kept dictations retain their original rate and channel count. Private dictation
recovery WAVs keep their existing 24-hour expiry.

## Conversion and recovery

A separate durable marker records successful final processing. A completed
transcript alone is insufficient because the speaker pass runs after that
status is published. Pending, recording, processing, failed and incomplete
meetings retain their original audio. Legacy meetings need a complete transcript
and durable diarizer or source-aware speaker evidence. Unknown legacy speaker
state retains the original audio until a successful retry.

The worker checks memory pressure, speech activity, foreground capture,
processing and free disk space. Unknown free space defers conversion. Conversion
uses the existing journal and retry backoff, one track per idle pass. Existing
WAV and native-rate FLAC meetings use the same path. No model loads are needed.

The worker validates source integrity before decoding or resampling. It checks
the resampled format and expected frame count, then requires exact equality with
the shipping ASR resampler's output rounded to PCM16. It decodes FLAC and
requires exact equality with that PCM. The original correlation check was
replaced after the owner selected the existing Rust resampler. It syncs the output,
then swaps the asset path and integrity metadata in one SQLite transaction.
Only a smaller output can replace the source. Vault output is encrypted and
authenticated before publication.

Once the retained sources are verified 16 kHz FLAC, one transaction removes the
primary mix asset, updates the compatibility path to a surviving source, and
journals deletion of the old mix. A crash leaves either the original asset or
its cleanup journal. Cleanup resumes without double-counting savings. Mic-only
and imported recordings keep their sole primary track. Call-only meetings keep
the call track and remove the duplicate primary.

Settings measures canonical stored files and journal-owned cleanup files. Its
savings counter includes bytes removed by completed conversions and mix removal,
not estimates of future savings. Temporary runtime files and old backups are
excluded. Savings depend on audio content.

## Reading saved audio

The shared vault resolver pins private source snapshots under the storage gate.
Same-volume snapshots use hard links; cross-volume copies retain open handles
and run after releasing the gate. Readers survive a later path switch or pruning.
The resolver verifies stored integrity, decrypts when needed, and decodes FLAC
into owned temporary WAVs.

Without a primary asset, the resolver rebuilds an aligned 16 kHz mix from the
microphone and call tracks. It measures active-speech loudness in bounded windows,
bounds gain to four times, and reserves shared peak headroom. A call-only meeting
uses its decoded call track directly. Playback tokens, waveform generation,
transcription retries, re-diarization, speaker labeling and audio opening/export
all use this resolver. Temporary files live until the resolved owner drops.
Document exports continue to read saved transcripts and notes. Aside spans are
loaded with the source bundle. The mixer masks the microphone before both
level measurement and mixing, while the call stays audible. Raw microphone
samples remain available for separate aside recovery. A regression test uses a
loud aside to catch masking after level measurement. Mic-only exports retain
their existing mask.

Full backups preserve compressed source bytes and finalization markers. Journal
filenames remain relative to the recording directory so restore can resume old
source or mix cleanup. Vault changes update the compatibility path even when
there is no primary asset. Retention and reset enumerate canonical sources and
journal paths rather than assuming a stored mix exists.

## Retention

New settings propose deleting meeting audio after three months, with
transcripts and notes kept. A month means 30 days. Existing explicit retention
choices remain unchanged. Automatic meeting deletion is paused until the owner
confirms it in Settings, including previously configured timers on upgrade.
Confirmation covers existing audio too.

Settings supports never, one week, one month, two months, three months and a
custom number of months. Whole-meeting deletion remains an explicit choice.
"Free up space now" confirms an audio-only cleanup using the saved age limit.
It keeps transcripts and notes even if the automatic policy deletes whole
meetings. It refuses a request made before the selected settings finish saving.

The existing startup and daily sweeps enforce retention. Transcript-only cleanup
also runs after its processing owner drops, so the owner cannot block its own
cleanup. They protect active
capture and processing, error and recovery rows, meetings without a saved
transcript, unacknowledged incomplete transcripts, and audio operations that
still own a source or cleanup copy. No separate retention scheduler is added.

## Platform limits

Compression uses the system `/usr/bin/afconvert` on macOS. Other platforms keep
the existing WAV behavior. Capture remains uncompressed while it is active,
and idle conversion may be deferred by resource use. Transcoding is not a
substitute for retention.

The database schema version is 4. Version 3 was already used by meeting asides.
Older binaries refuse this database rather than treating compressed tracks as damaged WAVs. Keep a backup from before the
upgrade if you need to return to an older build.

Storage counters count saved tracks, excluding temporary working files and old
backup copies. Counters refresh while Privacy settings are open.
