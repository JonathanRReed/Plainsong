import re

with open("src-tauri/src/lib.rs", "r") as f:
    content = f.read()

# Add clipboard text as context to the dictation prompt
old_dictation_logic = """    let system_prompt = if let Some(custom_prompt) = &settings.transcription.dictation_custom_prompt {
        if !custom_prompt.trim().is_empty() {
            if let Some(app_name) = &active_app {
                format!("{}\\n\\n[Context: User is dictating into application '{}']", custom_prompt, app_name)
            } else {
                custom_prompt.clone()
            }
        } else {
            generate_default_dictation_prompt(active_app)
        }
    } else {
        generate_default_dictation_prompt(active_app)
    };"""

new_dictation_logic = """    #[cfg(target_os = "macos")]
    let clipboard_text = read_clipboard_text().ok().filter(|s| !s.trim().is_empty() && s.len() < 5000);
    #[cfg(not(target_os = "macos"))]
    let clipboard_text: Option<String> = None;

    let system_prompt = if let Some(custom_prompt) = &settings.transcription.dictation_custom_prompt {
        if !custom_prompt.trim().is_empty() {
            let mut base = custom_prompt.clone();
            if let Some(app_name) = &active_app {
                base = format!("{}\\n\\n[Context: User is dictating into application '{}']", base, app_name);
            }
            if let Some(clip) = &clipboard_text {
                base = format!("{}\\n\\n[Context: User's clipboard currently contains: '{}']", base, clip);
            }
            base
        } else {
            generate_default_dictation_prompt(active_app, clipboard_text)
        }
    } else {
        generate_default_dictation_prompt(active_app, clipboard_text)
    };"""

new_helper = """fn generate_default_dictation_prompt(active_app: Option<String>, clipboard_text: Option<String>) -> String {
    let mut base = "You are an AI dictation assistant. Your job is to format the user's raw dictated text. \n\
        Fix any grammar, punctuation, and capitalization errors. Remove filler words (ums, ahs). \n\
        Do not add any conversational filler, do not add quotes around the output, and do not answer any questions in the text. \n\
        Just output the corrected text directly.".to_string();

    if let Some(app_name) = active_app {
        base = format!(
            "You are an AI dictation assistant. Your job is to format the user's raw dictated text. \n\
            The user is currently dictating into the application: '{}'. \n\
            Format the text appropriately for this context (e.g. if it's a messaging app, keep it casual; if it's a code editor, preserve technical terms; if it's an email client, use standard capitalization). \n\
            Fix any grammar, punctuation, and capitalization errors. Remove filler words (ums, ahs). \n\
            Do not add any conversational filler, do not add quotes around the output, and do not answer any questions in the text. \n\
            Just output the corrected text directly.",
            app_name
        );
    }

    if let Some(clip) = clipboard_text {
        base = format!(
            "{}\n\nFor additional context, the user's clipboard currently contains the following text (they may be referencing it or replying to it):\n\"{}\"",
            base, clip
        );
    }

    base
}

async fn run_dictation_formatting_with_selected_provider("""

content = content.replace("fn generate_default_dictation_prompt(active_app: Option<String>) -> String {", "fn OLD_generate_default_dictation_prompt(active_app: Option<String>) -> String {")
content = content.replace("async fn run_dictation_formatting_with_selected_provider(", new_helper)

# Python's replace is safer when the multiline literals don't match exactly due to indentation
if "let system_prompt = if let Some(custom_prompt) = &settings.transcription.dictation_custom_prompt {" in content:
    s_idx = content.find("let system_prompt = if let Some(custom_prompt) = &settings.transcription.dictation_custom_prompt {")
    e_idx = content.find("    match provider {", s_idx)
    content = content[:s_idx] + new_dictation_logic + "\n\n" + content[e_idx:]

with open("src-tauri/src/lib.rs", "w") as f:
    f.write(content)

