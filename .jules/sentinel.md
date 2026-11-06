## 2025-05-10 - Cloud Location Path Validation Edge Cases
**Vulnerability:** `parseCloudLocationRequest` validated relative paths against leading slashes and `..` segments, but missed null byte injection (`\0`) and Windows drive-relative paths (e.g. `C:Folder`).
**Learning:** Checking only leading slashes and path split parts leaves null bytes and Windows drive-qualified relative paths unvalidated.
**Prevention:** Explicitly reject `\0` and `/^[A-Za-z]:/` when enforcing relative path constraints for file system or cloud storage operations in Electron IPC handlers.

## 2025-05-11 - Windows File Opener CMD Metacharacter Injection
**Vulnerability:** `open_path_in_default_app` used `cmd.exe /C start ""` on Windows, passing file paths directly to CMD's command-line parser where characters like `&`, `|`, `%`, `"`, or spaces trigger metacharacter expansion and command execution.
**Learning:** Using `cmd.exe /C start ""` to open files or folders executes input through CMD command processor rules, risking command injection if paths contain special characters.
**Prevention:** Use `powershell` with `-NoProfile -NonInteractive -Command "Start-Process -FilePath $args[0]"` and pass the path as a positional argument (`$args[0]`) to bypass CMD command line interpretation.
