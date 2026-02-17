use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

fn python_probe_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Find a Python executable that can import the required runtime probe modules.
///
/// Resolution order:
/// 1. `NAUTILUS_PYTHON` env var (if set)
/// 2. common versioned python commands
/// 3. common absolute Homebrew / system paths
pub fn find_python_with_imports(import_probe: &str) -> Option<String> {
    let probe_key = import_probe.trim().to_string();
    if probe_key.is_empty() {
        return None;
    }

    if let Ok(cache) = python_probe_cache().lock() {
        if let Some(cached) = cache.get(&probe_key) {
            return cached.clone();
        }
    }

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
    let mut resolved: Option<String> = None;
    for candidate in candidates {
        if !seen.insert(candidate.clone()) {
            continue;
        }

        let output = Command::new(&candidate).args(["-c", import_probe]).output();

        if let Ok(result) = output {
            if result.status.success() {
                resolved = Some(candidate);
                break;
            }
        }
    }

    if let Ok(mut cache) = python_probe_cache().lock() {
        cache.insert(probe_key, resolved.clone());
    }

    resolved
}
