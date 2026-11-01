use super::*;
use crate::text::format::DictationAppCategory;

fn entry(spoken: &str, replacement: &str) -> DictationDictionaryEntry {
    DictationDictionaryEntry {
        id: replacement.to_string(),
        spoken_form: spoken.to_string(),
        replacement: replacement.to_string(),
        app_scope: None,
        case_sensitive: false,
        enabled: true,
        category_scope: None,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
    }
}

fn term(text: &str) -> AcousticVocabularyTerm {
    AcousticVocabularyTerm {
        text: text.to_string(),
        spoken: Vec::new(),
        built_in: false,
    }
}

fn built_in_term(text: &str) -> AcousticVocabularyTerm {
    AcousticVocabularyTerm {
        built_in: true,
        ..term(text)
    }
}

/// `accept` with the shipped floors.
fn accept(
    raw: &str,
    candidates: &[VocabularyCandidate],
    requested: &[AcousticVocabularyTerm],
) -> Vec<Accepted> {
    super::accept(raw, candidates, requested, &FLOORS)
}

fn candidate(heard: &str, term: &str, similarity: f32, margin: f32) -> VocabularyCandidate {
    VocabularyCandidate {
        term: term.to_string(),
        heard: heard.to_string(),
        word_start: 0,
        word_end: heard.split_whitespace().count(),
        similarity,
        term_score: Some(-7.0 + margin),
        heard_score: Some(-7.0),
        best_path_score: Some(-0.5),
        spoken_form: None,
        ctc_heard: None,
    }
}

fn inputs<'a>(
    dictionary: &'a [DictationDictionaryEntry],
    screen_terms: &'a [String],
    built_in: bool,
) -> Inputs<'a> {
    Inputs {
        dictionary,
        app_target: None,
        category: DictationAppCategory::Other,
        calendar_names: &[],
        contact_names: &[],
        screen_terms,
        built_in,
    }
}

fn words_available() -> bool {
    std::path::Path::new("/usr/share/dict/words").exists()
}

#[test]
fn gazetteer_parses_terms_and_spoken_forms() {
    assert!(gazetteer_version() >= 1);
    let parsed = parse_gazetteer("# header\nSupabase | soo pa base\n\nOllama\n");
    assert_eq!(
        parsed,
        vec![
            ("Supabase".to_string(), vec!["soo pa base".to_string()]),
            ("Ollama".to_string(), Vec::new()),
        ]
    );
    let built_in = parse_gazetteer(GAZETTEER);
    assert!(built_in.len() > 100 && built_in.len() <= MAX_TERMS);
    for (text, spoken) in &built_in {
        assert!(text.chars().count() <= 64, "{text}");
        assert!(spoken.len() <= 4, "{text}");
    }
}

#[test]
fn dictionary_comes_first_and_lends_spoken_forms() {
    let mut older = entry("", "Okafor");
    older.updated_at -= chrono::Duration::days(1);
    let dictionary = [older, entry("shiv awn", "Siobhan")];
    let screen = vec!["Okafor".to_string(), "Xiomara".to_string()];
    let list = build(&inputs(&dictionary, &screen, false));
    let texts: Vec<&str> = list.iter().map(|term| term.text.as_str()).collect();
    assert_eq!(texts[..3], ["Siobhan", "Okafor", "Xiomara"]);
    assert_eq!(list[0].spoken[0], "shiv awn");
    // Built-in off adds no new terms.
    assert_eq!(list.len(), 3);
}

#[test]
fn disabled_and_out_of_scope_entries_are_left_out() {
    let mut disabled = entry("", "Siobhan");
    disabled.enabled = false;
    let mut scoped = entry("", "Okafor");
    scoped.app_scope = Some("com.example.other".to_string());
    let list = build(&inputs(&[disabled, scoped], &[], false));
    assert!(list.is_empty());
}

#[test]
fn list_is_capped_and_built_in_fills_the_rest() {
    let screen: Vec<String> = (0..MAX_TERMS + 50).map(|n| format!("Zqx{n}name")).collect();
    let list = build(&inputs(&[], &screen, true));
    assert_eq!(list.len(), MAX_TERMS);
    let list = build(&inputs(&[], &[], true));
    assert!(list.iter().any(|term| term.text == "Supabase"));
}

#[test]
fn single_ordinary_words_are_not_terms() {
    if !words_available() {
        return;
    }
    assert!(!eligible("call"));
    assert!(!eligible("overall"));
    assert!(!eligible("ab"));
    assert!(eligible("Supabase"));
    assert!(eligible("Hugging Face"));
}

#[test]
fn accepts_unknown_words_the_audio_prefers() {
    if !words_available() {
        return;
    }
    let requested = [term("Supabase"), term("Postgres")];
    let accepted = accept(
        "",
        &[
            candidate("Superbase", "Supabase", 0.78, 0.4),
            // The term fits the audio far worse than what was heard.
            candidate("Postbass", "Postgres", 0.62, -2.5),
        ],
        &requested,
    );
    assert_eq!(
        accepted,
        vec![Accepted {
            heard: "Superbase".into(),
            term: "Supabase".into()
        }]
    );
}

#[test]
fn ordinary_words_numbers_and_negations_are_never_replaced() {
    if !words_available() {
        return;
    }
    let requested = [
        term("Carla"),
        term("Vercel"),
        term("Nott"),
        term("Tenzin"),
        term("Metabase"),
        term("Eamon"),
    ];
    let accepted = accept(
        "",
        &[
            candidate("call", "Carla", 0.6, 5.0),
            candidate("overall", "Vercel", 0.7, 5.0),
            // Newer than the system word list, and an acronym.
            candidate("database", "Metabase", 0.75, 5.0),
            candidate("API", "Eamon", 0.6, 5.0),
            candidate("not", "Nott", 0.9, 5.0),
            candidate("10", "Tenzin", 0.9, 5.0),
            candidate("don't", "Tenzin", 0.9, 5.0),
        ],
        &requested,
    );
    assert!(accepted.is_empty(), "{accepted:?}");
}

#[test]
fn known_names_need_a_clear_margin() {
    if !words_available() {
        return;
    }
    let requested = [term("Dana")];
    let raw = "Second, call Donna. Donna said yes.";
    let at = |start: usize, margin: f32| {
        let mut found = candidate("Donna.", "Dana", 0.6, margin);
        found.word_start = start;
        found.word_end = start + 1;
        found
    };
    assert!(accept(raw, &[at(2, 0.5)], &requested).is_empty());
    assert_eq!(
        accept(raw, &[at(2, 1.8)], &requested),
        vec![Accepted {
            heard: "Donna".into(),
            term: "Dana".into()
        }]
    );
    // At a sentence start, or where the positions no longer match, the
    // capital says nothing and "donna" is an ordinary word in the list.
    assert!(accept(raw, &[at(3, 1.8)], &requested).is_empty());
    assert!(accept(raw, &[at(0, 1.8)], &requested).is_empty());
    assert!(accept("call donna", &[at(1, 1.8)], &requested).is_empty());
}

#[test]
fn built_in_terms_need_stronger_evidence() {
    if !words_available() {
        return;
    }
    let requested = [built_in_term("Supabase")];
    // A user's term would pass on these; a built-in one needs the audio to
    // prefer it and a closer spelling.
    assert!(accept(
        "",
        &[candidate("Superbase", "Supabase", 0.78, -0.4)],
        &requested
    )
    .is_empty());
    assert!(accept(
        "",
        &[candidate("Zqxbase", "Supabase", 0.65, 0.5)],
        &requested
    )
    .is_empty());
    assert_eq!(
        accept(
            "",
            &[candidate("Superbase", "Supabase", 0.78, 0.3)],
            &requested
        ),
        vec![Accepted {
            heard: "Superbase".into(),
            term: "Supabase".into()
        }]
    );
    // Never over a name the word list knows, however clear the margin.
    let raw = "Second, call Donna. Donna said yes.";
    let mut donna = candidate("Donna.", "Dana", 0.75, 5.0);
    donna.word_start = 2;
    donna.word_end = 3;
    assert!(accept(raw, &[donna], &[built_in_term("Dana")]).is_empty());
}

#[test]
fn a_part_of_a_closer_longer_match_is_left_alone() {
    if !words_available() {
        return;
    }
    let requested = [term("Malgorzata")];
    let mut whole = candidate("Mel Gorzata", "Malgorzata", 0.9, 0.2);
    whole.word_start = 2;
    whole.word_end = 4;
    let mut part = candidate("Gorzata", "Malgorzata", 0.7, 0.0);
    part.word_start = 3;
    part.word_end = 4;
    // The word list knows "Mel", and the margin is too small to replace a
    // known word, so the whole stretch is refused too.
    assert!(accept("Wojciech asked Mel Gorzata to", &[whole, part], &requested).is_empty());
}

#[test]
fn a_heard_listed_term_is_kept() {
    let requested = [term("Dana"), term("Donna")];
    assert!(accept("", &[candidate("Donna", "Dana", 0.6, 3.0)], &requested).is_empty());
}

#[test]
fn user_terms_need_evidence_over_the_exact_replacement_span() {
    if !words_available() {
        return;
    }
    let requested = [AcousticVocabularyTerm {
        text: "Siobhan".into(),
        spoken: vec!["shiv awn".into()],
        built_in: false,
    }];
    let mut shivan = candidate("Shivan and", "Siobhan", 0.6, 1.0);
    shivan.spoken_form = Some("shiv awn".into());
    assert!(accept("", &[shivan], &requested).is_empty());
    let mut exact = candidate("Shivan", "Siobhan", 0.6, 1.0);
    exact.spoken_form = Some("shiv awn".into());
    assert_eq!(accept("", &[exact], &requested).len(), 1);
    // "from Johns Hopkins" trims to the term itself: nothing to change.
    let requested = [term("Johns Hopkins")];
    assert!(accept(
        "",
        &[candidate("from Johns Hopkins", "Johns Hopkins", 0.72, 0.3)],
        &requested
    )
    .is_empty());
}

#[test]
fn unrequested_terms_and_weak_matches_are_ignored() {
    let requested = [term("Supabase")];
    assert!(accept("", &[candidate("Zqxbase", "Ollama", 0.9, 3.0)], &requested).is_empty());
    assert!(accept(
        "",
        &[candidate("Zqxbase", "Supabase", 0.5, 3.0)],
        &requested
    )
    .is_empty());
    let mut unscored = candidate("Zqxbase", "Supabase", 0.9, 3.0);
    unscored.term_score = None;
    assert!(accept("", &[unscored], &requested).is_empty());
}

#[test]
fn overlapping_candidates_keep_the_better_margin() {
    if !words_available() {
        return;
    }
    let requested = [term("Zqxalpha"), term("Zqxbeta")];
    let mut first = candidate("Zqxalfa", "Zqxalpha", 0.8, 0.5);
    let mut second = candidate("Zqxalfa", "Zqxbeta", 0.8, 1.5);
    first.word_start = 2;
    first.word_end = 3;
    second.word_start = 2;
    second.word_end = 3;
    assert_eq!(
        accept("", &[first, second], &requested),
        vec![Accepted {
            heard: "Zqxalfa".into(),
            term: "Zqxbeta".into()
        }]
    );
}

#[test]
fn apply_replaces_a_single_whole_word_occurrence() {
    let accepted = [Accepted {
        heard: "Superbase".into(),
        term: "Supabase".into(),
    }];
    let (text, applied) = apply("We moved to superbase, finally.", &accepted, &[]);
    assert_eq!(text, "We moved to Supabase, finally.");
    assert_eq!(applied, vec!["Supabase".to_string()]);
    // Inside a longer word, repeated, or already rewritten: left alone.
    for original in [
        "Superbases are fine.",
        "Superbase or Superbase.",
        "We moved to Supabase.",
    ] {
        let (text, applied) = apply(original, &accepted, &[]);
        assert_eq!(text, original);
        assert!(applied.is_empty());
    }
}

#[test]
fn apply_skips_protected_dictionary_output() {
    let accepted = [Accepted {
        heard: "Shivan".into(),
        term: "Siobhan".into(),
    }];
    let (text, applied) = apply("Ask Shivan Ltd.", &accepted, &["Shivan Ltd".to_string()]);
    assert_eq!(text, "Ask Shivan Ltd.");
    assert!(applied.is_empty());
}

#[test]
fn apply_handles_multi_word_terms_and_several_edits() {
    let accepted = [
        Accepted {
            heard: "Okafa".into(),
            term: "Okafor".into(),
        },
        Accepted {
            heard: "Hugging Fays".into(),
            term: "Hugging Face".into(),
        },
    ];
    let (text, applied) = apply("Doctor Okafa uses Hugging\nFays daily.", &accepted, &[]);
    assert_eq!(text, "Doctor Okafor uses Hugging Face daily.");
    assert_eq!(
        applied,
        vec!["Okafor".to_string(), "Hugging Face".to_string()]
    );
}

#[test]
fn pipeline_stage_records_the_change() {
    if !words_available() {
        return;
    }
    let mut result = crate::dictation_pipeline::DictationPipelineResult {
        text: "Send it to Zqxbase.".into(),
        command_applied: None,
        dictionary_applied_count: 0,
        applied_dictionary_replacements: Vec::new(),
        snippet_applied_count: 0,
        formatting_applied: true,
        recent_insert_reused: false,
        pipeline_stage_keys: Vec::new(),
        undo_previous_insert: false,
        english_rules: true,
    };
    let requested = [term("Supabase")];
    apply_to_pipeline_result(
        &mut result,
        "Send it to Zqxbase.",
        &[candidate("Zqxbase.", "Supabase", 0.7, 1.0)],
        &requested,
    );
    assert_eq!(result.text, "Send it to Supabase.");
    assert_eq!(result.dictionary_applied_count, 1);
    assert_eq!(result.applied_dictionary_replacements, vec!["Supabase"]);
    assert_eq!(result.pipeline_stage_keys, vec!["vocabulary_spelling"]);

    let mut other_language = result.clone();
    other_language.text = "Envíalo a Zqxbase.".into();
    other_language.english_rules = false;
    apply_to_pipeline_result(
        &mut other_language,
        "Envíalo a Zqxbase.",
        &[candidate("Zqxbase.", "Supabase", 0.7, 1.0)],
        &requested,
    );
    assert_eq!(other_language.text, "Envíalo a Zqxbase.");
}

#[test]
fn contact_names_put_unusual_spellings_first_and_leave_room() {
    if !words_available() {
        return;
    }
    // Hundreds of names the word list knows, then one it does not.
    let words = std::fs::read_to_string("/usr/share/dict/words").unwrap_or_default();
    let mut contacts: Vec<String> = std::iter::once("Michael".to_string())
        .chain(
            words
                .lines()
                .filter(|word| {
                    word.len() >= 4 && word.starts_with(|ch: char| ch.is_ascii_uppercase())
                })
                .take(400)
                .map(str::to_string),
        )
        .collect();
    contacts.push("Siobhan".to_string());
    let screen = vec!["Kubernetes".to_string()];
    let list = build(&Inputs {
        contact_names: &contacts,
        ..inputs(&[], &screen, true)
    });
    let position = |text: &str| list.iter().position(|term| term.text == text);
    // Michael is in the word list; Siobhan is not, so it is scored first.
    assert!(position("Siobhan").unwrap() < position("Michael").unwrap_or(usize::MAX));
    assert!(list.len() <= MAX_TERMS);
    let from_contacts = list
        .iter()
        .filter(|term| !term.built_in && contacts.contains(&term.text))
        .count();
    assert!(from_contacts <= MAX_CONTACT_TERMS);
    assert!(position("Kubernetes").is_some());
}

#[test]
fn contact_names_are_trimmed_and_capped_when_set() {
    set_contact_names(vec![" Aoife ".to_string(), String::new(), "x".repeat(65)]);
    assert_eq!(contact_name_count(), 1);
    set_contact_names(Vec::new());
    assert_eq!(contact_name_count(), 0);
}

fn at(mut found: VocabularyCandidate, start: usize) -> VocabularyCandidate {
    let words = found.word_end - found.word_start;
    found.word_start = start;
    found.word_end = start + words;
    found
}

#[test]
fn user_terms_get_respellings_and_built_in_terms_do_not() {
    let dictionary = [
        entry("", "Szymon"),
        entry("", "Niamh"),
        entry("", "Jonathan"),
    ];
    let list = build(&inputs(&dictionary, &[], true));
    let spoken = |text: &str| {
        list.iter()
            .find(|term| term.text == text)
            .map(|term| term.spoken.clone())
            .unwrap_or_default()
    };
    assert_eq!(spoken("Szymon"), ["shimon"]);
    assert_eq!(spoken("Niamh"), ["neev"]);
    assert!(spoken("Jonathan").is_empty());
    assert!(list
        .iter()
        .filter(|term| term.built_in)
        .all(|term| !term.spoken.iter().any(|form| form == "shimon")));
}

#[test]
fn a_respelled_term_needs_less_spelling_similarity() {
    if !words_available() {
        return;
    }
    // "Ifa" is how an English recognizer writes Aoife: 0.5 is below the
    // ordinary floor, but the heard word sounds like the respelling "eefa".
    let raw = "Share the slides with Ifa before lunch.";
    let ifa = at(candidate("Ifa", "Aoife", 0.5, 0.3), 4);
    assert_eq!(
        accept(raw, &[ifa], &[term("Aoife")]),
        vec![Accepted {
            heard: "Ifa".into(),
            term: "Aoife".into()
        }]
    );
    // Consonants alone are not enough: "Lindy" has a syllable fewer than
    // Lindiwe, which has no other spelling rules to go by.
    let raw = "Did he send the contract to Lindy yet?";
    let lindy = at(candidate("Lindy", "Lindiwe", 0.57, -0.9), 6);
    assert!(accept(raw, &[lindy], &[term("Lindiwe")]).is_empty());
    // "Lindy" is an English pet form of Linda, so it counts as a name the
    // speaker may have said: a closer spelling with mildly better audio is
    // still not enough.
    let lindy = at(candidate("Lindy", "Lindiwe", 0.65, 0.5), 6);
    assert!(accept(raw, &[lindy], &[term("Lindiwe")]).is_empty());
}

#[test]
fn a_respelled_term_replaces_a_known_name_only_when_the_audio_does_not_prefer_it() {
    if !words_available() {
        return;
    }
    let raw = "Ask Kieran to sign the lease.";
    let kieran = |margin: f32| at(candidate("Kieran", "Ciarán", 0.71, margin), 1);
    assert_eq!(
        accept(raw, &[kieran(0.15)], &[term("Ciarán")]),
        vec![Accepted {
            heard: "Kieran".into(),
            term: "Ciarán".into()
        }]
    );
    // An English "Simon" said aloud: the audio prefers it over "shimon".
    assert!(accept(raw, &[kieran(-0.4)], &[term("Ciarán")]).is_empty());
    let raw = "Then Simon will drive us.";
    let simon = at(candidate("Simon", "Szymon", 0.83, -0.4), 1);
    assert!(accept(raw, &[simon], &[term("Szymon")]).is_empty());
    // A name with an English spelling keeps the ordinary known-name floor.
    let raw = "Ask Mark whether Tom can cover.";
    let mark = at(candidate("Mark", "Marek", 0.8, 0.5), 1);
    assert!(accept(raw, &[mark], &[term("Marek")]).is_empty());
}

#[test]
fn a_multi_word_name_keeps_the_words_heard_right() {
    if !words_available() {
        return;
    }
    // "yang" is an ordinary word, but here it is the name's own second word,
    // so only "Lu" is being replaced.
    let raw = "Zhang Wei sent the contract to Lu Yang this morning.";
    let lu_yang = |margin: f32| at(candidate("Lu Yang", "Liu Yang", 0.86, margin), 6);
    assert_eq!(
        accept(raw, &[lu_yang(0.15)], &[term("Liu Yang")]),
        vec![Accepted {
            heard: "Lu Yang".into(),
            term: "Liu Yang".into()
        }]
    );
    assert!(accept(raw, &[lu_yang(-0.3)], &[term("Liu Yang")]).is_empty());
    // A different word beside the right one is still checked.
    let raw = "We moved to Mark Train today.";
    let train = at(candidate("Mark Train", "Mark Twain", 0.8, 3.0), 3);
    assert!(accept(raw, &[train], &[term("Mark Twain")]).is_empty());
}

#[test]
fn sound_matches_never_replace_ordinary_words_numbers_or_negations() {
    if !words_available() {
        return;
    }
    // "neve" is an ordinary word (granular snow), however much it sounds
    // like Niamh.
    let raw = "Can you ask Neve to share the slides?";
    let neve = at(candidate("Neve", "Niamh", 0.5, 3.0), 3);
    assert!(accept(raw, &[neve], &[term("Niamh")]).is_empty());
    for (heard, name) in [("not", "Nóta"), ("never", "Niamh"), ("10", "Tenzin")] {
        let found = at(candidate(heard, name, 0.9, 3.0), 2);
        assert!(accept("I said not now", &[found], &[term(name)]).is_empty());
    }
}

#[test]
fn preferred_spelling_restores_user_terms_without_acoustic_candidates() {
    if !words_available() {
        return;
    }
    let mut result = spelling_result();
    result.english_rules = true;
    result.text = "Use lang chain with py torch and next.js.".to_string();
    let raw = result.text.clone();
    apply_to_pipeline_result(
        &mut result,
        &raw,
        &[],
        &[term("LangChain"), term("PyTorch"), term("Next.js")],
    );
    assert_eq!(result.text, "Use LangChain with PyTorch and Next.js.");
    assert_eq!(
        result.applied_dictionary_replacements,
        vec!["LangChain", "PyTorch", "Next.js"]
    );
}

#[test]
fn preferred_spelling_leaves_near_matches_and_other_words_alone() {
    for text in [
        "Try language chains and pie torch.",
        "A slang chain and lang chains.",
        "Use lang-chain, lang\nchain and next js.",
        "LangChain's output.",
        "Use LANGCHAIN-like syntax.",
    ] {
        assert!(
            preferred_spellings(text, &[term("LangChain"), term("PyTorch"), term("Next.js")])
                .is_empty(),
            "{text}"
        );
    }
    assert!(preferred_spellings("use lang chain", &[built_in_term("LangChain")]).is_empty());
}

#[test]
fn preferred_spelling_keeps_existing_dictionary_output_and_language_guard() {
    let raw = "Use lang chain.";
    let mut result = spelling_result();
    result.english_rules = true;
    result.text = raw.to_string();
    result.applied_dictionary_replacements = vec!["lang chain".to_string()];
    apply_to_pipeline_result(&mut result, raw, &[], &[term("LangChain")]);
    assert_eq!(result.text, raw);
    result.applied_dictionary_replacements.clear();
    result.english_rules = false;
    apply_to_pipeline_result(&mut result, raw, &[], &[term("LangChain")]);
    assert_eq!(result.text, raw);
}

fn spelling_result() -> crate::dictation_pipeline::DictationPipelineResult {
    crate::dictation_pipeline::DictationPipelineResult {
        text: String::new(),
        command_applied: None,
        dictionary_applied_count: 0,
        applied_dictionary_replacements: Vec::new(),
        snippet_applied_count: 0,
        formatting_applied: false,
        recent_insert_reused: false,
        pipeline_stage_keys: Vec::new(),
        undo_previous_insert: false,
        english_rules: true,
    }
}

#[test]
fn preferred_spelling_restores_camel_case_names_but_keeps_distinct_names() {
    if !words_available() {
        return;
    }
    let found = preferred_spellings(
        "Ask Mc Kenzie about Maryann.",
        &[term("McKenzie"), term("Mary Ann")],
    );
    let (text, applied) = apply("Ask Mc Kenzie about Maryann.", &found, &[]);
    assert_eq!(text, "Ask McKenzie about Maryann.");
    assert_eq!(applied, vec!["McKenzie"]);
}

#[test]
fn preferred_spelling_never_joins_ordinary_speech_into_a_term() {
    for (raw, name) in [
        ("I phone my mother.", "iPhone"),
        ("We need no SQL here.", "NoSQL"),
        ("Keep an open ai discussion.", "OpenAI"),
        ("Find a pay pal.", "PayPal"),
        ("This is not GraphQL.", "NotGraphQL"),
    ] {
        assert!(preferred_spellings(raw, &[term(name)]).is_empty(), "{raw}");
    }
}

#[test]
fn a_user_term_cannot_beat_a_better_rejected_builtin_candidate() {
    let raw = "Ask Zorvic.";
    let mut user = candidate("Zorvic", "Zovic", 0.6, 0.2);
    user.word_start = 1;
    user.word_end = 2;
    let mut builtin = candidate("Zorvic", "Zorvik", 0.67, 0.4);
    builtin.word_start = 1;
    builtin.word_end = 2;
    let requested = [term("Zovic"), built_in_term("Zorvik")];
    assert_eq!(accept(raw, &[user.clone()], &requested).len(), 1);
    assert!(accept(raw, &[user, builtin], &requested).is_empty());
}

#[test]
fn preferred_spelling_keeps_another_listed_name() {
    let raw = "Ask Mary Ann.";
    assert!(preferred_spellings(raw, &[term("MaryAnn"), term("Mary Ann")]).is_empty());
}

#[test]
fn user_terms_cannot_replace_words_the_audio_prefers() {
    if !words_available() {
        return;
    }
    for margin in [-1.5, -0.1, 0.0, 0.05] {
        assert!(accept(
            "",
            &[candidate("Superbase", "Supabase", 0.78, margin)],
            &[term("Supabase")]
        )
        .is_empty());
    }
}

#[test]
fn weak_spelling_proposals_need_a_larger_acoustic_margin() {
    if !words_available() {
        return;
    }
    let raw = "Sarja will join us.";
    let proposed = |margin| candidate("Sarja", "Saoirse", 0.43, margin);
    assert!(accept(raw, &[proposed(0.3)], &[term("Saoirse")]).is_empty());
    assert_eq!(accept(raw, &[proposed(0.74)], &[term("Saoirse")]).len(), 1);
}

#[test]
fn calendar_contacts_and_dictionary_share_caps_without_losing_source_priority() {
    let dictionary = [entry("", "DictionaryName")];
    let calendar: Vec<String> = std::iter::once("DictionaryName".to_string())
        .chain((0..200).map(|i| format!("CalendarName{i}")))
        .collect();
    let contacts: Vec<String> = std::iter::once("CalendarName0".to_string())
        .chain((0..300).map(|i| format!("ContactName{i}")))
        .collect();
    let screen = vec!["ScreenName".to_string()];
    let list = build(&Inputs {
        calendar_names: &calendar,
        contact_names: &contacts,
        ..inputs(&dictionary, &screen, true)
    });
    assert_eq!(list[0].text, "DictionaryName");
    assert_eq!(list[1].text, "CalendarName0");
    assert_eq!(
        list.iter()
            .filter(|t| t.text.starts_with("CalendarName"))
            .count(),
        150
    );
    assert_eq!(
        list.iter()
            .filter(|t| t.text.starts_with("ContactName"))
            .count(),
        250
    );
    assert_eq!(list[401].text, "ScreenName");
    assert!(list.len() <= MAX_TERMS);
    let dictionary: Vec<_> = (0..500)
        .map(|i| entry("", &format!("DictionaryName{i}")))
        .collect();
    assert_eq!(
        build(&Inputs {
            calendar_names: &calendar,
            contact_names: &contacts,
            ..inputs(&dictionary, &screen, true)
        })
        .len(),
        MAX_TERMS
    );
}

#[test]
fn calendar_names_are_memory_only_sanitized_and_cleared_independently() {
    set_calendar_names(
        vec![
            " Siobhan ".into(),
            "siobhan".into(),
            "a@b.test".into(),
            "x".repeat(65),
        ],
        vec!["Saoirse".into()],
    );
    assert_eq!(calendar_name_count(), 1);
    assert_eq!(CALENDAR_NAMES.read().unwrap().dictation, ["Siobhan"]);
    assert_eq!(CALENDAR_NAMES.read().unwrap().meeting, ["Saoirse"]);
    set_calendar_names(Vec::new(), Vec::new());
    assert_eq!(calendar_name_count(), 0);
    assert!(CALENDAR_NAMES.read().unwrap().meeting.is_empty());
    let settings = serde_json::to_value(crate::settings::Settings::default()).unwrap();
    assert_eq!(settings["transcription"]["dictationCalendarNames"], false);
    assert_eq!(settings["transcription"]["dictationContactNames"], false);
    assert!(!settings.to_string().contains("Siobhan"));
}

#[test]
fn gazetteer_terms_reach_scoring_and_keep_negative_acoustic_evidence_unchanged() {
    let terms = build(&inputs(&[], &[], true));
    assert!(terms.iter().any(|t| t.text == "Supabase" && t.built_in));
    assert!(terms.iter().any(|t| t.text == "Ollama" && t.built_in));
    let mut proposal = candidate("Superbase", "Supabase", 0.78, -0.51);
    proposal.word_start = 1;
    proposal.word_end = 2;
    assert!(accept("Use Superbase", &[proposal], &terms).is_empty());
    let supported = at(candidate("Superbase", "Supabase", 0.78, 2.0), 1);
    assert_eq!(
        accept("Use Superbase", &[supported], &terms)[0].term,
        "Supabase"
    );
}

fn meeting_result(text: &str, segments: &[&str]) -> crate::asr::TranscriptionResult {
    crate::asr::TranscriptionResult {
        text: text.into(),
        segments: segments
            .iter()
            .enumerate()
            .map(|(index, text)| crate::asr::TranscriptSegment {
                start_time: index as f64,
                end_time: index as f64 + 1.0,
                text: (*text).into(),
                confidence: 0.9,
            })
            .collect(),
        measured_word_timestamps: true,
        speaker_turns: Vec::new(),
        language: "en".into(),
        confidence: 0.9,
        processing_time_ms: 1,
        model_name: "fake".into(),
        model_id: "fake".into(),
        requested_provider: crate::asr::AsrProviderType::Parakeet,
        actual_provider: crate::asr::AsrProviderType::Parakeet,
        requested_engine: None,
        actual_engine: None,
        optimization_applied: false,
        fallback_reason: None,
        vocabulary_hint_terms_applied: 0,
        vocabulary_candidates: Vec::new(),
    }
}

#[test]
fn local_meeting_spellings_keep_timed_segments_and_non_english_text_consistent() {
    let terms = [term("Siobhan")];
    let mut result = meeting_result("Call Shivan", &["Call", "Shivan"]);
    result.vocabulary_candidates = vec![at(candidate("Shivan", "Siobhan", 0.9, 2.0), 1)];
    let original = result.clone();
    apply_to_meeting_result(&mut result, &terms);
    assert_eq!(result.text, "Call Siobhan");
    assert_eq!(result.segments[1].text, "Siobhan");
    assert_eq!(
        result.segments[1].start_time,
        original.segments[1].start_time
    );
    assert_eq!(result.segments[1].end_time, original.segments[1].end_time);
    assert!(result.measured_word_timestamps);
    let mut french = original.clone();
    french.language = "fr".into();
    apply_to_meeting_result(&mut french, &terms);
    assert_eq!(french.text, original.text);
    let mut absent = original.clone();
    apply_to_meeting_result(&mut absent, &[]);
    assert_eq!(absent.text, original.text);
}

#[test]
fn local_meeting_spellings_do_not_join_separate_timed_segments() {
    let mut result = meeting_result("Meet Mc Kenzie", &["Meet", "Mc", "Kenzie"]);
    apply_to_meeting_result(&mut result, &[term("McKenzie")]);
    assert_eq!(result.text, "Meet Mc Kenzie");
    assert_eq!(result.segments[1].text, "Mc");
}

#[test]
fn meeting_spelling_does_not_claim_word_alignment_after_joining_words() {
    let mut result = meeting_result("Meet Mc Kenzie", &["Meet", "Mc Kenzie"]);
    apply_to_meeting_result(&mut result, &[term("McKenzie")]);
    assert_eq!(result.text, "Meet McKenzie");
    assert_eq!(result.segments[1].text, "McKenzie");
    assert!(!result.measured_word_timestamps);
}
