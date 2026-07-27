#[cfg(target_os = "macos")]
use std::path::Path;
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::{Command, Output};

fn main() {
    #[cfg(target_os = "macos")]
    build_macos_speech_helper();

    #[cfg(not(target_os = "macos"))]
    ensure_placeholder_sidecar();
}

#[cfg(target_os = "macos")]
fn build_macos_speech_helper() {
    const HELPER_NAME: &str = "nautilus-macos-speech-helper-aarch64-apple-darwin";
    const SWIFT_TARGET: &str = "arm64-apple-macosx13.0";

    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set"));
    let native_dir = manifest_dir.join("native");
    let source = native_dir.join("macos_speech_helper.swift");
    let helper_plist = native_dir.join("macos_speech_helper.Info.plist");
    let helper_entitlements = native_dir.join("macos_speech_helper.entitlements.plist");

    for path in [&source, &helper_plist, &helper_entitlements] {
        println!("cargo:rerun-if-changed={}", path.display());
        require_regular_file(path);
    }

    validate_plist(&helper_plist, "helper Info.plist");
    validate_plist(&helper_entitlements, "helper entitlements");

    let helper_dir = manifest_dir.join("binaries");
    std::fs::create_dir_all(&helper_dir).unwrap_or_else(|error| {
        panic!(
            "Failed to create macOS Speech helper output directory '{}': {}",
            helper_dir.display(),
            error
        )
    });
    let helper_path = helper_dir.join(HELPER_NAME);
    if helper_path.exists() {
        std::fs::remove_file(&helper_path).unwrap_or_else(|error| {
            panic!(
                "Failed to remove stale macOS Speech helper '{}': {}",
                helper_path.display(),
                error
            )
        });
    }

    let output = Command::new("xcrun")
        .args([
            "swiftc",
            "-O",
            "-target",
            SWIFT_TARGET,
            path_str(&source),
            "-framework",
            "Speech",
            "-framework",
            "Foundation",
            "-framework",
            "AVFoundation",
            "-Xlinker",
            "-sectcreate",
            "-Xlinker",
            "__TEXT",
            "-Xlinker",
            "__info_plist",
            "-Xlinker",
            path_str(&helper_plist),
            "-o",
            path_str(&helper_path),
        ])
        .env("MACOSX_DEPLOYMENT_TARGET", "13.0")
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "Failed to launch xcrun swiftc for the required macOS Speech helper: {}",
                error
            )
        });
    require_success("compile the required macOS Speech helper", &output);
    require_regular_file(&helper_path);
    ensure_executable(&helper_path);
    let signature = Command::new("/usr/bin/codesign")
        .args([
            "--force",
            "--sign",
            "-",
            "--entitlements",
            path_str(&helper_entitlements),
            path_str(&helper_path),
        ])
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "Failed to launch codesign for the macOS Speech helper: {}",
                error
            )
        });
    require_success(
        "ad-hoc sign the macOS Speech helper with its required entitlement",
        &signature,
    );

    let architectures = command_output(
        "xcrun",
        &["lipo", "-archs", path_str(&helper_path)],
        "inspect macOS Speech helper architectures",
    );
    let architecture_text = String::from_utf8_lossy(&architectures.stdout);
    if architecture_text.split_whitespace().collect::<Vec<_>>() != ["arm64"] {
        panic!(
            "macOS Speech helper must be arm64-only, but lipo reported: {}",
            architecture_text.trim()
        );
    }

    let build_version = command_output(
        "xcrun",
        &["vtool", "-show-build", path_str(&helper_path)],
        "inspect macOS Speech helper deployment target",
    );
    let build_version_text = String::from_utf8_lossy(&build_version.stdout);
    if !build_version_text.contains("minos 13.0") {
        panic!(
            "macOS Speech helper must declare a macOS 13.0 deployment target, but vtool reported:\n{}",
            build_version_text.trim()
        );
    }

    let host = std::env::var("HOST").unwrap_or_default();
    if host.starts_with("aarch64-apple-darwin") {
        let probe = Command::new(&helper_path)
            .arg("--probe")
            .output()
            .unwrap_or_else(|error| {
                panic!(
                    "Failed to launch the compiled macOS Speech helper capability probe: {}",
                    error
                )
            });
        require_success("run the macOS Speech helper capability probe", &probe);
        let probe_text = String::from_utf8_lossy(&probe.stdout);
        if !probe_text.contains("\"protocol_version\":1")
            || !probe_text.contains("\"type\":\"probe\"")
            || !probe_text.contains("\"on_device_available\"")
        {
            panic!(
                "macOS Speech helper returned an invalid capability probe: {}",
                probe_text.trim()
            );
        }
    }
}

#[cfg(target_os = "macos")]
fn require_regular_file(path: &Path) {
    let metadata = std::fs::metadata(path).unwrap_or_else(|error| {
        panic!(
            "Required macOS Speech helper file '{}' is missing or unreadable: {}",
            path.display(),
            error
        )
    });
    if !metadata.is_file() || metadata.len() == 0 {
        panic!(
            "Required macOS Speech helper file '{}' is not a non-empty regular file",
            path.display()
        );
    }
}

#[cfg(target_os = "macos")]
fn ensure_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = std::fs::metadata(path)
        .unwrap_or_else(|error| {
            panic!(
                "Failed to inspect macOS Speech helper permissions '{}': {}",
                path.display(),
                error
            )
        })
        .permissions();
    permissions.set_mode(permissions.mode() | 0o755);
    std::fs::set_permissions(path, permissions).unwrap_or_else(|error| {
        panic!(
            "Failed to mark macOS Speech helper executable '{}': {}",
            path.display(),
            error
        )
    });
}

#[cfg(target_os = "macos")]
fn validate_plist(path: &Path, label: &str) {
    let output = Command::new("/usr/bin/plutil")
        .args(["-lint", path_str(path)])
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "Failed to validate {} '{}': {}",
                label,
                path.display(),
                error
            )
        });
    require_success(&format!("validate {} '{}'", label, path.display()), &output);
}

#[cfg(target_os = "macos")]
fn command_output(program: &str, args: &[&str], action: &str) -> Output {
    let output = Command::new(program)
        .args(args)
        .output()
        .unwrap_or_else(|error| panic!("Failed to {}: {}", action, error));
    require_success(action, &output);
    output
}

#[cfg(target_os = "macos")]
fn require_success(action: &str, output: &Output) {
    if output.status.success() {
        return;
    }
    panic!(
        "Failed to {} (exit {:?}). stdout: {} stderr: {}",
        action,
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).trim(),
        String::from_utf8_lossy(&output.stderr).trim()
    );
}

#[cfg(target_os = "macos")]
fn path_str(path: &Path) -> &str {
    path.to_str().unwrap_or_else(|| {
        panic!(
            "macOS Speech helper path is not valid UTF-8: {}",
            path.display()
        )
    })
}

#[cfg(not(target_os = "macos"))]
fn ensure_placeholder_sidecar() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set"));
    let helper_dir = manifest_dir.join("binaries");
    let _ = std::fs::create_dir_all(&helper_dir);

    let target = std::env::var("TARGET").unwrap_or_default();
    if target.is_empty() {
        return;
    }

    let mut helper_name = format!("nautilus-macos-speech-helper-{}", target);
    if target.contains("windows") {
        helper_name.push_str(".exe");
    }
    let helper_path = helper_dir.join(helper_name);
    if helper_path.exists() {
        return;
    }

    let _ = std::fs::write(
        helper_path,
        b"This placeholder sidecar is only used for non-macOS packaging targets.\n",
    );
}
