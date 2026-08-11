use anyhow::{Context, Result};
use std::fs::File;
#[cfg(not(unix))]
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

#[cfg(target_os = "macos")]
fn resolves_only_root_owned_macos_alias(parent: &Path, canonical_parent: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;

    let mut components = parent.components();
    if !matches!(components.next(), Some(Component::RootDir)) {
        return false;
    }
    let Some(Component::Normal(first)) = components.next() else {
        return false;
    };
    let expected_alias_target = match first.to_str() {
        Some("tmp") => Path::new("/private/tmp"),
        Some("var") => Path::new("/private/var"),
        Some("etc") => Path::new("/private/etc"),
        _ => return false,
    };
    let alias = Path::new("/").join(first);
    let Ok(metadata) = std::fs::symlink_metadata(&alias) else {
        return false;
    };
    if !metadata.file_type().is_symlink() || metadata.uid() != 0 {
        return false;
    }
    let Ok(alias_target) = alias.canonicalize() else {
        return false;
    };
    if alias_target != expected_alias_target {
        return false;
    }

    let mut expected = alias_target;
    for component in components {
        let Component::Normal(name) = component else {
            return false;
        };
        expected.push(name);
    }
    expected == canonical_parent
}

#[cfg(not(target_os = "macos"))]
fn resolves_only_root_owned_macos_alias(_parent: &Path, _canonical_parent: &Path) -> bool {
    false
}

fn destination_parts(path: &Path) -> Result<(&Path, &std::ffi::OsStr)> {
    let parent = path
        .parent()
        .context("Atomic destination has no parent directory")?;
    let file_name = path
        .file_name()
        .context("Atomic destination has no file name")?;
    let mut components = Path::new(file_name).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        anyhow::bail!("Atomic destination file name is invalid");
    }
    Ok((parent, file_name))
}

#[cfg(target_os = "macos")]
fn normalize_root_owned_macos_alias(path: &Path) -> Result<PathBuf> {
    use std::os::unix::fs::MetadataExt;

    let mut components = path.components();
    if !matches!(components.next(), Some(Component::RootDir)) {
        anyhow::bail!("Destination directory must be absolute");
    }
    let Some(Component::Normal(first)) = components.next() else {
        return Ok(path.to_path_buf());
    };
    let expected_alias_target = match first.to_str() {
        Some("tmp") => Some(Path::new("/private/tmp")),
        Some("var") => Some(Path::new("/private/var")),
        Some("etc") => Some(Path::new("/private/etc")),
        _ => None,
    };
    let Some(expected_alias_target) = expected_alias_target else {
        return Ok(path.to_path_buf());
    };
    let alias = Path::new("/").join(first);
    let metadata = std::fs::symlink_metadata(&alias)
        .with_context(|| format!("Failed to inspect system path alias {}", alias.display()))?;
    let alias_target = alias
        .canonicalize()
        .with_context(|| format!("Failed to resolve system path alias {}", alias.display()))?;
    if !metadata.file_type().is_symlink()
        || metadata.uid() != 0
        || alias_target != expected_alias_target
    {
        anyhow::bail!("Destination directory contains an untrusted filesystem link");
    }

    let mut normalized = alias_target;
    for component in components {
        match component {
            Component::Normal(name) => normalized.push(name),
            Component::CurDir => {}
            _ => anyhow::bail!("Destination directory contains an invalid path component"),
        }
    }
    Ok(normalized)
}

#[cfg(not(target_os = "macos"))]
fn normalize_root_owned_macos_alias(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        anyhow::bail!("Destination directory must be absolute");
    }
    Ok(path.to_path_buf())
}

/// Create a directory tree without traversing a symbolic-link component.
///
/// Export targets may include missing nested directories. Creating them with a
/// recursive path API would follow a linked ancestor before the atomic writer
/// gets a chance to reject it. Unix builds instead walk from an open root
/// descriptor and use `mkdirat` plus `openat(O_NOFOLLOW)` for each component.
pub(crate) fn ensure_directory_without_links(path: &Path) -> Result<()> {
    let normalized = normalize_root_owned_macos_alias(path)?;

    #[cfg(unix)]
    {
        ensure_directory_without_links_unix(&normalized)
    }

    #[cfg(not(unix))]
    {
        ensure_directory_without_links_portable(&normalized)
    }
}

/// Open a regular file without following a symbolic-link leaf or ancestor.
pub(crate) fn open_regular_file_without_links(path: &Path) -> Result<File> {
    let (parent, file_name) = destination_parts(path)?;
    let normalized_parent = normalize_root_owned_macos_alias(parent)?;

    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::ffi::OsStrExt;

        let directory = open_directory_without_following_links(&normalized_parent)?;
        let file_name =
            CString::new(file_name.as_bytes()).context("Source file name contains a NUL byte")?;
        let file_fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                file_name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if file_fd < 0 {
            return Err(std::io::Error::last_os_error())
                .with_context(|| format!("Failed to open source file {} safely", path.display()));
        }
        let file = unsafe { File::from_raw_fd(file_fd) };
        if !file
            .metadata()
            .with_context(|| format!("Failed to inspect source file {}", path.display()))?
            .is_file()
        {
            anyhow::bail!("Source is not a regular file: {}", path.display());
        }
        Ok(file)
    }

    #[cfg(not(unix))]
    {
        let file = OpenOptions::new()
            .read(true)
            .open(normalized_parent.join(file_name))
            .with_context(|| format!("Failed to open source file {}", path.display()))?;
        if !file.metadata()?.is_file() {
            anyhow::bail!("Source is not a regular file: {}", path.display());
        }
        Ok(file)
    }
}

/// Publish a staged directory beside its destination without following the
/// parent path after it has been validated and without replacing an existing
/// destination on macOS.
pub(crate) fn publish_directory_without_replacement(
    source: &Path,
    destination: &Path,
) -> Result<()> {
    publish_directory_without_replacement_after_parent_check(source, destination, || Ok(()))
}

fn publish_directory_without_replacement_after_parent_check<H>(
    source: &Path,
    destination: &Path,
    before_parent_open: H,
) -> Result<()>
where
    H: FnOnce() -> Result<()>,
{
    let (source_parent, source_name) = destination_parts(source)?;
    let (destination_parent, destination_name) = destination_parts(destination)?;
    if source_parent != destination_parent {
        anyhow::bail!("Directory publication requires sibling paths");
    }
    let canonical_parent = source_parent.canonicalize().with_context(|| {
        format!(
            "Failed to resolve directory publication parent {}",
            source_parent.display()
        )
    })?;
    if canonical_parent != source_parent
        && !resolves_only_root_owned_macos_alias(source_parent, &canonical_parent)
    {
        anyhow::bail!(
            "Directory publication parent changed or contains an unresolved filesystem link: {}",
            source_parent.display()
        );
    }
    before_parent_open()?;

    #[cfg(target_os = "macos")]
    {
        publish_directory_without_replacement_macos(
            &canonical_parent,
            source_name,
            destination_name,
        )
    }

    #[cfg(not(target_os = "macos"))]
    {
        let source = canonical_parent.join(source_name);
        let destination = canonical_parent.join(destination_name);
        if destination.exists() {
            anyhow::bail!("Directory publication destination already exists");
        }
        std::fs::rename(source, destination)
            .context("Failed to publish staged directory without replacement")
    }
}

#[cfg(target_os = "macos")]
fn publish_directory_without_replacement_macos(
    canonical_parent: &Path,
    source_name: &std::ffi::OsStr,
    destination_name: &std::ffi::OsStr,
) -> Result<()> {
    use std::ffi::CString;
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;

    extern "C" {
        fn renameatx_np(
            from_fd: libc::c_int,
            from: *const libc::c_char,
            to_fd: libc::c_int,
            to: *const libc::c_char,
            flags: libc::c_uint,
        ) -> libc::c_int;
    }

    const RENAME_EXCL: libc::c_uint = 0x0000_0004;
    let source = CString::new(source_name.as_bytes())
        .context("Directory publication source name contains a NUL byte")?;
    let destination = CString::new(destination_name.as_bytes())
        .context("Directory publication destination name contains a NUL byte")?;
    let directory =
        open_directory_without_following_links(canonical_parent).with_context(|| {
            format!(
                "Failed to open directory publication parent {} without following links",
                canonical_parent.display()
            )
        })?;
    let result = unsafe {
        renameatx_np(
            directory.as_raw_fd(),
            source.as_ptr(),
            directory.as_raw_fd(),
            destination.as_ptr(),
            RENAME_EXCL,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error())
            .context("Failed to publish staged directory without replacement");
    }
    directory
        .sync_all()
        .context("Failed to sync directory publication parent")?;
    Ok(())
}

#[cfg(unix)]
fn ensure_directory_without_links_unix(path: &Path) -> Result<()> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    if !path.is_absolute() {
        anyhow::bail!("Destination directory must be absolute");
    }

    let root = CString::new("/").expect("root path contains no NUL");
    let root_fd = unsafe {
        libc::open(
            root.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if root_fd < 0 {
        return Err(std::io::Error::last_os_error())
            .context("Failed to open filesystem root for destination directory");
    }
    let mut directory = unsafe { File::from_raw_fd(root_fd) };

    for component in path.components() {
        let Component::Normal(name) = component else {
            if matches!(component, Component::RootDir | Component::CurDir) {
                continue;
            }
            anyhow::bail!("Destination directory contains an invalid path component");
        };
        let name_c = CString::new(name.as_bytes())
            .context("Destination directory component contains a NUL byte")?;
        let mut next_fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name_c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if next_fd < 0 {
            let open_error = std::io::Error::last_os_error();
            if open_error.raw_os_error() != Some(libc::ENOENT) {
                return Err(open_error).with_context(|| {
                    format!(
                        "Failed to open destination directory component {} without following links",
                        name.to_string_lossy()
                    )
                });
            }

            let mkdir_result =
                unsafe { libc::mkdirat(directory.as_raw_fd(), name_c.as_ptr(), 0o700) };
            if mkdir_result != 0 {
                let mkdir_error = std::io::Error::last_os_error();
                if mkdir_error.raw_os_error() != Some(libc::EEXIST) {
                    return Err(mkdir_error).with_context(|| {
                        format!(
                            "Failed to create destination directory component {}",
                            name.to_string_lossy()
                        )
                    });
                }
            }

            next_fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name_c.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                )
            };
            if next_fd < 0 {
                return Err(std::io::Error::last_os_error()).with_context(|| {
                    format!(
                        "Failed to verify destination directory component {} without following links",
                        name.to_string_lossy()
                    )
                });
            }
        }
        directory = unsafe { File::from_raw_fd(next_fd) };
    }

    directory
        .sync_all()
        .context("Failed to sync destination directory")?;
    Ok(())
}

#[cfg(not(unix))]
fn ensure_directory_without_links_portable(path: &Path) -> Result<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                anyhow::bail!("Destination directory contains an invalid path component")
            }
            Component::Normal(name) => {
                current.push(name);
                match std::fs::symlink_metadata(&current) {
                    Ok(metadata) => {
                        if metadata.file_type().is_symlink() || !metadata.is_dir() {
                            anyhow::bail!(
                                "Destination directory contains a linked or non-directory component: {}",
                                current.display()
                            );
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        std::fs::create_dir(&current).with_context(|| {
                            format!(
                                "Failed to create destination directory component {}",
                                current.display()
                            )
                        })?;
                        let metadata = std::fs::symlink_metadata(&current)?;
                        if metadata.file_type().is_symlink() || !metadata.is_dir() {
                            anyhow::bail!(
                                "Destination directory changed while it was being created: {}",
                                current.display()
                            );
                        }
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    atomic_replace_with(path, |file| {
        file.write_all(bytes)
            .with_context(|| format!("Failed to write staged file for {}", path.display()))
    })
}

/// Write a complete replacement through a file descriptor anchored to the
/// destination's existing parent directory.
///
/// On Unix, `openat` and `renameat` keep both the temporary file and final
/// publication relative to the same open directory. `create_new` semantics and
/// `O_NOFOLLOW` protect the temporary leaf, while `renameat` replaces a final
/// symlink entry instead of following it. This preserves ordinary overwrite
/// behavior without exposing transcript or backup bytes to a link target.
pub(crate) fn atomic_replace_with<F>(path: &Path, writer: F) -> Result<()>
where
    F: FnOnce(&mut File) -> Result<()>,
{
    atomic_replace_with_after_parent_check(path, || Ok(()), writer)
}

fn atomic_replace_with_after_parent_check<F, H>(
    path: &Path,
    before_parent_open: H,
    writer: F,
) -> Result<()>
where
    F: FnOnce(&mut File) -> Result<()>,
    H: FnOnce() -> Result<()>,
{
    let (parent, file_name) = destination_parts(path)?;
    let canonical_parent = parent
        .canonicalize()
        .with_context(|| format!("Failed to resolve destination parent {}", parent.display()))?;
    if canonical_parent != parent
        && !resolves_only_root_owned_macos_alias(parent, &canonical_parent)
    {
        anyhow::bail!(
            "Destination parent changed or contains an unresolved filesystem link: {}",
            parent.display()
        );
    }
    before_parent_open()?;

    #[cfg(unix)]
    {
        atomic_replace_with_unix(&canonical_parent, file_name, writer)
    }

    #[cfg(not(unix))]
    {
        atomic_replace_with_portable(&canonical_parent, file_name, writer)
    }
}

#[cfg(unix)]
fn open_directory_without_following_links(path: &Path) -> Result<File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    if !path.is_absolute() {
        anyhow::bail!("Atomic destination parent must be absolute");
    }

    let root = CString::new("/").expect("root path contains no NUL");
    let root_fd = unsafe {
        libc::open(
            root.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if root_fd < 0 {
        return Err(std::io::Error::last_os_error())
            .context("Failed to open filesystem root for atomic destination");
    }
    let mut directory = unsafe { File::from_raw_fd(root_fd) };

    for component in path.components() {
        let Component::Normal(name) = component else {
            if matches!(component, Component::RootDir | Component::CurDir) {
                continue;
            }
            anyhow::bail!("Atomic destination parent contains an invalid path component");
        };
        let name_c = CString::new(name.as_bytes())
            .context("Atomic destination parent component contains a NUL byte")?;
        let next_fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name_c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if next_fd < 0 {
            return Err(std::io::Error::last_os_error()).with_context(|| {
                format!(
                    "Failed to open destination parent component {} without following links",
                    name.to_string_lossy()
                )
            });
        }
        directory = unsafe { File::from_raw_fd(next_fd) };
    }

    Ok(directory)
}

#[cfg(unix)]
fn atomic_replace_with_unix<F>(
    canonical_parent: &Path,
    file_name: &std::ffi::OsStr,
    writer: F,
) -> Result<()>
where
    F: FnOnce(&mut File) -> Result<()>,
{
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    let destination_c =
        CString::new(file_name.as_bytes()).context("Destination name contains a NUL byte")?;
    let temporary_name = format!(".plainsong-atomic-{}.tmp", uuid::Uuid::new_v4());
    let temporary_c = CString::new(temporary_name).expect("generated temporary name has no NUL");

    let directory = open_directory_without_following_links(canonical_parent)?;

    let temporary_fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            temporary_c.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if temporary_fd < 0 {
        return Err(std::io::Error::last_os_error()).context("Failed to create atomic stage file");
    }

    let mut temporary = unsafe { File::from_raw_fd(temporary_fd) };
    let write_result = writer(&mut temporary).and_then(|_| {
        temporary
            .sync_all()
            .context("Failed to sync atomic stage file")
    });
    drop(temporary);

    if let Err(error) = write_result {
        unsafe {
            libc::unlinkat(directory.as_raw_fd(), temporary_c.as_ptr(), 0);
        }
        return Err(error);
    }

    let rename_result = unsafe {
        libc::renameat(
            directory.as_raw_fd(),
            temporary_c.as_ptr(),
            directory.as_raw_fd(),
            destination_c.as_ptr(),
        )
    };
    if rename_result != 0 {
        let error = std::io::Error::last_os_error();
        unsafe {
            libc::unlinkat(directory.as_raw_fd(), temporary_c.as_ptr(), 0);
        }
        return Err(error).context("Failed to publish atomic destination");
    }

    directory
        .sync_all()
        .context("Failed to sync destination directory")?;
    Ok(())
}

#[cfg(not(unix))]
fn atomic_replace_with_portable<F>(
    canonical_parent: &Path,
    file_name: &std::ffi::OsStr,
    writer: F,
) -> Result<()>
where
    F: FnOnce(&mut File) -> Result<()>,
{
    let destination = canonical_parent.join(file_name);
    let temporary =
        canonical_parent.join(format!(".plainsong-atomic-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .context("Failed to create atomic stage file")?;
    if let Err(error) =
        writer(&mut file).and_then(|_| file.sync_all().context("Failed to sync atomic stage file"))
    {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    drop(file);

    if let Ok(metadata) = std::fs::symlink_metadata(&destination) {
        if metadata.is_dir() {
            let _ = std::fs::remove_file(&temporary);
            anyhow::bail!("Atomic destination is a directory");
        }
        std::fs::remove_file(&destination)
            .context("Failed to replace existing atomic destination")?;
    }
    std::fs::rename(&temporary, &destination).context("Failed to publish atomic destination")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_atomic_write_replaces_existing_content() {
        let root =
            std::env::temp_dir().join(format!("plainsong-safe-fs-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create test root");
        let root = root.canonicalize().expect("canonical test root");
        let destination = root.join("output.txt");
        std::fs::write(&destination, "before").expect("write original");

        atomic_write(&destination, b"after").expect("replace destination");

        assert_eq!(
            std::fs::read_to_string(&destination).expect("read destination"),
            "after"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn atomic_write_accepts_the_root_owned_macos_tmp_alias() {
        let root = std::path::PathBuf::from("/tmp").join(format!(
            "plainsong-safe-fs-macos-tmp-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create test root through /tmp alias");
        let destination = root.join("output.txt");

        atomic_write(&destination, b"private")
            .expect("the root-owned /tmp alias should resolve to /private/tmp");

        assert_eq!(
            std::fs::read_to_string(&destination).expect("read destination"),
            "private"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn atomic_write_still_rejects_a_nested_link_below_the_macos_tmp_alias() {
        use std::os::unix::fs::symlink;

        let root = std::path::PathBuf::from("/tmp").join(format!(
            "plainsong-safe-fs-macos-nested-link-test-{}",
            uuid::Uuid::new_v4()
        ));
        let outside = root.join("outside");
        let linked_parent = root.join("linked-parent");
        std::fs::create_dir_all(&outside).expect("create outside directory");
        symlink(&outside, &linked_parent).expect("create nested parent link");

        let error = atomic_write(&linked_parent.join("output.txt"), b"private")
            .expect_err("a nested link below /tmp must still fail closed");

        assert!(error.to_string().contains("filesystem link"));
        assert!(!outside.join("output.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_rejects_a_link_parent_before_opening_it() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "plainsong-safe-fs-parent-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create test root");
        let root = root.canonicalize().expect("canonical test root");
        let outside = root.join("outside");
        let linked_parent = root.join("linked-parent");
        std::fs::create_dir_all(&outside).expect("create outside directory");
        symlink(&outside, &linked_parent).expect("create parent link");

        let error = atomic_write(&linked_parent.join("output.txt"), b"private")
            .expect_err("linked destination parent must fail closed");

        assert!(error.to_string().contains("filesystem link"));
        assert!(!outside.join("output.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_rejects_an_ancestor_swapped_after_parent_validation() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "plainsong-safe-fs-race-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("approved/inner")).expect("create approved parent");
        std::fs::create_dir_all(root.join("outside/inner")).expect("create outside parent");
        let root = root.canonicalize().expect("canonical test root");
        let destination = root.join("approved/inner/output.txt");

        let error = atomic_replace_with_after_parent_check(
            &destination,
            || {
                std::fs::rename(root.join("approved"), root.join("approved-original"))?;
                symlink(root.join("outside"), root.join("approved"))?;
                Ok(())
            },
            |file| {
                file.write_all(b"private")?;
                Ok(())
            },
        )
        .expect_err("an ancestor swap must fail closed");

        assert!(
            error.to_string().contains("destination parent")
                || error.to_string().contains("filesystem link")
        );
        assert!(!root.join("outside/inner/output.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn safe_directory_creation_creates_missing_nested_directories() {
        let root = std::env::temp_dir().join(format!(
            "plainsong-safe-directory-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create test root");
        let root = root.canonicalize().expect("canonical test root");
        let destination = root.join("exports/nested");

        ensure_directory_without_links(&destination).expect("create safe nested directory");

        assert!(destination.is_dir());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn safe_directory_creation_rejects_a_link_without_creating_outside_it() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "plainsong-safe-directory-link-test-{}",
            uuid::Uuid::new_v4()
        ));
        let approved = root.join("approved");
        let outside = root.join("outside");
        std::fs::create_dir_all(&approved).expect("create approved root");
        std::fs::create_dir_all(&outside).expect("create outside root");
        let root = root.canonicalize().expect("canonical test root");
        symlink(&outside, approved.join("linked")).expect("create directory link");

        ensure_directory_without_links(&approved.join("linked/new-export-directory"))
            .expect_err("linked directory component must fail closed");

        assert!(!outside.join("new-export-directory").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn no_follow_file_open_rejects_a_link_leaf() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "plainsong-safe-source-open-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create test root");
        let root = root.canonicalize().expect("canonical test root");
        let outside = root.join("outside.txt");
        let linked = root.join("source.txt");
        std::fs::write(&outside, "private").expect("write outside file");
        symlink(&outside, &linked).expect("create source link");

        open_regular_file_without_links(&linked)
            .expect_err("a linked source leaf must fail closed");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn exclusive_directory_publish_rejects_an_ancestor_swap() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "plainsong-safe-directory-publish-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("approved/staged")).expect("create stage");
        std::fs::create_dir_all(root.join("outside")).expect("create outside");
        let root = root.canonicalize().expect("canonical test root");

        let error = publish_directory_without_replacement_after_parent_check(
            &root.join("approved/staged"),
            &root.join("approved/final"),
            || {
                std::fs::rename(root.join("approved"), root.join("approved-original"))?;
                symlink(root.join("outside"), root.join("approved"))?;
                Ok(())
            },
        )
        .expect_err("a swapped publication parent must fail closed");

        assert!(!root.join("outside/final").exists());
        assert!(root.join("approved-original/staged").is_dir());
        assert!(error.to_string().contains("publication parent"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
