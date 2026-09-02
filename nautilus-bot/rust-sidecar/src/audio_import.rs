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
pub(crate) const SUPPORTED_IMPORT_EXTENSIONS: &[&str] =
    &["wav", "mp3", "m4a", "aac", "mp4", "webm", "ogg", "flac"];

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
/// `afinfo` prints a human report, not JSON; the one line worth reading is
/// `estimated duration: 2.000000 sec`. Returning `None` for anything else
/// keeps a format change from being read as "zero seconds".
pub(crate) fn parse_afinfo_duration_seconds(output: &str) -> Option<f64> {
    for line in output.lines() {
        let lowered = line.trim().to_ascii_lowercase();
        let Some(rest) = lowered.strip_prefix("estimated duration:") else {
            continue;
        };
        let value = rest.trim().trim_end_matches("sec").trim();
        if let Ok(seconds) = value.parse::<f64>() {
            return Some(seconds);
        }
    }
    None
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

    #[test]
    fn afinfo_duration_is_read_from_the_line_that_states_it() {
        let output = "File:           sample.wav\n\
             File type ID:   WAVE\n\
             ----\n\
             Data format:     2 ch,  44100 Hz, Int16, interleaved\n\
             estimated duration: 3721.500000 sec\n\
             audio bytes: 352800\n";
        assert_eq!(parse_afinfo_duration_seconds(output), Some(3721.5));
        // A report without the line is unknown, not zero.
        assert_eq!(parse_afinfo_duration_seconds("File: broken.mp3\n"), None);
        assert_eq!(parse_afinfo_duration_seconds(""), None);
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
