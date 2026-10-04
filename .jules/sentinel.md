## 2026-03-29 - Default Application File Opener Path Validation & Windows Shell Injections
**Vulnerability:** `open_path_in_default_app` passed uncanonicalized paths to OS openers, bypassing approved Plainsong root checks, and used `cmd /C start` on Windows which is vulnerable to metacharacter and argument injection if paths contain special characters (`&`, `|`, etc.).
**Learning:** `cmd.exe /C start` performs shell metacharacter expansion and argument parsing on input paths. In addition, Rust's `Path::canonicalize()` on Windows returns `\\?\` prefixed verbatim UNC paths which `ShellExecute`/`Start-Process` fail to open without stripping the `\\?\` prefix.
**Prevention:** Canonicalize and enforce `ensure_path_in_approved_roots` on all paths before passing to OS file openers. On Windows, strip `\\?\` UNC prefixes and use PowerShell `-NoProfile -NonInteractive -Command "Start-Process -FilePath '...'"` with single-quote escaping (`''`).

## 2025-05-10 - Cloud Location Path Validation Edge Cases
**Vulnerability:** `parseCloudLocationRequest` validated relative paths against leading slashes and `..` segments, but missed null byte injection (`\0`) and Windows drive-relative paths (e.g. `C:Folder`).
**Learning:** Checking only leading slashes and path split parts leaves null bytes and Windows drive-qualified relative paths unvalidated.
**Prevention:** Explicitly reject `\0` and `/^[A-Za-z]:/` when enforcing relative path constraints for file system or cloud storage operations in Electron IPC handlers.
