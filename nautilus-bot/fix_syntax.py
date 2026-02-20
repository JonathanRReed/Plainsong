import re

with open("src-tauri/src/lib.rs", "r") as f:
    content = f.read()

# Fix the string formatting interpolation syntax error
bad_str = """    if let Some(clip) = clipboard_text {
        base = format!(
            "{}

For additional context, the user's clipboard currently contains the following text (they may be referencing it or replying to it):
"{}"",
            base, clip
        );
    }"""

good_str = """    if let Some(clip) = clipboard_text {
        base = format!(
            "{}

For additional context, the user's clipboard currently contains the following text (they may be referencing it or replying to it):
\\"{}\\"",
            base, clip
        );
    }"""

content = content.replace(bad_str, good_str)

with open("src-tauri/src/lib.rs", "w") as f:
    f.write(content)

