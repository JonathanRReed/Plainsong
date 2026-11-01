//! Per-session verification of local model files against app-pinned SHA-256s.
//!
//! Nothing about verification is written to disk. A model file is hashed in
//! full the first time this process needs it, through the descriptor the
//! loader then reads, and the match is remembered in memory for the rest of
//! the process together with the file's identity (device, inode, size, and
//! modification and change times to the nanosecond). A later load re-checks
//! that identity with an `fstat` of its own descriptor and hashes again when
//! anything differs. A new sidecar process starts with nothing remembered.
//!
//! Readiness is a separate, cheaper question. A pinned file that is present
//! reads as installed unless this session already hashed that exact file and
//! found it wrong; the bytes are checked when the model is first loaded, and a
//! mismatch then makes the model read as missing, which offers the download.

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

/// What a model file is, as `fstat` reports it. On Unix any write to the
/// file's bytes or metadata moves its change time, and a replacement file has
/// a new inode.
#[cfg(unix)]
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct ModelArtifactIdentity {
    device: u64,
    inode: u64,
    size: u64,
    modified_seconds: i64,
    modified_nanos: i64,
    changed_seconds: i64,
    changed_nanos: i64,
}

#[cfg(not(unix))]
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct ModelArtifactIdentity {
    size: u64,
    modified_nanos: u128,
}

#[cfg(unix)]
pub(crate) fn model_artifact_identity(
    metadata: &std::fs::Metadata,
) -> Result<ModelArtifactIdentity> {
    use std::os::unix::fs::MetadataExt;

    Ok(ModelArtifactIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        size: metadata.len(),
        modified_seconds: metadata.mtime(),
        modified_nanos: metadata.mtime_nsec(),
        changed_seconds: metadata.ctime(),
        changed_nanos: metadata.ctime_nsec(),
    })
}

#[cfg(not(unix))]
pub(crate) fn model_artifact_identity(
    metadata: &std::fs::Metadata,
) -> Result<ModelArtifactIdentity> {
    Ok(ModelArtifactIdentity {
        size: metadata.len(),
        modified_nanos: metadata
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)
            .context("Model modification time predates the Unix epoch")?
            .as_nanos(),
    })
}

impl ModelArtifactIdentity {
    /// A change-time update alone can be an OS metadata write. It still
    /// requires hashing: a writer can restore the size and modification time.
    fn same_except_change_time(&self, other: &Self) -> bool {
        #[cfg(unix)]
        {
            self.device == other.device
                && self.inode == other.inode
                && self.size == other.size
                && self.modified_seconds == other.modified_seconds
                && self.modified_nanos == other.modified_nanos
        }
        #[cfg(not(unix))]
        {
            self == other
        }
    }
}

#[derive(Debug)]
pub(crate) struct ModelArtifactChanged {
    path: PathBuf,
}

impl std::fmt::Display for ModelArtifactChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} changed while it was loading. Try again.",
            self.path.display()
        )
    }
}

impl std::error::Error for ModelArtifactChanged {}

pub(crate) fn is_model_artifact_changed(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.is::<ModelArtifactChanged>())
}

/// A model file whose bytes did not match its pin. Callers show the
/// existing "download again" path for it.
#[derive(Debug)]
pub(crate) struct ModelIntegrityMismatch {
    pub(crate) path: PathBuf,
}

impl std::fmt::Display for ModelIntegrityMismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = self
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.path.display().to_string());
        write!(
            f,
            "{name} failed its integrity check. Download the model again in Settings > Models."
        )
    }
}

impl std::error::Error for ModelIntegrityMismatch {}

pub(crate) fn is_integrity_mismatch(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.is::<ModelIntegrityMismatch>())
}

/// `error`, or the integrity mismatch in its chain when there is one. The
/// sidecar reports only an error's outermost message, and for a mismatch
/// that message must be the one that says to download the model again.
pub(crate) fn mismatch_first(error: anyhow::Error) -> anyhow::Error {
    let path = error
        .chain()
        .find_map(|cause| cause.downcast_ref::<ModelIntegrityMismatch>())
        .map(|mismatch| mismatch.path.clone());
    match path {
        Some(path) => ModelIntegrityMismatch { path }.into(),
        None => error,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Entry {
    sha256: String,
    identity: ModelArtifactIdentity,
}

/// Far more files than any model library holds; reached only by a bug.
const MAX_SESSION_ENTRIES: usize = 4096;

#[derive(Default)]
struct SessionModels {
    /// Hashed in this process and matched the pin, keyed by canonical path.
    verified: HashMap<PathBuf, Entry>,
    /// Hashed in this process and did not match. Kept so readiness reports
    /// the file as missing until it changes.
    rejected: HashMap<PathBuf, Entry>,
}

impl SessionModels {
    fn matches(map: &HashMap<PathBuf, Entry>, key: &Path, entry: &Entry) -> bool {
        map.get(key).is_some_and(|known| known == entry)
    }

    fn insert_bounded(map: &mut HashMap<PathBuf, Entry>, key: PathBuf, entry: Entry) {
        if !map.contains_key(&key) && map.len() >= MAX_SESSION_ENTRIES {
            if let Some(evicted) = map.keys().next().cloned() {
                map.remove(&evicted);
            }
        }
        map.insert(key, entry);
    }

    fn record(&mut self, key: PathBuf, entry: Entry) {
        self.rejected.remove(&key);
        Self::insert_bounded(&mut self.verified, key, entry);
    }

    fn reject(&mut self, key: PathBuf, entry: Entry) {
        self.verified.remove(&key);
        Self::insert_bounded(&mut self.rejected, key, entry);
    }

    fn forget(&mut self, key: &Path) {
        self.verified.remove(key);
        self.rejected.remove(key);
    }

    fn forget_under(&mut self, directory: &Path) {
        self.verified.retain(|key, _| !key.starts_with(directory));
        self.rejected.retain(|key, _| !key.starts_with(directory));
    }
}

/// One sidecar process's verification state. Tests build their own to stand
/// for a new process.
#[derive(Default)]
pub(crate) struct ModelTrustSession {
    models: Mutex<SessionModels>,
    /// One lock per file, so a load that needs a file the background pass is
    /// hashing waits for that hash instead of starting a second one.
    in_flight: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
}

impl ModelTrustSession {
    fn models(&self) -> MutexGuard<'_, SessionModels> {
        self.models
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn file_lock(&self, key: &Path) -> Arc<Mutex<()>> {
        let mut locks = self
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Arc::clone(locks.entry(key.to_path_buf()).or_default())
    }
}

static SESSION: OnceLock<ModelTrustSession> = OnceLock::new();

pub(crate) fn session() -> &'static ModelTrustSession {
    SESSION.get_or_init(ModelTrustSession::default)
}

fn session_key(path: &Path) -> Result<PathBuf> {
    std::fs::canonicalize(path)
        .with_context(|| format!("Could not resolve model file {}", path.display()))
}

/// Every call site pins a real digest; `Some("")` is a programmer error (an
/// accidentally-empty struct field, not a deliberate "not yet pinned" state)
/// and is rejected loudly in debug/test builds rather than silently treated
/// as untrusted-forever in release builds. `None` is the only correct way to
/// say "not yet pinned".
pub(crate) fn assert_pinned_digest_is_never_empty(expected_sha256: Option<&str>) {
    debug_assert!(
        expected_sha256.is_none_or(|digest| !digest.is_empty()),
        "expected_sha256 must be None (\"not yet pinned\"), never Some(\"\"); an empty pinned \
         digest used to silently disable integrity verification"
    );
}

#[cfg(test)]
static FULL_HASHES: OnceLock<Mutex<HashMap<PathBuf, usize>>> = OnceLock::new();

#[cfg(test)]
fn note_full_hash_for_tests(path: &Path) {
    *FULL_HASHES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entry(session_key(path).unwrap_or_else(|_| path.to_path_buf()))
        .or_default() += 1;
}

/// How many times this test process has hashed `path` in full.
#[cfg(test)]
pub(crate) fn full_hash_count_for_tests(path: &Path) -> usize {
    FULL_HASHES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&session_key(path).unwrap_or_else(|_| path.to_path_buf()))
        .copied()
        .unwrap_or(0)
}

/// Hash `file` from its start and bind the digest to an `fstat` of that same
/// descriptor taken before and after the read, so a write during hashing
/// fails instead of vouching for mixed bytes. Leaves the offset at zero: on
/// macOS a `/dev/fd/N` open shares it, and loaders read from the start.
pub(super) fn hash_open_file(
    file: &std::fs::File,
    path: &Path,
    mut after_chunk: impl FnMut(usize),
) -> Result<(String, ModelArtifactIdentity)> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Seek, SeekFrom};

    #[cfg(test)]
    note_full_hash_for_tests(path);
    let before = file.metadata()?;
    anyhow::ensure!(
        before.is_file(),
        "Model artifact is not a regular file: {}",
        path.display()
    );
    let before_identity = model_artifact_identity(&before)?;
    let mut reader = file;
    reader.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        after_chunk(count);
    }
    let identity = model_artifact_identity(&file.metadata()?)?;
    anyhow::ensure!(
        identity == before_identity,
        ModelArtifactChanged {
            path: path.to_path_buf()
        }
    );
    reader.seek(SeekFrom::Start(0))?;
    Ok((hex::encode(hasher.finalize()), identity))
}

/// A model file opened for loading after its bytes were verified in this
/// session. On Unix `load_path` names the verified file itself (see
/// [`load_path_for`]), so a rename after the check cannot redirect the
/// loader to other bytes. Keep this value alive until the native library has
/// finished reading.
pub(crate) struct VerifiedModelArtifact {
    file: std::fs::File,
    load_path: PathBuf,
    key: PathBuf,
    sha256: String,
    identity: ModelArtifactIdentity,
    session: &'static ModelTrustSession,
}

impl std::fmt::Debug for VerifiedModelArtifact {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VerifiedModelArtifact")
            .field("path", &self.key)
            .field("load_path", &self.load_path)
            .finish()
    }
}

impl VerifiedModelArtifact {
    pub(crate) fn load_path(&self) -> &Path {
        &self.load_path
    }

    /// The verified open description, for mapping or handing to a child.
    pub(crate) fn as_file(&self) -> &std::fs::File {
        &self.file
    }

    /// Drop this file's session entry, so its next use hashes it again. For
    /// a native load or parse that failed: the bytes may have changed after
    /// the check in a way the identity did not show.
    pub(crate) fn forget(&self) {
        let mut models = self.session.models();
        if models.verified.get(&self.key).is_some_and(|entry| {
            entry.sha256 == self.sha256 && entry.identity.same_except_change_time(&self.identity)
        }) {
            models.verified.remove(&self.key);
        }
    }

    /// Confirm the descriptor, rehashing against the pin if only change time
    /// differs. Core ML/macOS can add metadata on a first load.
    fn confirmed_identity(&self) -> Result<ModelArtifactIdentity> {
        let now = self
            .file
            .metadata()
            .ok()
            .and_then(|metadata| model_artifact_identity(&metadata).ok());
        if now.as_ref() == Some(&self.identity) {
            return Ok(self.identity.clone());
        }
        self.forget();
        if now
            .as_ref()
            .is_some_and(|now| now.same_except_change_time(&self.identity))
        {
            let lock = self.session.file_lock(&self.key);
            let _hashing = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let (digest, identity) = hash_open_file(&self.file, &self.key, |_| {})?;
            let entry = Entry {
                sha256: self.sha256.clone(),
                identity: identity.clone(),
            };
            if digest != self.sha256 {
                self.session.models().reject(self.key.clone(), entry);
                return Err(ModelIntegrityMismatch {
                    path: self.key.clone(),
                }
                .into());
            }
            // The file must retain its object, size and modification time
            // throughout revalidation, not merely return the right digest.
            if identity.same_except_change_time(&self.identity) {
                self.session.models().record(self.key.clone(), entry);
                return Ok(identity);
            }
        }
        Err(ModelArtifactChanged {
            path: self.key.clone(),
        }
        .into())
    }

    pub(crate) fn confirm_unchanged(&self) -> Result<()> {
        self.confirmed_identity().map(|_| ())
    }

    /// Confirm the bytes and require the path to still name that exact file.
    pub(crate) fn confirm_path_unchanged(&self) -> Result<()> {
        let identity = self.confirmed_identity()?;
        let at_path = std::fs::metadata(&self.key)
            .ok()
            .and_then(|metadata| model_artifact_identity(&metadata).ok());
        if at_path.as_ref() == Some(&identity) {
            return Ok(());
        }
        self.forget();
        Err(ModelArtifactChanged {
            path: self.key.clone(),
        }
        .into())
    }

    /// Run a native load of this file through its verified descriptor. A
    /// failed load drops the session entry; a write to the file during the
    /// load fails it.
    pub(crate) fn load<T>(&self, load: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
        match load(&self.load_path) {
            Ok(value) => {
                self.confirm_unchanged()?;
                Ok(value)
            }
            Err(error) => {
                self.forget();
                Err(error)
            }
        }
    }
}

/// Open `path` for loading, hashing it first unless this session already
/// verified a file with the identity this descriptor reports. Blocking: it
/// can read the whole file.
pub(crate) fn open_verified_model_artifact(
    path: &Path,
    expected_sha256: &str,
) -> Result<VerifiedModelArtifact> {
    open_verified_model_artifact_in(session(), path, expected_sha256).map(|(artifact, _)| artifact)
}

/// The second value says whether this call hashed the file.
pub(crate) fn open_verified_model_artifact_in(
    session: &'static ModelTrustSession,
    path: &Path,
    expected_sha256: &str,
) -> Result<(VerifiedModelArtifact, bool)> {
    assert_pinned_digest_is_never_empty(Some(expected_sha256));
    anyhow::ensure!(
        !expected_sha256.is_empty(),
        "Refusing to load {} without a pinned digest",
        path.display()
    );
    let file = std::fs::File::open(path)
        .with_context(|| format!("Could not open model file {}", path.display()))?;
    let metadata = file.metadata()?;
    anyhow::ensure!(
        metadata.is_file(),
        "Model artifact is not a regular file: {}",
        path.display()
    );
    let key = session_key(path)?;
    let lock = session.file_lock(&key);
    let _hashing = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    // Read after taking the lock, so a hash that finished while this call
    // waited is seen.
    let opened = Entry {
        sha256: expected_sha256.to_string(),
        identity: model_artifact_identity(&file.metadata()?)?,
    };
    let known = SessionModels::matches(&session.models().verified, &key, &opened);
    let (identity, hashed) = if known {
        (opened.identity, false)
    } else {
        let (digest, identity) = hash_open_file(&file, path, |_| {})?;
        let entry = Entry {
            sha256: expected_sha256.to_string(),
            identity: identity.clone(),
        };
        if digest != expected_sha256 {
            session.models().reject(key, entry);
            return Err(ModelIntegrityMismatch {
                path: path.to_path_buf(),
            }
            .into());
        }
        session.models().record(key.clone(), entry);
        (identity, true)
    };

    let load_path = load_path_for(&file, &key, &identity);
    Ok((
        VerifiedModelArtifact {
            file,
            load_path,
            key,
            sha256: expected_sha256.to_string(),
            identity,
            session,
        },
        hashed,
    ))
}

/// A model file opened so its user can hash the very bytes it reads (a heap
/// copy or a mapping) instead of the file being hashed once for the check and
/// read again for use. [`Self::finish`] turns it into a
/// [`VerifiedModelArtifact`] when that digest matches the pin.
pub(crate) struct ModelArtifactToHash {
    file: std::fs::File,
    path: PathBuf,
    key: PathBuf,
    identity: ModelArtifactIdentity,
    session: &'static ModelTrustSession,
}

pub(crate) fn open_model_artifact_to_hash(path: &Path) -> Result<ModelArtifactToHash> {
    let file = std::fs::File::open(path)
        .with_context(|| format!("Could not open model file {}", path.display()))?;
    let metadata = file.metadata()?;
    anyhow::ensure!(
        metadata.is_file(),
        "Model artifact is not a regular file: {}",
        path.display()
    );
    Ok(ModelArtifactToHash {
        identity: model_artifact_identity(&metadata)?,
        key: session_key(path)?,
        path: path.to_path_buf(),
        file,
        session: session(),
    })
}

impl ModelArtifactToHash {
    /// Read from here, from offset zero.
    pub(crate) fn as_file(&self) -> &std::fs::File {
        &self.file
    }

    /// `used_sha256` is the digest of every byte the caller read or mapped
    /// from [`Self::as_file`]. The descriptor must still have the identity it
    /// had when opened, so the bytes cannot have been written mid-read.
    pub(crate) fn finish(
        self,
        used_sha256: &str,
        expected_sha256: &str,
    ) -> Result<VerifiedModelArtifact> {
        assert_pinned_digest_is_never_empty(Some(expected_sha256));
        #[cfg(test)]
        note_full_hash_for_tests(&self.path);
        let now = model_artifact_identity(&self.file.metadata()?)?;
        anyhow::ensure!(
            now == self.identity,
            "Model artifact changed while it was being read: {}",
            self.path.display()
        );
        let entry = Entry {
            sha256: expected_sha256.to_string(),
            identity: self.identity.clone(),
        };
        if expected_sha256.is_empty() || used_sha256 != expected_sha256 {
            self.session.models().reject(self.key, entry);
            return Err(ModelIntegrityMismatch { path: self.path }.into());
        }
        self.session.models().record(self.key.clone(), entry);
        let load_path = load_path_for(&self.file, &self.key, &self.identity);
        Ok(VerifiedModelArtifact {
            file: self.file,
            load_path,
            key: self.key,
            sha256: expected_sha256.to_string(),
            identity: self.identity,
            session: self.session,
        })
    }
}

/// The whole of `path`, hashed as it is read: the returned copy is the one
/// that matched `expected_sha256`.
pub(crate) fn read_verified_model_bytes(path: &Path, expected_sha256: &str) -> Result<Vec<u8>> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let file = open_model_artifact_to_hash(path)?;
    let mut bytes = Vec::new();
    file.as_file()
        .read_to_end(&mut bytes)
        .with_context(|| format!("Could not read model file {}", path.display()))?;
    file.finish(&hex::encode(Sha256::digest(&bytes)), expected_sha256)?;
    Ok(bytes)
}

/// A path that opens the verified file itself rather than whatever the model
/// path names later. On macOS `/.vol/<device>/<inode>` names the inode, and
/// the open descriptor keeps that inode from being freed and reused (once its
/// last link is removed the lookup fails, so a load fails closed); each
/// open of it gets its own offset, which loaders that open a file several
/// times (transcribe.cpp reads the magic, then the header, then the
/// tensors) need. A macOS `/dev/fd/N` open shares the descriptor's offset,
/// so it serves only as the fallback for a volume without `/.vol` lookups.
/// Linux `/proc/self/fd/N` reopens the file with its own offset.
fn load_path_for(file: &std::fs::File, key: &Path, identity: &ModelArtifactIdentity) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        let by_inode = PathBuf::from(format!("/.vol/{}/{}", identity.device, identity.inode));
        let same_file = std::fs::File::open(&by_inode)
            .and_then(|opened| opened.metadata())
            .ok()
            .and_then(|metadata| model_artifact_identity(&metadata).ok())
            .is_some_and(|opened| opened == *identity);
        let _ = key;
        if same_file {
            by_inode
        } else {
            PathBuf::from(format!("/dev/fd/{}", file.as_raw_fd()))
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::os::fd::AsRawFd;
        let _ = (key, identity);
        PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()))
    }
    #[cfg(not(unix))]
    {
        let _ = (file, identity);
        key.to_path_buf()
    }
}

/// Whether a present, pinned file may be offered as installed: it is a
/// regular file and this session has not found that exact file wrong. Cheap
/// (one `stat`); it does not read the file. Loading still verifies it.
pub(crate) fn is_model_artifact_installed(path: &Path, expected_sha256: Option<&str>) -> bool {
    is_model_artifact_installed_in(session(), path, expected_sha256)
}

pub(crate) fn is_model_artifact_installed_in(
    session: &ModelTrustSession,
    path: &Path,
    expected_sha256: Option<&str>,
) -> bool {
    assert_pinned_digest_is_never_empty(expected_sha256);
    let Some(digest) = expected_sha256.filter(|digest| !digest.is_empty()) else {
        return false;
    };
    let Some(entry) = current_entry(path, digest) else {
        return false;
    };
    let Ok(key) = session_key(path) else {
        return false;
    };
    !SessionModels::matches(&session.models().rejected, &key, &entry)
}

/// Whether this session already hashed this exact file against `sha256`.
pub(crate) fn is_model_artifact_verified(path: &Path, expected_sha256: &str) -> bool {
    is_model_artifact_verified_in(session(), path, expected_sha256)
}

pub(crate) fn is_model_artifact_verified_in(
    session: &ModelTrustSession,
    path: &Path,
    expected_sha256: &str,
) -> bool {
    let (Some(entry), Ok(key)) = (current_entry(path, expected_sha256), session_key(path)) else {
        return false;
    };
    SessionModels::matches(&session.models().verified, &key, &entry)
}

fn current_entry(path: &Path, expected_sha256: &str) -> Option<Entry> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    Some(Entry {
        sha256: expected_sha256.to_string(),
        identity: model_artifact_identity(&metadata).ok()?,
    })
}

/// Drop any session record of `path`, verified or rejected.
pub(crate) fn forget_verified_model(path: &Path) {
    if let Ok(key) = session_key(path) {
        session().models().forget(&key);
    }
}

/// Drop every session record under `directory` (canonical).
pub(crate) fn forget_verified_models_under(directory: &Path) {
    session().models().forget_under(directory);
}

/// Hash `path` now and remember it for this session. `None` means "not yet
/// pinned": nothing is hashed and the file is accepted on existence.
/// `Ok(false)` is a mismatch.
pub(crate) async fn verify_or_record_model_integrity(
    path: &Path,
    expected_sha256: Option<&str>,
) -> Result<bool> {
    verify_or_record_model_integrity_in(session(), path, expected_sha256).await
}

pub(crate) async fn verify_or_record_model_integrity_in(
    session: &'static ModelTrustSession,
    path: &Path,
    expected_sha256: Option<&str>,
) -> Result<bool> {
    assert_pinned_digest_is_never_empty(expected_sha256);
    let Some(expected_sha256) = expected_sha256 else {
        let exists = tokio::fs::metadata(path).await.is_ok();
        if exists {
            tracing::warn!(
                "Model {} has no pinned SHA256 — skipping integrity verification",
                path.display()
            );
        }
        return Ok(exists);
    };
    if expected_sha256.is_empty() {
        // Reached only in release builds, where the debug_assert! above is
        // compiled out. Fail closed instead of reproducing the old silent
        // bypass.
        anyhow::bail!(
            "Refusing to verify {}: expected_sha256 was an empty string, not None. \
             This is a bug in the artifact table, not a legitimate \"unpinned\" model.",
            path.display()
        );
    }
    let owned_path = path.to_path_buf();
    let owned_digest = expected_sha256.to_string();
    let result = tokio::task::spawn_blocking(move || {
        open_verified_model_artifact_in(session, &owned_path, &owned_digest)
    })
    .await
    .map_err(|error| anyhow::anyhow!("Model check stopped: {error}"))?;
    match result {
        Ok(_) => {
            tokio::fs::remove_file(super::legacy_integrity_receipt_path(path))
                .await
                .ok();
            Ok(true)
        }
        Err(error) if is_integrity_mismatch(&error) => Ok(false),
        Err(error) => Err(error),
    }
}

/// Hash `path` and remember it when it matches `expected_sha256`; an error
/// otherwise. For a file just downloaded, so its first load does not wait.
pub(crate) async fn verify_and_remember_model(path: &Path, expected_sha256: &str) -> Result<()> {
    anyhow::ensure!(
        verify_or_record_model_integrity_in(session(), path, Some(expected_sha256)).await?,
        "Refusing to record a model as verified when its bytes do not match the pin"
    );
    Ok(())
}

/// Test seam: record `path` as verified without hashing it. Provider tests
/// use tiny stand-ins for multi-gigabyte pinned artifacts, so this skips the
/// hash while keeping the identity binding and the load path real.
#[cfg(test)]
pub(crate) async fn mark_model_verified_for_tests(
    path: &Path,
    expected_sha256: &str,
) -> Result<()> {
    let metadata = std::fs::metadata(path)?;
    let entry = Entry {
        sha256: expected_sha256.to_string(),
        identity: model_artifact_identity(&metadata)?,
    };
    session().models().record(session_key(path)?, entry);
    Ok(())
}

#[derive(Debug, Default)]
pub(crate) struct PreverifyReport {
    pub hashed: usize,
    pub already_verified: usize,
    pub bytes: u64,
    pub rejected: Vec<PathBuf>,
    pub errors: Vec<(PathBuf, String)>,
    pub elapsed: std::time::Duration,
}

/// Verify `artifacts` now, one after another, on the calling thread. Missing
/// files are skipped. For the background pass and its tests.
pub(crate) fn preverify_models_in(
    session: &'static ModelTrustSession,
    artifacts: &[(PathBuf, String)],
) -> PreverifyReport {
    let started = std::time::Instant::now();
    let mut report = PreverifyReport::default();
    for (path, digest) in artifacts {
        if digest.is_empty() || !path.is_file() {
            continue;
        }
        if is_model_artifact_verified_in(session, path, digest) {
            report.already_verified += 1;
            continue;
        }
        if !is_model_artifact_installed_in(session, path, Some(digest)) {
            continue;
        }
        match open_verified_model_artifact_in(session, path, digest) {
            Ok((artifact, hashed)) => {
                if hashed {
                    report.hashed += 1;
                    report.bytes += artifact.as_file().metadata().map_or(0, |m| m.len());
                } else {
                    report.already_verified += 1;
                }
            }
            Err(error) if is_integrity_mismatch(&error) => report.rejected.push(path.clone()),
            Err(error) => report.errors.push((path.clone(), format!("{error:#}"))),
        }
    }
    report.elapsed = started.elapsed();
    report
}

/// The background check's one-line summary, or `None` when it hashed
/// nothing and nothing failed. Each outcome is counted on its own, so a run
/// whose only file failed never reads as "checked 0".
fn preverify_summary(label: &str, report: &PreverifyReport) -> Option<String> {
    let mut outcomes = Vec::new();
    if report.hashed > 0 {
        outcomes.push(format!(
            "{} matched ({} MB)",
            report.hashed,
            report.bytes / (1024 * 1024)
        ));
    }
    if !report.rejected.is_empty() {
        outcomes.push(format!("{} did not match", report.rejected.len()));
    }
    if !report.errors.is_empty() {
        outcomes.push(format!("{} could not be read", report.errors.len()));
    }
    if outcomes.is_empty() {
        return None;
    }
    Some(format!(
        "Background {label} model check took {} ms: {}; {} already checked",
        report.elapsed.as_millis(),
        outcomes.join(", "),
        report.already_verified
    ))
}

/// Verify the models a first dictation or meeting will need, on a dedicated
/// low-priority thread, so their first load finds them already checked. A
/// load that starts first waits only for the file being hashed.
pub(crate) fn preverify_models_in_background(
    label: &'static str,
    artifacts: Vec<(PathBuf, String)>,
) -> Option<std::thread::JoinHandle<PreverifyReport>> {
    if artifacts.is_empty() {
        return None;
    }
    std::thread::Builder::new()
        .name("model-preverify".into())
        .spawn(move || {
            let _ = crate::qos::WorkClass::Background.apply_to_current_thread();
            let report = preverify_models_in(session(), &artifacts);
            if let Some(summary) = preverify_summary(label, &report) {
                tracing::info!("{summary}");
            }
            for path in &report.rejected {
                tracing::warn!(
                    "Local model failed application-pinned integrity verification: {}",
                    path.display()
                );
            }
            for (path, error) in &report.errors {
                tracing::warn!("Could not check local model '{}': {error}", path.display());
            }
            report
        })
        .map_err(|error| tracing::warn!("Could not start the model check: {error}"))
        .ok()
}

/// The file earlier development builds kept verified identities in. It is
/// never read: a same-user process could forge its records.
pub(crate) const LEGACY_VERIFIED_MODEL_CACHE_FILE_NAME: &str = "verified-models.json";

/// Delete that file, and any temporary copy of it, from `app_data_dir`.
pub(crate) fn remove_legacy_verified_model_cache(app_data_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(app_data_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name == LEGACY_VERIFIED_MODEL_CACHE_FILE_NAME
            || name.starts_with(&format!("{LEGACY_VERIFIED_MODEL_CACHE_FILE_NAME}.tmp-"))
        {
            if let Err(error) = std::fs::remove_file(entry.path()) {
                tracing::warn!("Could not remove the old verified-model list: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_background_check_whose_only_file_failed_says_so() {
        let report = |hashed, rejected: &[&str], errors: &[&str]| PreverifyReport {
            hashed,
            already_verified: 2,
            bytes: hashed as u64 * 3 * 1024 * 1024,
            rejected: rejected.iter().map(PathBuf::from).collect(),
            errors: errors
                .iter()
                .map(|path| (PathBuf::from(path), "denied".to_string()))
                .collect(),
            elapsed: std::time::Duration::from_millis(40),
        };
        assert_eq!(
            preverify_summary("dictation", &report(0, &["/m/a.bin"], &[])).as_deref(),
            Some("Background dictation model check took 40 ms: 1 did not match; 2 already checked")
        );
        assert_eq!(
            preverify_summary("dictation", &report(0, &[], &["/m/a.bin"])).as_deref(),
            Some(
                "Background dictation model check took 40 ms: 1 could not be read; 2 already checked"
            )
        );
        assert_eq!(
            preverify_summary("meeting", &report(1, &["/m/b.bin"], &[])).as_deref(),
            Some(
                "Background meeting model check took 40 ms: 1 matched (3 MB), 1 did not match; \
                 2 already checked"
            )
        );
        assert_eq!(preverify_summary("dictation", &report(0, &[], &[])), None);
    }
}
