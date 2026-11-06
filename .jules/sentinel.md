## 2025-05-10 - Cloud Location Path Validation Edge Cases
**Vulnerability:** `parseCloudLocationRequest` validated relative paths against leading slashes and `..` segments, but missed null byte injection (`\0`) and Windows drive-relative paths (e.g. `C:Folder`).
**Learning:** Checking only leading slashes and path split parts leaves null bytes and Windows drive-qualified relative paths unvalidated.
**Prevention:** Explicitly reject `\0` and `/^[A-Za-z]:/` when enforcing relative path constraints for file system or cloud storage operations in Electron IPC handlers.

## 2025-05-18 - Windows Opener Command Injection Vulnerability
**Vulnerability:** `open_path_in_default_app` used `cmd.exe /C start ""` on Windows, exposing command execution when opening file paths containing shell metacharacters (`&`, `|`, `%`, `^`).
**Learning:** `cmd.exe` parses raw command line strings and evaluates shell operators even when arguments are passed via `std::process::Command`.
**Prevention:** Use `powershell -NoProfile -NonInteractive -Command "Start-Process -LiteralPath '<escaped_path>'"` with single-quote escaping instead of `cmd.exe /C` to prevent command injection and wildcard/variable evaluation.
