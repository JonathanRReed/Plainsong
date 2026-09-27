## 2025-05-10 - Cloud Location Path Validation Edge Cases
**Vulnerability:** `parseCloudLocationRequest` validated relative paths against leading slashes and `..` segments, but missed null byte injection (`\0`) and Windows drive-relative paths (e.g. `C:Folder`).
**Learning:** Checking only leading slashes and path split parts leaves null bytes and Windows drive-qualified relative paths unvalidated.
**Prevention:** Explicitly reject `\0` and `/^[A-Za-z]:/` when enforcing relative path constraints for file system or cloud storage operations in Electron IPC handlers.
