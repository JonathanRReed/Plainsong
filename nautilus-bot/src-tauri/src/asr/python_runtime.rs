use std::collections::HashSet;
use std::process::Command;

/// Find a Python executable that can import the required runtime probe modules.
///
/// Resolution order:
/// 1. `NAUTILUS_PYTHON` env var (if set)
/// 2. common versioned python commands
/// 3. common absolute Homebrew / system paths
pub fn find_python_with_imports(import_probe: &str) -> Option<String> {
    let mut candidates: Vec<String> = Vec::new();

    if let Ok(value) = std::env::var("NAUTILUS_PYTHON") {
        if !value.trim().is_empty() {
            candidates.push(value);
        }
    }

    candidates.extend(
        [
            "python3.11",
            "python3.12",
            "python3.10",
            "python3",
            "/opt/homebrew/bin/python3.11",
            "/opt/homebrew/bin/python3.12",
            "/usr/local/bin/python3.11",
            "/usr/local/bin/python3.12",
            "/usr/bin/python3",
        ]
        .iter()
        .map(|value| (*value).to_string()),
    );

    let mut seen = HashSet::new();
    for candidate in candidates {
        if !seen.insert(candidate.clone()) {
            continue;
        }

        let output = Command::new(&candidate).args(["-c", import_probe]).output();

        if let Ok(result) = output {
            if result.status.success() {
                return Some(candidate);
            }
        }
    }

    None
}
