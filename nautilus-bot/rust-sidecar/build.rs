use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::Command;

fn main() {
    println!("cargo:rustc-check-cfg=cfg(nautilus_macos_speech_helper)");

    #[cfg(target_os = "macos")]
    build_macos_speech_helper();

    #[cfg(not(target_os = "macos"))]
    ensure_placeholder_sidecar();
}

#[cfg(target_os = "macos")]
fn build_macos_speech_helper() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set"));
    let source = manifest_dir
        .join("native")
        .join("macos_speech_helper.swift");
    let helper_plist = manifest_dir
        .join("native")
        .join("macos_speech_helper.Info.plist");
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rerun-if-changed={}", helper_plist.display());

    if !source.exists() || !helper_plist.exists() {
        return;
    }

    let helper_dir = manifest_dir.join("binaries");
    std::fs::create_dir_all(&helper_dir).expect("Failed to create binaries directory");
    let target = std::env::var("TARGET").unwrap_or_else(|_| "aarch64-apple-darwin".to_string());
    let helper_path = helper_dir.join(format!("nautilus-macos-speech-helper-{}", target));

    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-O",
            source.to_str().unwrap_or_default(),
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
            helper_plist.to_str().unwrap_or_default(),
            "-o",
            helper_path.to_str().unwrap_or_default(),
        ])
        .status();

    match status {
        Ok(code) if code.success() => {
            println!("cargo:rustc-cfg=nautilus_macos_speech_helper");
        }
        Ok(code) => {
            panic!(
                "Failed to compile macOS Speech helper (swiftc exit code {:?}).",
                code.code()
            );
        }
        Err(error) => {
            panic!(
                "Failed to compile macOS Speech helper via xcrun swiftc: {}",
                error
            );
        }
    }
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
