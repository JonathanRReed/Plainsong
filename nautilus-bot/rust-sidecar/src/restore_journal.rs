use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const JOURNAL: &str = ".restore-transaction.json";
const LOCK: &str = ".plainsong-storage.lock";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Component {
    Database,
    Recordings,
    Settings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Staging,
    Pending,
    Accepted,
    RolledBack,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    component: Component,
    original_present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    transaction_id: uuid::Uuid,
    phase: Phase,
    components: Vec<Entry>,
}

#[derive(Debug, Clone)]
struct Roots {
    data: PathBuf,
    settings: PathBuf,
}

impl Roots {
    fn new(data: &Path, settings: &Path) -> Result<Self> {
        let parent = settings.parent().context("Settings path has no parent")?;
        crate::safe_fs::ensure_directory_without_links(data)?;
        crate::safe_fs::ensure_directory_without_links(parent)?;
        Ok(Self {
            data: data.canonicalize()?,
            settings: parent.canonicalize()?.join(
                settings
                    .file_name()
                    .context("Settings path has no filename")?,
            ),
        })
    }

    fn parents(&self) -> Vec<PathBuf> {
        let mut parents = vec![
            self.data.clone(),
            self.settings.parent().unwrap().to_path_buf(),
        ];
        parents.sort();
        parents.dedup();
        parents
    }

    fn live(&self, component: Component) -> PathBuf {
        match component {
            Component::Database => self.data.join("plainsong.db"),
            Component::Recordings => self.data.join("recordings"),
            Component::Settings => self.settings.clone(),
        }
    }

    fn journal(&self) -> PathBuf {
        self.data.join(JOURNAL)
    }
}

fn artifact(live: &Path, kind: &str, id: uuid::Uuid) -> PathBuf {
    live.with_file_name(format!(
        ".{}.restore-{kind}.{id}",
        live.file_name().unwrap().to_string_lossy()
    ))
}

fn metadata(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(value) if value.file_type().is_symlink() => {
            bail!("Restore path is a symbolic link: {}", path.display())
        }
        Ok(value) if value.is_file() || value.is_dir() => Ok(Some(value)),
        Ok(_) => bail!("Restore path has an unsupported type: {}", path.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => {
            Err(error).with_context(|| format!("Inspect restore path {}", path.display()))
        }
    }
}

fn inspect_tree(path: &Path) -> Result<()> {
    if metadata(path)?.is_some_and(|value| value.is_dir()) {
        crate::safe_fs::ensure_directory_without_links(path)?;
        for entry in fs::read_dir(path)? {
            inspect_tree(&entry?.path())?;
        }
    }
    Ok(())
}

pub(crate) fn sync_path(path: &Path) -> Result<()> {
    match metadata(path)? {
        Some(value) if value.is_dir() => {
            crate::safe_fs::ensure_directory_without_links(path)?;
            for entry in fs::read_dir(path)? {
                sync_path(&entry?.path())?;
            }
            #[cfg(unix)]
            File::open(path)?.sync_all()?;
        }
        Some(_) => crate::safe_fs::open_regular_file_without_links(path)?.sync_all()?,
        None => bail!(
            "Restore component disappeared before sync: {}",
            path.display()
        ),
    }
    sync_parent(path)
}

pub(crate) fn sync_parent(path: &Path) -> Result<()> {
    let parent = path.parent().context("Restore path has no parent")?;
    crate::safe_fs::ensure_directory_without_links(parent)?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn remove(path: &Path) -> Result<()> {
    match metadata(path)? {
        None => return Ok(()),
        Some(value) if value.is_dir() => {
            inspect_tree(path)?;
            fs::remove_dir_all(path)?;
        }
        Some(_) => fs::remove_file(path)?,
    }
    sync_parent(path)
}

fn copy_durable(source: &Path, target: &Path) -> Result<()> {
    let source_metadata = metadata(source)?.context("Restore recovery source disappeared")?;
    if source_metadata.is_dir() {
        crate::safe_fs::ensure_directory_without_links(source)?;
        fs::create_dir(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_durable(&entry.path(), &target.join(entry.file_name()))?;
        }
        #[cfg(unix)]
        File::open(target)?.sync_all()?;
        sync_parent(target)?;
    } else {
        let mut input = crate::safe_fs::open_regular_file_without_links(source)?;
        crate::safe_fs::atomic_replace_with(target, |output| {
            std::io::copy(&mut input, output)?;
            Ok(())
        })?;
    }
    Ok(())
}

pub(crate) struct ProfileGuard {
    _locks: Vec<File>,
}

impl ProfileGuard {
    fn acquire(roots: &Roots) -> Result<Self> {
        let mut locks = Vec::new();
        for parent in roots.parents() {
            crate::safe_fs::ensure_directory_without_links(&parent)?;
            let path = parent.join(LOCK);
            metadata(&path)?;
            let mut options = OpenOptions::new();
            options.read(true).write(true).create(true).truncate(false);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options
                    .mode(0o600)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
            }
            let file = options.open(&path)?;
            if !file.metadata()?.is_file() {
                bail!("Plainsong storage lock is not a regular file");
            }
            match file.try_lock() {
                Ok(()) => locks.push(file),
                Err(std::fs::TryLockError::WouldBlock) => {
                    bail!("Another Plainsong process is using this data or settings directory")
                }
                Err(std::fs::TryLockError::Error(error)) => return Err(error.into()),
            }
        }
        Ok(Self { _locks: locks })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct RestoreTransaction {
    roots: Roots,
    record: Record,
}

impl RestoreTransaction {
    pub(crate) fn begin(
        data: &Path,
        settings: &Path,
        transaction_id: &str,
        components: &[Component],
    ) -> Result<Self> {
        let roots = Roots::new(data, settings)?;
        if metadata(&roots.journal())?.is_some() {
            bail!("An earlier restore transaction needs recovery before another restore");
        }
        reject_unjournaled_artifacts(&roots, Some(transaction_id))?;
        let transaction_id = uuid::Uuid::parse_str(transaction_id)?;
        let mut entries = Vec::new();
        for component in components {
            let live = roots.live(*component);
            inspect_tree(&live)?;
            entries.push(Entry {
                component: *component,
                original_present: metadata(&live)?.is_some(),
            });
        }
        let transaction = Self {
            roots,
            record: Record {
                version: 1,
                transaction_id,
                phase: Phase::Staging,
                components: entries,
            },
        };
        transaction.validate()?;
        transaction.write()?;
        Ok(transaction)
    }

    fn validate(&self) -> Result<()> {
        if self.record.version != 1
            || self.record.components.is_empty()
            || self.record.components.len() > 3
        {
            bail!("Unsupported restore transaction record");
        }
        for (index, entry) in self.record.components.iter().enumerate() {
            if self.record.components[..index]
                .iter()
                .any(|other| other.component == entry.component)
            {
                bail!("Duplicate restore transaction component");
            }
            let live = self.roots.live(entry.component);
            for path in [
                &live,
                &artifact(&live, "stage", self.record.transaction_id),
                &artifact(&live, "rollback", self.record.transaction_id),
                &artifact(&live, "recover", self.record.transaction_id),
            ] {
                inspect_tree(path)?;
                if let Some(value) = metadata(path)? {
                    if value.is_dir() != (entry.component == Component::Recordings) {
                        bail!(
                            "Restore component path has the wrong type: {}",
                            path.display()
                        );
                    }
                }
            }
            if self.record.phase == Phase::Accepted && metadata(&live)?.is_none() {
                bail!("Accepted restore component is missing: {}", live.display());
            }
            if self.record.phase == Phase::RolledBack
                && entry.original_present
                && metadata(&live)?.is_none()
            {
                bail!(
                    "Recovered restore component is missing; recovery files retained: {}",
                    live.display()
                );
            }
            if !entry.original_present
                && metadata(&artifact(&live, "rollback", self.record.transaction_id))?.is_some()
            {
                bail!("Unexpected recovery copy for an originally absent restore component");
            }
            if self.record.phase == Phase::Staging
                && metadata(&artifact(&live, "rollback", self.record.transaction_id))?.is_some()
            {
                bail!("An uncommitted restore unexpectedly has a recovery copy");
            }
        }
        Ok(())
    }

    fn write(&self) -> Result<()> {
        let bytes = serde_json::to_vec(&self.record)?;
        crate::safe_fs::atomic_replace_with(&self.roots.journal(), |file| {
            file.write_all(&bytes)?;
            Ok(())
        })
    }

    pub(crate) fn prepare(&mut self) -> Result<()> {
        if self.record.phase != Phase::Staging {
            bail!("Only a staged restore can become pending");
        }
        self.validate()?;
        for entry in &self.record.components {
            sync_path(&artifact(
                &self.roots.live(entry.component),
                "stage",
                self.record.transaction_id,
            ))?;
        }
        self.record.phase = Phase::Pending;
        self.write()
    }

    pub(crate) fn mark_accepted(&mut self) -> Result<()> {
        if self.record.phase != Phase::Pending {
            bail!("Only a pending restore can be accepted");
        }
        self.validate()?;
        self.record.phase = Phase::Accepted;
        self.write()
    }

    pub(crate) fn rollback(&mut self) -> Result<()> {
        if self.record.phase == Phase::Staging {
            self.validate()?;
            self.record.phase = Phase::RolledBack;
            self.write()?;
            return self.cleanup();
        }
        if self.record.phase != Phase::Pending {
            bail!("A decided restore cannot be rolled back");
        }
        self.validate()?;
        for entry in self.record.components.iter().rev() {
            let live = self.roots.live(entry.component);
            let rollback = artifact(&live, "rollback", self.record.transaction_id);
            let recovery = artifact(&live, "recover", self.record.transaction_id);
            if entry.original_present {
                if metadata(&rollback)?.is_some() {
                    // Keep this source until every component is durably rolled back.
                    remove(&recovery)?;
                    copy_durable(&rollback, &recovery)?;
                    remove(&live)?;
                    fs::rename(&recovery, &live)?;
                    sync_parent(&live)?;
                } else if metadata(&live)?.is_none()
                    || metadata(&artifact(&live, "stage", self.record.transaction_id))?.is_none()
                {
                    bail!("Original restore component cannot be confirmed; recovery files retained: {}", live.display());
                }
            } else {
                remove(&live)?;
            }
        }
        self.record.phase = Phase::RolledBack;
        self.write()?;
        self.cleanup()
    }

    pub(crate) fn cleanup(&self) -> Result<()> {
        if matches!(self.record.phase, Phase::Staging | Phase::Pending) {
            bail!("Pending restore recovery copies cannot be cleaned");
        }
        self.validate()?;
        for entry in &self.record.components {
            let live = self.roots.live(entry.component);
            for kind in ["stage", "rollback", "recover"] {
                remove(&artifact(&live, kind, self.record.transaction_id))?;
            }
        }
        remove(&self.roots.journal())
    }
}

fn reject_unjournaled_artifacts(roots: &Roots, staging_id: Option<&str>) -> Result<()> {
    for component in [
        Component::Database,
        Component::Recordings,
        Component::Settings,
    ] {
        let live = roots.live(component);
        let prefix = format!(".{}.restore-", live.file_name().unwrap().to_string_lossy());
        for entry in fs::read_dir(live.parent().unwrap())? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(&prefix) {
                let permitted = staging_id.is_some_and(|id| name == format!("{prefix}stage.{id}"));
                if !permitted {
                    bail!("An older restore artifact needs manual recovery before Plainsong can open this workspace: {}", entry.path().display());
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn recover_at_startup(data: &Path, settings: &Path) -> Result<ProfileGuard> {
    let roots = Roots::new(data, settings)?;
    let guard = ProfileGuard::acquire(&roots)?;
    if metadata(&roots.journal())?.is_some() {
        let mut file = crate::safe_fs::open_regular_file_without_links(&roots.journal())?;
        if file.metadata()?.len() > 16 * 1024 {
            bail!("Restore transaction record is too large; recovery files retained");
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let record: Record = serde_json::from_slice(&bytes)
            .context("Restore transaction record is invalid; recovery files retained")?;
        let mut transaction = RestoreTransaction {
            roots: roots.clone(),
            record,
        };
        transaction.validate()?;
        match transaction.record.phase {
            Phase::Staging | Phase::Pending => transaction.rollback()?,
            Phase::Accepted | Phase::RolledBack => transaction.cleanup()?,
        }
    }
    reject_unjournaled_artifacts(&roots, None)?;
    Ok(guard)
}

#[cfg(test)]
#[path = "restore_journal_tests.rs"]
mod tests;
