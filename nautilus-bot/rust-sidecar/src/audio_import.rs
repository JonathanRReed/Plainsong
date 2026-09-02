//! Importing an existing audio file as a meeting.
//!
//! Everything here is a pure decision or a string builder so the policy — what
//! Plainsong will accept, and exactly how it asks macOS to decode it — is
//! testable without a file, a Mac, or an `AppState`. The one impure step
//! (running `afconvert`) lives in `lib.rs` beside the rest of the import
//! command; this module only says what to run.
//!
//! Conversion uses the `afconvert` and `afinfo` binaries that ship with macOS
//! rather than a decoder crate: the formats below span MP3, AAC, ALAC, FLAC,
//! Vorbis and Opus, and pulling in a crate per family (or one large one) to
//! re-decode what CoreAudio already decodes correctly would be a much larger
//! dependency and attack surface than shelling out to two Apple tools.

use std::ffi::OsString;
use std::path::Path;

/// The container extensions "Import audio…" accepts, matching the file
/// dialog's filter in `electron/main.ts`.
///
/// `.webm` is deliberately absent: CoreAudio has no Matroska demuxer, so
/// `afinfo` answers "AudioFileOpenURL failed" and `afconvert` answers
/// "Couldn't open input file" for every one of them. Advertising a format the
/// decoder cannot open only moves the refusal from the picker to a failed
/// import. `.ogg` stays because CoreAudio does read Ogg (verified with an
/// Opus-in-Ogg file).
pub(crate) const SUPPORTED_IMPORT_EXTENSIONS: &[&str] =
    &["wav", "mp3", "m4a", "aac", "mp4", "ogg", "flac"];

/// 2 GB. Larger than any plausible meeting recording, and small enough that
/// the converted 16 kHz mono WAV still fits comfortably on disk.
pub(crate) const MAX_IMPORT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// 4 hours. The chunked meeting transcriber handles longer audio, but a file
/// this long already takes many minutes to transcribe locally, and silently
/// starting a multi-hour job from a file picker is not a thing to do to
/// someone.
pub(crate) const MAX_IMPORT_DURATION_SECONDS: f64 = 4.0 * 60.0 * 60.0;

/// The sample rate every ASR route here expects.
pub(crate) const IMPORT_SAMPLE_RATE_HZ: u32 = 16_000;

/// Bytes one second of the converted file occupies: 16 kHz, mono, 16-bit.
pub(crate) const IMPORT_WAV_BYTES_PER_SECOND: u64 = IMPORT_SAMPLE_RATE_HZ as u64 * 2;

/// Free space kept beyond the converted WAV itself.
///
/// The conversion is not the only writer on this volume — a meeting may be
/// recording into the same folder while an import runs — so filling the disk
/// to the last byte of the converted file would break the recording rather
/// than the import.
pub(crate) const IMPORT_SPACE_MARGIN_BYTES: u64 = 256 * 1024 * 1024;

/// The shortest conversion timeout, for a file too short for `2x duration` to
/// mean anything. `afconvert` on a few seconds of audio finishes in
/// milliseconds; a minute is spent only when something is genuinely wrong.
pub(crate) const MIN_IMPORT_CONVERSION_TIMEOUT_SECONDS: u64 = 60;

/// The lowercase extension of `path`, if it is one Plainsong can import.
pub(crate) fn validate_import_extension(path: &Path) -> Result<String, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if extension.is_empty() {
        return Err(format!(
            "Plainsong needs a file extension to know how to read this audio. Supported: {}.",
            supported_extensions_sentence()
        ));
    }
    if !SUPPORTED_IMPORT_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!(
            "Plainsong cannot import a .{extension} file. Supported: {}.",
            supported_extensions_sentence()
        ));
    }
    Ok(extension)
}

pub(crate) fn supported_extensions_sentence() -> String {
    SUPPORTED_IMPORT_EXTENSIONS
        .iter()
        .map(|extension| format!(".{extension}"))
        .collect::<Vec<_>>()
        .join(", ")
}

pub(crate) fn validate_import_size(bytes: u64) -> Result<(), String> {
    if bytes == 0 {
        return Err("That audio file is empty.".to_string());
    }
    if bytes > MAX_IMPORT_BYTES {
        return Err(format!(
            "That audio file is {:.1} GB. Plainsong imports files up to 2 GB.",
            bytes as f64 / (1024.0 * 1024.0 * 1024.0)
        ));
    }
    Ok(())
}

pub(crate) fn validate_import_duration(seconds: f64) -> Result<(), String> {
    if !seconds.is_finite() || seconds <= 0.0 {
        return Err("Plainsong could not find any audio in that file.".to_string());
    }
    if seconds > MAX_IMPORT_DURATION_SECONDS {
        return Err(format!(
            "That recording is {:.1} hours long. Plainsong imports recordings up to 4 hours.",
            seconds / 3600.0
        ));
    }
    Ok(())
}

/// The `afconvert` command line that decodes any supported container into the
/// 16 kHz mono little-endian 16-bit WAV the meeting pipeline reads.
///
/// `--mix` (rather than a bare `-c 1`) is what downmixes a stereo or 5.1
/// source instead of discarding every channel but the first, which would drop
/// one side of a two-person recording entirely.
pub(crate) fn afconvert_args(input: &Path, output: &Path) -> Vec<OsString> {
    vec![
        OsString::from("-f"),
        OsString::from("WAVE"),
        OsString::from("-d"),
        OsString::from(format!("LEI16@{IMPORT_SAMPLE_RATE_HZ}")),
        OsString::from("-c"),
        OsString::from("1"),
        OsString::from("--mix"),
        input.as_os_str().to_os_string(),
        output.as_os_str().to_os_string(),
    ]
}

/// Pulls the duration out of `afinfo` output.
///
/// `afinfo` prints a human report, not JSON, and it prints two different
/// reports. Plain `afinfo` has the line worth reading,
/// `estimated duration: 2.000000 sec`. `afinfo --brief` has no such line at
/// all -- it states the length in the head of its format line,
/// `1.492 sec, format:   1 ch,  16000 Hz, Int16`. Both are parsed here, so
/// neither invocation silently reports "unknown length" and skips the guard
/// that keeps a nine-hour file from being decoded in full.
///
/// Returning `None` for anything else keeps a format change from being read
/// as "zero seconds"; the caller treats `None` as a refusal, not a pass.
pub(crate) fn parse_afinfo_duration_seconds(output: &str) -> Option<f64> {
    for line in output.lines() {
        let lowered = line.trim().to_ascii_lowercase();
        if let Some(rest) = lowered.strip_prefix("estimated duration:") {
            let value = rest.trim().trim_end_matches("sec").trim();
            if let Ok(seconds) = value.parse::<f64>() {
                return Some(seconds);
            }
            continue;
        }
        if let Some(seconds) = parse_afinfo_brief_duration_line(&lowered) {
            return Some(seconds);
        }
    }
    None
}

/// The `--brief` report's one duration line: `1.492 sec, format:   1 ch, ...`.
///
/// The `format:` tail is required, so a number that happens to sit in front of
/// the word "sec" in a file name or an error sentence is never read as a
/// length.
fn parse_afinfo_brief_duration_line(lowered_line: &str) -> Option<f64> {
    let (seconds, rest) = lowered_line.split_once(" sec,")?;
    if !rest.trim_start().starts_with("format:") {
        return None;
    }
    seconds.trim().parse::<f64>().ok()
}

/// What to say when macOS could not tell Plainsong how long a file is.
///
/// This is a refusal, not a warning. The length check is the only thing
/// standing between a nine-hour file and a full decode, so a length nobody can
/// read means the file does not get decoded. `afinfo` names the reason on
/// stderr ("Fail: AudioFileOpenURL failed"), and that sentence is the useful
/// half of the message.
pub(crate) fn unreadable_duration_message(stderr: &str) -> String {
    match stderr.lines().map(str::trim).find(|line| !line.is_empty()) {
        Some(detail) => format!(
            "Plainsong could not determine the length of that audio file, so it will not decode it: {detail}"
        ),
        None => "Plainsong could not determine the length of that audio file, so it will not decode it."
            .to_string(),
    }
}

/// How long the conversion of a file this long is allowed to take.
///
/// `afconvert` decodes far faster than real time, so twice the source duration
/// is generous for any file that is being read at all. What this bounds is the
/// case the multiplier cannot help with: a source on a network volume that
/// stops answering, where `afconvert` blocks in a read forever while the
/// import holds the audio storage gate and the post-processing lease, wedging
/// retention, vault migration and backup until the sidecar restarts.
pub(crate) fn import_conversion_timeout(duration_seconds: f64) -> std::time::Duration {
    let doubled = if duration_seconds.is_finite() && duration_seconds > 0.0 {
        (duration_seconds * 2.0).ceil() as u64
    } else {
        0
    };
    std::time::Duration::from_secs(doubled.max(MIN_IMPORT_CONVERSION_TIMEOUT_SECONDS))
}

/// Bytes that must be free before a file this long is converted: the converted
/// 16 kHz mono WAV, plus a fixed margin for everything else writing here.
pub(crate) fn import_conversion_bytes_needed(duration_seconds: f64) -> u64 {
    let seconds = if duration_seconds.is_finite() && duration_seconds > 0.0 {
        duration_seconds.ceil() as u64
    } else {
        0
    };
    seconds
        .saturating_mul(IMPORT_WAV_BYTES_PER_SECOND)
        .saturating_add(IMPORT_SPACE_MARGIN_BYTES)
}

/// `Some(needed)` when a volume with `available` free bytes must not be asked
/// to hold the conversion of a file this long.
///
/// `None` for an unmeasurable volume: a filesystem that cannot report free
/// space must leave the import unpreflighted, not impossible. That matches
/// what capture does in `audio.rs`.
pub(crate) fn import_space_shortfall(duration_seconds: f64, available: Option<u64>) -> Option<u64> {
    let needed = import_conversion_bytes_needed(duration_seconds);
    match available {
        Some(available) if available < needed => Some(needed),
        _ => None,
    }
}

pub(crate) fn insufficient_space_message(needed_bytes: u64) -> String {
    format!(
        "There is not enough free space to decode that audio file. Plainsong needs about {:.1} GB free.",
        needed_bytes as f64 / (1024.0 * 1024.0 * 1024.0)
    )
}

pub(crate) fn conversion_timeout_message(timeout: std::time::Duration) -> String {
    format!(
        "Decoding that audio file took longer than {} seconds, so Plainsong stopped it. If the file is on a network volume or an external disk, copy it to this Mac and try again.",
        timeout.as_secs()
    )
}

/// The meeting title for an imported file: the file's own name without its
/// extension, tidied but never invented. An unusable name falls back to a
/// generic one rather than to something the file does not say.
pub(crate) fn import_title_from_file_name(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let cleaned = stem
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed: String = collapsed.chars().take(120).collect();
    if trimmed.trim().is_empty() {
        "Imported audio".to_string()
    } else {
        trimmed.trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn extension_validation_accepts_the_documented_list_and_nothing_else() {
        for extension in SUPPORTED_IMPORT_EXTENSIONS {
            let path = PathBuf::from(format!("/tmp/standup.{extension}"));
            assert_eq!(
                validate_import_extension(&path).as_deref(),
                Ok(*extension),
                "{extension} must be importable"
            );
        }
        // Case is not significant: a file picker hands back what the disk says.
        assert_eq!(
            validate_import_extension(Path::new("/tmp/Standup.M4A")).as_deref(),
            Ok("m4a")
        );

        // Anything else is refused by name, and the refusal lists what works.
        let refused = validate_import_extension(Path::new("/tmp/notes.pdf")).unwrap_err();
        assert!(refused.contains(".pdf"), "{refused}");
        assert!(refused.contains(".flac"), "{refused}");
        // Not an audio container even though CoreAudio might open it.
        assert!(validate_import_extension(Path::new("/tmp/clip.mov")).is_err());
        assert!(validate_import_extension(Path::new("/tmp/clip.aiff")).is_err());
        // No extension at all.
        let missing = validate_import_extension(Path::new("/tmp/recording")).unwrap_err();
        assert!(missing.contains("file extension"), "{missing}");
    }

    #[test]
    fn size_and_duration_limits_are_stated_in_the_refusal() {
        assert!(validate_import_size(1).is_ok());
        assert!(validate_import_size(MAX_IMPORT_BYTES).is_ok());
        let empty = validate_import_size(0).unwrap_err();
        assert!(empty.contains("empty"), "{empty}");
        let huge = validate_import_size(MAX_IMPORT_BYTES + 1).unwrap_err();
        assert!(huge.contains("2 GB"), "{huge}");

        assert!(validate_import_duration(1.0).is_ok());
        assert!(validate_import_duration(MAX_IMPORT_DURATION_SECONDS).is_ok());
        let long = validate_import_duration(MAX_IMPORT_DURATION_SECONDS + 1.0).unwrap_err();
        assert!(long.contains("4 hours"), "{long}");
        assert!(validate_import_duration(0.0).is_err());
        assert!(validate_import_duration(f64::NAN).is_err());
        assert!(validate_import_duration(-3.0).is_err());
    }

    #[test]
    fn afconvert_args_ask_for_16k_mono_wav_and_downmix_rather_than_drop_channels() {
        let args = afconvert_args(Path::new("/in/two channel.m4a"), Path::new("/out/one.wav"));
        let rendered: Vec<String> = args
            .iter()
            .map(|value| value.to_string_lossy().to_string())
            .collect();
        assert_eq!(
            rendered,
            vec![
                "-f",
                "WAVE",
                "-d",
                "LEI16@16000",
                "-c",
                "1",
                "--mix",
                "/in/two channel.m4a",
                "/out/one.wav",
            ]
        );
        // The paths travel as OsString, so a name afconvert would otherwise
        // have to be quoted for still arrives as one argument.
        assert_eq!(args[7].to_string_lossy(), "/in/two channel.m4a");
    }

    /// Verbatim `afinfo <file>` output, captured on macOS 27 from a 16 kHz
    /// mono WAV written by `afconvert`.
    const REAL_AFINFO_FULL_WAV: &str = "\
File:           /tmp/probe.wav
File type ID:   WAVE
Num Tracks:     1
----
Data format:     1 ch,  16000 Hz, Int16
                no channel layout.
estimated duration: 1.492438 sec
audio bytes: 47758
audio packets: 23879
bit rate: 256000 bits per second
packet size upper bound: 2
maximum packet size: 2
audio data file offset: 4096
optimized
source bit depth: I16
----
";

    /// Verbatim `afinfo --brief <file>` output for the same file. Note that
    /// there is no `estimated duration:` line anywhere in it: this is the
    /// report the probe used to run, which is why the length guard never fired.
    const REAL_AFINFO_BRIEF_WAV: &str = "\
/tmp/probe.wav, WAVE, Num Tracks:     1
----
1.492 sec, format:   1 ch,  16000 Hz, Int16
";

    /// Verbatim `afinfo --brief <file>` output for an AAC-in-MP4 file, whose
    /// format tail is much longer than the WAV one.
    const REAL_AFINFO_BRIEF_M4A: &str = "\
/tmp/probe.m4a, m4af, Num Tracks:     1
----
1.492 sec, format:   1 ch,  16000 Hz, aac  (0x00000000) 0 bits/channel, 0 bytes/packet, 1024 frames/packet, 0 bytes/frame
";

    /// Verbatim `afinfo` stderr for a file CoreAudio cannot open — here a real
    /// Opus-in-WebM file, which is exactly why .webm is no longer offered.
    const REAL_AFINFO_UNOPENABLE_STDERR: &str = "Fail: AudioFileOpenURL failed\n";

    #[test]
    fn afinfo_duration_is_read_from_both_reports_macos_actually_prints() {
        // The plain report states it outright.
        assert_eq!(
            parse_afinfo_duration_seconds(REAL_AFINFO_FULL_WAV),
            Some(1.492438)
        );
        // The brief report states it only in the head of the format line.
        assert_eq!(
            parse_afinfo_duration_seconds(REAL_AFINFO_BRIEF_WAV),
            Some(1.492)
        );
        assert_eq!(
            parse_afinfo_duration_seconds(REAL_AFINFO_BRIEF_M4A),
            Some(1.492)
        );

        // A synthetic long file, to show the value that reaches the 4-hour
        // guard is the number of seconds and not a rounded minute count.
        let long = "File:           sample.wav\n\
             estimated duration: 3721.500000 sec\n";
        assert_eq!(parse_afinfo_duration_seconds(long), Some(3721.5));

        // A report without either shape is unknown, not zero.
        assert_eq!(
            parse_afinfo_duration_seconds(REAL_AFINFO_UNOPENABLE_STDERR),
            None
        );
        assert_eq!(parse_afinfo_duration_seconds("File: broken.mp3\n"), None);
        assert_eq!(parse_afinfo_duration_seconds(""), None);
        // " sec," without a format tail is prose, not a duration.
        assert_eq!(
            parse_afinfo_duration_seconds("gave up after 30 sec, sorry\n"),
            None
        );
        // A file name that reads like the brief line still does not parse.
        assert_eq!(
            parse_afinfo_duration_seconds("/tmp/12 sec, format: notes.wav, WAVE\n"),
            None
        );
    }

    #[test]
    fn a_length_macos_will_not_state_is_a_refusal_and_names_the_reason() {
        let refusal = unreadable_duration_message(REAL_AFINFO_UNOPENABLE_STDERR);
        assert!(
            refusal.contains("could not determine the length"),
            "{refusal}"
        );
        assert!(refusal.contains("will not decode it"), "{refusal}");
        assert!(refusal.contains("AudioFileOpenURL failed"), "{refusal}");
        // Nothing on stderr still refuses; it just has less to say.
        let quiet = unreadable_duration_message("   \n\n");
        assert!(quiet.contains("could not determine the length"), "{quiet}");
        assert!(quiet.ends_with("will not decode it."), "{quiet}");
    }

    #[test]
    fn webm_is_no_longer_offered_because_coreaudio_cannot_open_it() {
        assert!(!SUPPORTED_IMPORT_EXTENSIONS.contains(&"webm"));
        let refused = validate_import_extension(Path::new("/tmp/call.webm")).unwrap_err();
        assert!(refused.contains(".webm"), "{refused}");
        assert!(!supported_extensions_sentence().contains("webm"));
        // Ogg stays: CoreAudio does read it.
        assert!(SUPPORTED_IMPORT_EXTENSIONS.contains(&"ogg"));
    }

    #[test]
    fn the_conversion_timeout_scales_with_the_source_but_never_goes_below_a_minute() {
        use std::time::Duration;
        // Short files get the floor, not two seconds.
        assert_eq!(import_conversion_timeout(1.0), Duration::from_secs(60));
        assert_eq!(import_conversion_timeout(29.9), Duration::from_secs(60));
        // At 30 s the doubling takes over exactly.
        assert_eq!(import_conversion_timeout(30.0), Duration::from_secs(60));
        assert_eq!(import_conversion_timeout(45.0), Duration::from_secs(90));
        // A four-hour file, the longest import allowed, gets eight hours.
        assert_eq!(
            import_conversion_timeout(MAX_IMPORT_DURATION_SECONDS),
            Duration::from_secs(8 * 60 * 60)
        );
        // A length that is not a length still bounds the wait.
        assert_eq!(import_conversion_timeout(0.0), Duration::from_secs(60));
        assert_eq!(import_conversion_timeout(-5.0), Duration::from_secs(60));
        assert_eq!(import_conversion_timeout(f64::NAN), Duration::from_secs(60));
        assert_eq!(
            import_conversion_timeout(f64::INFINITY),
            Duration::from_secs(60)
        );

        let message = conversion_timeout_message(Duration::from_secs(90));
        assert!(message.contains("90 seconds"), "{message}");
        assert!(message.contains("network volume"), "{message}");
    }

    #[test]
    fn the_space_estimate_charges_the_converted_wav_plus_a_margin() {
        // One hour of 16 kHz mono 16-bit is 115.2 MB.
        assert_eq!(
            import_conversion_bytes_needed(3600.0),
            3600 * 32_000 + IMPORT_SPACE_MARGIN_BYTES
        );
        // Even a zero-length file is charged the margin, so a full disk is
        // caught before afconvert is spawned at all.
        assert_eq!(
            import_conversion_bytes_needed(0.0),
            IMPORT_SPACE_MARGIN_BYTES
        );

        let needed = import_conversion_bytes_needed(3600.0);
        assert_eq!(import_space_shortfall(3600.0, Some(needed)), None);
        assert_eq!(
            import_space_shortfall(3600.0, Some(needed - 1)),
            Some(needed)
        );
        // Unmeasurable free space leaves the import unpreflighted, not refused.
        assert_eq!(import_space_shortfall(3600.0, None), None);

        let message = insufficient_space_message(needed);
        assert!(message.contains("not enough free space"), "{message}");
        assert!(message.contains("GB free"), "{message}");
    }

    #[test]
    fn import_title_comes_from_the_file_name_and_never_from_nowhere() {
        assert_eq!(
            import_title_from_file_name(Path::new("/tmp/Q3 planning call.m4a")),
            "Q3 planning call"
        );
        // Whitespace is collapsed, control characters cannot break the title.
        assert_eq!(
            import_title_from_file_name(Path::new("/tmp/weekly\tsync   notes.mp3")),
            "weekly sync notes"
        );
        // A dotfile has no extension as far as the OS is concerned, so its
        // whole name is the title. That is still what the file is called.
        assert_eq!(import_title_from_file_name(Path::new("/tmp/.wav")), ".wav");
        // A name that leaves nothing usable falls back rather than inventing.
        assert_eq!(
            import_title_from_file_name(Path::new("/tmp/   .mp3")),
            "Imported audio"
        );
        // Long names are cut, not rejected.
        let long = "a".repeat(400);
        let title = import_title_from_file_name(Path::new(&format!("/tmp/{long}.wav")));
        assert_eq!(title.chars().count(), 120);
    }
}
