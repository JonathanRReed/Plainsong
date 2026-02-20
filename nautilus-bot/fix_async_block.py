import re

with open("src-tauri/src/lib.rs", "r") as f:
    content = f.read()

# Replace the synchronous osascript call with a spawn_blocking call so it doesn't block tokio
old_active_app = """    let active_app = get_frontmost_app_name();"""

new_active_app = """    let active_app = tauri::async_runtime::spawn_blocking(|| {
        get_frontmost_app_name()
    })
    .await
    .unwrap_or(None);"""

content = content.replace(old_active_app, new_active_app)

with open("src-tauri/src/lib.rs", "w") as f:
    f.write(content)

