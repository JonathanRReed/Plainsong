use plainsong_lib::dictation_pipeline::{apply_dictation_pipeline, DictationPipelineInput};
use plainsong_lib::text::format::DictationAppCategory;

fn format(text: &str, digits: bool) -> String {
    apply_dictation_pipeline(DictationPipelineInput {
        text,
        spoken_language: Some("en"),
        dictionary_entries: &[],
        snippets: &[],
        app_target: Some("Capture Pad"),
        mode_preset: "voice",
        smart_formatting_enabled: false,
        clean_disfluencies: false,
        numbers_as_digits: digits,
        recent_inserted_text: None,
        command_mode_enabled: false,
        destination_category: DictationAppCategory::Other,
        structured_layout: false,
    })
    .text
}

#[test]
fn voice_digits_table() {
    for (source, expected) in [
        ("eighteen point five percent", "18.5%"),
        ("three point two million dollars", "$3.2 million"),
        ("twelve hundred dollars", "$1,200"),
        ("two point five dollars", "$2.50"),
        ("twelve dollars fifty", "$12.50"),
        ("I paid six pounds and eight pence", "I paid £6.08"),
        (
            "four one five-five five five zero one nine eight",
            "415-555-0198",
        ),
        (
            "four one five five five five zero one nine eight",
            "415-555-0198",
        ),
        ("call me at six thirty", "call me at 6:30"),
        ("Call me at 6.30.", "Call me at 6:30."),
        ("Call me at $6.30.", "Call me at $6.30."),
        ("Sold the call at 1.20.", "Sold the call at 1.20."),
        (
            "Version 3.11 is out. Call me at 6.30.",
            "Version 3.11 is out. Call me at 6.30.",
        ),
        ("two pm", "2 pm"),
        ("at five o'clock", "at 5 o'clock"),
        ("all twenty laptops", "all 20 laptops"),
        ("three laptops", "3 laptops"),
        ("two kilograms", "2 kilograms"),
        ("one meter", "1 meter"),
        ("three point five millimeters", "3.5 millimeters"),
        ("on March third twenty twenty seven", "on March 3, 2027"),
        ("in nineteen ninety nine", "in 1999"),
        ("version three point two point one", "version 3.2.1"),
        ("version three point eleven", "version 3.11"),
        ("version three point zero five", "version 3.05"),
        ("the twenty first floor", "the 21st floor"),
        ("twenty to thirty laptops", "20 to 30 laptops"),
        ("two to three million dollars", "$2 million to $3 million"),
        ("two people and twenty laptops", "two people and 20 laptops"),
        ("1, 2, or 3 dollars", "1, 2, or 3 dollars"),
        ("2 people and twenty laptops", "two people and 20 laptops"),
        ("one of the reasons", "one of the reasons"),
        ("1 of the reasons", "one of the reasons"),
        ("zero chance", "zero chance"),
        ("one of them", "one of them"),
        ("the two of us", "the two of us"),
        ("a one-off", "a one-off"),
        ("one or two", "one or two"),
        ("two thirds of a cup", "two thirds of a cup"),
        ("two and a half cups", "two and a half cups"),
        ("Python three point eleven", "Python three point eleven"),
        ("ten oh fifteen", "ten oh fifteen"),
        ("a hundred percent sure", "a hundred percent sure"),
        ("number one priority", "number one priority"),
        ("first", "first"),
        (
            "One Direction and Seven Oaks",
            "One Direction and Seven Oaks",
        ),
        (
            "not eighteen point five percent unless twenty laptops arrive",
            "not 18.5% unless 20 laptops arrive",
        ),
        ("$1,200 and 18.5% at 3:30", "$1,200 and 18.5% at 3:30"),
        ("+1 555 0100", "+1 555 0100"),
        ("plus one five five five zero one zero zero", "+1 555-0100"),
        (
            "plus one four one five five five five zero one nine eight",
            "+1 415-555-0198",
        ),
        ("1st", "first"),
        ("5. Review\n6. Ship", "5. Review\n6. Ship"),
        ("9 a.m.", "9 a.m."),
        ("version 3.2.1", "version 3.2.1"),
        (
            "https://example.com/v3 and config_v2.yaml",
            "https://example.com/v3 and config_v2.yaml",
        ),
    ] {
        let actual = format(source, true);
        assert_eq!(actual, expected, "{source}");
        assert_eq!(format(&actual, true), actual, "idempotence: {source}");
    }
}

#[test]
fn voice_words_table() {
    for (source, expected) in [
        ("20 laptops", "twenty laptops"),
        ("2 people", "two people"),
        ("$1,200", "one thousand two hundred dollars"),
        ("$12.50", "twelve dollars and fifty cents"),
        ("$3.2 million", "three point two million dollars"),
        ("€1.01", "one euro and one cent"),
        ("£6.08", "six pounds and eight pence"),
        ("18.5%", "eighteen point five percent"),
        ("3:30", "three thirty"),
        ("Call me at 6.30.", "Call me at six thirty."),
        ("9:05am", "nine oh five am"),
        ("14:00 UTC", "fourteen hundred UTC"),
        ("March 3, 2027", "March three, two thousand twenty seven"),
        (
            "415-555-0198",
            "four one five five five five zero one nine eight",
        ),
        ("+1 555 0100", "plus one five five five zero one zero zero"),
        ("21st", "twenty first"),
        ("1st", "first"),
        ("20-30 laptops", "twenty-thirty laptops"),
        ("1999", "one thousand nine hundred ninety nine"),
        ("version 3.2.1", "version three point two point one"),
        ("version 3.11", "version three point eleven"),
        ("3.05 kilograms", "three point zero five kilograms"),
        ("3kg", "three kg"),
        ("3.05kg", "three point zero five kg"),
        (
            "03/04/2027",
            "zero three slash zero four slash two thousand twenty seven",
        ),
        (
            "2027-03-04",
            "two thousand twenty seven-zero three-zero four",
        ),
        ("555-0100", "five five five zero one zero zero"),
        (
            "+1 415-555-0198",
            "plus one four one five five five five zero one nine eight",
        ),
        ("5. Review\n6. Ship", "5. Review\n6. Ship"),
        ("-12.5 degrees", "minus twelve point five degrees"),
        (
            "not 20 laptops unless 2 people agree",
            "not twenty laptops unless two people agree",
        ),
        (
            "twenty laptops and eighteen point five percent",
            "twenty laptops and eighteen point five percent",
        ),
        (
            "https://example.com/v3 and config_v2.yaml",
            "https://example.com/v3 and config_v2.yaml",
        ),
    ] {
        let actual = format(source, false);
        assert_eq!(actual, expected, "{source}");
        assert_eq!(format(&actual, false), actual, "idempotence: {source}");
    }
}

#[test]
fn voice_default_and_explicit_words_survive_settings_round_trip() {
    use plainsong_lib::settings::{default_dictation_numbers_as_digits, Settings};
    for (json, expected) in [
        (r#"{}"#, true),
        (r#"{"transcription":{"dictationNumbersAsDigits":{}}}"#, true),
        (
            r#"{"transcription":{"dictationNumbersAsDigits":{"voice":false}}}"#,
            false,
        ),
        (
            r#"{"transcription":{"dictationNumbersAsDigits":{"voice":true}}}"#,
            true,
        ),
    ] {
        let parsed: Settings = serde_json::from_str(json).unwrap();
        let restored: Settings =
            serde_json::from_str(&serde_json::to_string(&parsed).unwrap()).unwrap();
        let digits = restored
            .transcription
            .dictation_numbers_as_digits
            .get("voice")
            .copied()
            .unwrap_or_else(|| default_dictation_numbers_as_digits("voice"));
        assert_eq!(digits, expected, "{json}");
    }
}

#[test]
fn numeric_corrections_keep_negation_and_conditions() {
    for (source, expected) in [
        ("Call me at five, no wait, six thirty.", "Call me at 6:30."),
        (
            "Do not call me at six thirty unless I confirm.",
            "Do not call me at 6:30 unless I confirm.",
        ),
        (
            "Not twelve dollars, no wait, twenty dollars unless approved.",
            "Not $12, no wait, $20 unless approved.",
        ),
    ] {
        let mut input = DictationPipelineInput {
            text: source,
            spoken_language: Some("en"),
            dictionary_entries: &[],
            snippets: &[],
            app_target: Some("Capture Pad"),
            mode_preset: "voice",
            smart_formatting_enabled: true,
            clean_disfluencies: true,
            numbers_as_digits: true,
            recent_inserted_text: None,
            command_mode_enabled: false,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        };
        assert_eq!(apply_dictation_pipeline(input).text, expected, "{source}");
        input = DictationPipelineInput {
            text: source,
            spoken_language: Some("en"),
            dictionary_entries: &[],
            snippets: &[],
            app_target: Some("Capture Pad"),
            mode_preset: "voice",
            smart_formatting_enabled: true,
            clean_disfluencies: true,
            numbers_as_digits: false,
            recent_inserted_text: None,
            command_mode_enabled: false,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        };
        let words = apply_dictation_pipeline(input).text;
        assert!(!words.chars().any(|c| c.is_ascii_digit()), "{words}");
        assert_eq!(words.starts_with("Do not"), expected.starts_with("Do not"));
        assert_eq!(words.contains("unless"), expected.contains("unless"));
    }
}

#[test]
fn preferences_protect_dictionary_and_snippet_text() {
    use plainsong_lib::text::itn::{
        numbers_as_words_protecting, voice_numbers_as_digits_protecting,
    };
    for source in [
        "Route 66 and twenty laptops",
        "Route sixty six and twenty laptops",
    ] {
        let phrase = source.split(" and ").next().unwrap().to_string();
        assert!(
            numbers_as_words_protecting(source, std::slice::from_ref(&phrase)).starts_with(&phrase)
        );
        assert!(
            voice_numbers_as_digits_protecting(source, std::slice::from_ref(&phrase), true)
                .starts_with(&phrase)
        );
    }
    for (source, expected) in [
        ("twenty\nfive dollars", "20\n$5"),
        ("twenty\r\nfive dollars", "20\r\n$5"),
    ] {
        assert_eq!(
            voice_numbers_as_digits_protecting(source, &[], true),
            expected
        );
    }
    assert_eq!(
        numbers_as_words_protecting("20\n5 dollars", &[]),
        "twenty\nfive dollars"
    );
}

#[test]
fn preferences_skip_code_and_non_english_dictation() {
    for category in [
        DictationAppCategory::CodeEditor,
        DictationAppCategory::AiChat,
    ] {
        for digits in [true, false] {
            let source = "version three point eleven and 20 laptops";
            let actual = apply_dictation_pipeline(DictationPipelineInput {
                text: source,
                spoken_language: Some("en"),
                dictionary_entries: &[],
                snippets: &[],
                app_target: None,
                mode_preset: "voice",
                smart_formatting_enabled: false,
                clean_disfluencies: false,
                numbers_as_digits: digits,
                recent_inserted_text: None,
                command_mode_enabled: false,
                destination_category: category,
                structured_layout: false,
            })
            .text;
            assert_eq!(actual, source);
        }
    }
    for digits in [true, false] {
        let source = "Wir brauchen 20 Laptops und zwei Leute.";
        let actual = apply_dictation_pipeline(DictationPipelineInput {
            text: source,
            spoken_language: Some("de"),
            dictionary_entries: &[],
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: false,
            clean_disfluencies: false,
            numbers_as_digits: digits,
            recent_inserted_text: None,
            command_mode_enabled: false,
            destination_category: DictationAppCategory::Other,
            structured_layout: false,
        })
        .text;
        assert_eq!(actual, source);
    }
}
