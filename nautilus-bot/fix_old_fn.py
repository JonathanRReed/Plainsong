import re

with open("src-tauri/src/lib.rs", "r") as f:
    content = f.read()

# Remove OLD_generate_default_dictation_prompt to fix warnings
start_marker = "fn OLD_generate_default_dictation_prompt"
end_marker = "}\n\nfn generate_default_dictation_prompt"

s_idx = content.find(start_marker)
e_idx = content.find(end_marker, s_idx) + 3

if s_idx != -1 and content.find(end_marker, s_idx) != -1:
    content = content[:s_idx] + content[e_idx:]

with open("src-tauri/src/lib.rs", "w") as f:
    f.write(content)

