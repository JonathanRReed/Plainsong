## 2025-05-10 - Cloud Location Path Validation Edge Cases
**Vulnerability:** `parseCloudLocationRequest` validated relative paths against leading slashes and `..` segments, but missed null byte injection (`\0`) and Windows drive-relative paths (e.g. `C:Folder`).
**Learning:** Checking only leading slashes and path split parts leaves null bytes and Windows drive-qualified relative paths unvalidated.
**Prevention:** Explicitly reject `\0` and `/^[A-Za-z]:/` when enforcing relative path constraints for file system or cloud storage operations in Electron IPC handlers.

## 2026-03-30 - Windows Command Injection in File Opener
**Vulnerability:** `open_path_in_default_app` used `cmd.exe /C start ""` on Windows, exposing path metacharacters (`&`, `|`, `%`) to shell command execution.
**Learning:** Passing raw file paths to `cmd.exe` allows shell metacharacters in filenames to be evaluated as arbitrary commands.
**Prevention:** Use PowerShell `Start-Process -LiteralPath` with single-quote escaping (`'` -> `''`) for launching files in default applications on Windows.
