use std::ffi::OsString;
use std::path::PathBuf;

fn absolute_override(value: OsString) -> Option<PathBuf> {
    let path = PathBuf::from(value);
    path.is_absolute().then_some(path)
}

fn directory_with_override(
    variable: &str,
    fallback: impl FnOnce() -> Option<PathBuf>,
) -> Option<PathBuf> {
    match std::env::var_os(variable) {
        Some(value) => absolute_override(value),
        None => fallback(),
    }
}

pub(crate) fn data_dir() -> Option<PathBuf> {
    directory_with_override("PLAINSONG_DATA_DIR", dirs::data_dir)
}

pub(crate) fn config_dir() -> Option<PathBuf> {
    directory_with_override("PLAINSONG_CONFIG_DIR", dirs::config_dir)
}

#[cfg(test)]
mod tests {
    use super::absolute_override;
    use std::ffi::OsString;
    use std::path::PathBuf;

    #[test]
    fn accepts_absolute_directory_override() {
        assert_eq!(
            absolute_override(OsString::from("/tmp/plainsong-qa")),
            Some(PathBuf::from("/tmp/plainsong-qa"))
        );
    }

    #[test]
    fn rejects_relative_directory_override_instead_of_using_live_data() {
        assert_eq!(
            absolute_override(OsString::from("relative/plainsong-qa")),
            None
        );
    }
}
