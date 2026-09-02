//! A throwaway directory for tests, removed on drop. Stands in for the
//! `tempfile` crate, which is not a dependency of this crate.

use std::path::{Path, PathBuf};

pub(crate) struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub(crate) fn new(prefix: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("plainsong-test-{prefix}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create temp dir");
        Self { path }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
