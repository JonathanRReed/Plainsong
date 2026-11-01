use super::*;
use std::fs;
use std::path::{Path, PathBuf};

struct Fixture {
    root: PathBuf,
    data: PathBuf,
    settings: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "plainsong-restore-journal-test-{}",
            uuid::Uuid::new_v4()
        ));
        let data = root.join("data");
        let settings = root.join("settings").join("settings.json");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        Self {
            root,
            data,
            settings,
        }
    }

    fn live(&self, component: Component) -> PathBuf {
        Roots::new(&self.data, &self.settings)
            .unwrap()
            .live(component)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn put(path: &Path, component: Component, value: &[u8]) {
    match component {
        Component::Recordings => {
            fs::create_dir_all(path).unwrap();
            fs::write(path.join("meeting.wav"), value).unwrap();
        }
        Component::Database | Component::Settings => {
            fs::write(path, value).unwrap();
        }
    }
}

fn bytes(path: &Path, component: Component) -> Option<Vec<u8>> {
    match component {
        Component::Recordings => path
            .join("meeting.wav")
            .exists()
            .then(|| fs::read(path.join("meeting.wav")).unwrap()),
        Component::Database | Component::Settings => path.exists().then(|| fs::read(path).unwrap()),
    }
}

fn start(
    fixture: &Fixture,
    components: &[Component],
    originals: &[Option<&[u8]>],
) -> (RestoreTransaction, uuid::Uuid) {
    let id = uuid::Uuid::new_v4();
    for (component, original) in components.iter().zip(originals) {
        let live = fixture.live(*component);
        if let Some(original) = original {
            put(&live, *component, original);
        }
        put(&artifact(&live, "stage", id), *component, b"candidate");
    }
    let mut transaction = RestoreTransaction::begin(
        &fixture.data,
        &fixture.settings,
        &id.to_string(),
        components,
    )
    .unwrap();
    transaction.prepare().unwrap();
    (transaction, id)
}

fn publish_candidate(fixture: &Fixture, component: Component, id: uuid::Uuid, had_original: bool) {
    let live = fixture.live(component);
    if had_original {
        fs::rename(&live, artifact(&live, "rollback", id)).unwrap();
    }
    fs::rename(artifact(&live, "stage", id), &live).unwrap();
}

#[test]
fn pending_transaction_before_first_swap_keeps_original_bytes() {
    let fixture = Fixture::new();
    let components = [Component::Database];
    let (_transaction, _id) = start(&fixture, &components, &[Some(b"original database")]);

    drop(recover_at_startup(&fixture.data, &fixture.settings).unwrap());

    assert_eq!(
        bytes(&fixture.live(Component::Database), Component::Database),
        Some(b"original database".to_vec())
    );
    assert!(!fixture.data.join(JOURNAL).exists());
}

#[test]
fn interrupted_staging_keeps_original_and_discards_partial_stage() {
    let fixture = Fixture::new();
    let component = Component::Database;
    let live = fixture.live(component);
    fs::write(&live, b"original database").unwrap();
    let id = uuid::Uuid::new_v4();
    let transaction = RestoreTransaction::begin(
        &fixture.data,
        &fixture.settings,
        &id.to_string(),
        &[component],
    )
    .unwrap();
    fs::write(artifact(&live, "stage", id), b"partial candidate").unwrap();
    drop(transaction);

    drop(recover_at_startup(&fixture.data, &fixture.settings).unwrap());

    assert_eq!(bytes(&live, component), Some(b"original database".to_vec()));
    assert!(!artifact(&live, "stage", id).exists());
    assert!(!fixture.data.join(JOURNAL).exists());
}

#[test]
fn pending_transaction_with_missing_live_restores_rollback_bytes() {
    let fixture = Fixture::new();
    let components = [Component::Database];
    let (_transaction, id) = start(&fixture, &components, &[Some(b"original database")]);
    let live = fixture.live(Component::Database);
    fs::rename(&live, artifact(&live, "rollback", id)).unwrap();

    drop(recover_at_startup(&fixture.data, &fixture.settings).unwrap());

    assert_eq!(
        bytes(&live, Component::Database),
        Some(b"original database".to_vec())
    );
}

#[test]
fn pending_transaction_with_published_candidate_restores_original_bytes() {
    let fixture = Fixture::new();
    let components = [Component::Database];
    let (_transaction, id) = start(&fixture, &components, &[Some(b"original database")]);
    publish_candidate(&fixture, Component::Database, id, true);

    drop(recover_at_startup(&fixture.data, &fixture.settings).unwrap());

    assert_eq!(
        bytes(&fixture.live(Component::Database), Component::Database),
        Some(b"original database".to_vec())
    );
}

#[test]
fn accepted_transaction_keeps_candidate_and_cleans_restore_files() {
    let fixture = Fixture::new();
    let components = [Component::Database];
    let (mut transaction, id) = start(&fixture, &components, &[Some(b"original database")]);
    publish_candidate(&fixture, Component::Database, id, true);
    transaction.mark_accepted().unwrap();

    drop(recover_at_startup(&fixture.data, &fixture.settings).unwrap());

    let live = fixture.live(Component::Database);
    assert_eq!(
        bytes(&live, Component::Database),
        Some(b"candidate".to_vec())
    );
    for kind in ["stage", "rollback", "recover"] {
        assert!(!artifact(&live, kind, id).exists());
    }
    assert!(!fixture.data.join(JOURNAL).exists());
}

#[test]
fn rolled_back_terminal_record_only_cleans_up() {
    let fixture = Fixture::new();
    let components = [Component::Database];
    let (mut transaction, id) = start(&fixture, &components, &[Some(b"original database")]);
    publish_candidate(&fixture, Component::Database, id, true);
    transaction.record.phase = Phase::RolledBack;
    transaction.write().unwrap();

    drop(recover_at_startup(&fixture.data, &fixture.settings).unwrap());

    let live = fixture.live(Component::Database);
    assert_eq!(
        bytes(&live, Component::Database),
        Some(b"candidate".to_vec())
    );
    assert!(!fixture.data.join(JOURNAL).exists());
}

#[test]
fn originally_absent_component_returns_to_absence() {
    let fixture = Fixture::new();
    let components = [Component::Database];
    let (_transaction, id) = start(&fixture, &components, &[None]);
    publish_candidate(&fixture, Component::Database, id, false);

    drop(recover_at_startup(&fixture.data, &fixture.settings).unwrap());

    assert_eq!(
        bytes(&fixture.live(Component::Database), Component::Database),
        None
    );
}

#[test]
fn pending_transaction_recovers_all_components_across_distinct_roots() {
    let fixture = Fixture::new();
    let components = [
        Component::Database,
        Component::Settings,
        Component::Recordings,
    ];
    let (_transaction, id) = start(
        &fixture,
        &components,
        &[
            Some(b"db before"),
            Some(b"settings before"),
            Some(b"recording before"),
        ],
    );
    for component in components {
        publish_candidate(&fixture, component, id, true);
    }

    drop(recover_at_startup(&fixture.data, &fixture.settings).unwrap());

    assert_eq!(
        bytes(&fixture.live(Component::Database), Component::Database),
        Some(b"db before".to_vec())
    );
    assert_eq!(
        bytes(&fixture.live(Component::Settings), Component::Settings),
        Some(b"settings before".to_vec())
    );
    assert_eq!(
        bytes(&fixture.live(Component::Recordings), Component::Recordings),
        Some(b"recording before".to_vec())
    );
}

#[test]
fn interrupted_recovery_rebuilds_recovery_copy_from_rollback() {
    let fixture = Fixture::new();
    let components = [Component::Database];
    let (_transaction, id) = start(&fixture, &components, &[Some(b"complete original")]);
    publish_candidate(&fixture, Component::Database, id, true);
    let live = fixture.live(Component::Database);
    fs::write(artifact(&live, "recover", id), b"partial recovery copy").unwrap();

    drop(recover_at_startup(&fixture.data, &fixture.settings).unwrap());

    assert_eq!(
        bytes(&live, Component::Database),
        Some(b"complete original".to_vec())
    );
}

#[test]
fn legacy_artifact_without_journal_refuses_startup_without_creating_database() {
    let fixture = Fixture::new();
    let live = fixture.live(Component::Database);
    fs::write(
        artifact(&live, "rollback", uuid::Uuid::new_v4()),
        b"old data",
    )
    .unwrap();

    assert!(recover_at_startup(&fixture.data, &fixture.settings).is_err());
    assert_eq!(bytes(&live, Component::Database), None);
}

#[test]
fn invalid_records_leave_live_and_recovery_bytes_untouched() {
    for record in [
        "{broken json".to_owned(),
        serde_json::json!({"version": 2, "transaction_id": uuid::Uuid::new_v4(), "phase": "pending", "components": [{"component": "database", "original_present": true}]}).to_string(),
        serde_json::json!({"version": 1, "transaction_id": uuid::Uuid::new_v4(), "phase": "pending", "components": [{"component": "database", "original_present": true}, {"component": "database", "original_present": true}]}).to_string(),
    ] {
        let fixture = Fixture::new();
        let live = fixture.live(Component::Database);
        let id = uuid::Uuid::new_v4();
        fs::write(&live, b"candidate bytes").unwrap();
        fs::write(artifact(&live, "rollback", id), b"original bytes").unwrap();
        fs::write(fixture.data.join(JOURNAL), record).unwrap();

        assert!(recover_at_startup(&fixture.data, &fixture.settings).is_err());
        assert_eq!(bytes(&live, Component::Database), Some(b"candidate bytes".to_vec()));
        assert_eq!(fs::read(artifact(&live, "rollback", id)).unwrap(), b"original bytes");
    }
}

#[test]
fn missing_original_and_stage_refuses_to_guess() {
    let fixture = Fixture::new();
    let components = [Component::Database];
    let (_transaction, id) = start(&fixture, &components, &[Some(b"original database")]);
    let live = fixture.live(Component::Database);
    fs::remove_file(&live).unwrap();
    fs::remove_file(artifact(&live, "stage", id)).unwrap();

    assert!(recover_at_startup(&fixture.data, &fixture.settings).is_err());
    assert!(!live.exists());
    assert!(fixture.data.join(JOURNAL).exists());
}

#[cfg(unix)]
#[test]
fn symlinked_journal_artifact_and_tree_refuse_without_touching_outside_bytes() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let outside = fixture.root.join("outside-journal");
    fs::write(&outside, b"outside journal bytes").unwrap();
    symlink(&outside, fixture.data.join(JOURNAL)).unwrap();
    assert!(recover_at_startup(&fixture.data, &fixture.settings).is_err());
    assert_eq!(fs::read(&outside).unwrap(), b"outside journal bytes");
    drop(fixture);

    let fixture = Fixture::new();
    let components = [Component::Database];
    let (_transaction, id) = start(&fixture, &components, &[Some(b"original database")]);
    let live = fixture.live(Component::Database);
    fs::remove_file(artifact(&live, "stage", id)).unwrap();
    let outside = fixture.root.join("outside-artifact");
    fs::write(&outside, b"outside artifact bytes").unwrap();
    symlink(&outside, artifact(&live, "stage", id)).unwrap();
    assert!(recover_at_startup(&fixture.data, &fixture.settings).is_err());
    assert_eq!(fs::read(&outside).unwrap(), b"outside artifact bytes");
    drop(fixture);

    let fixture = Fixture::new();
    let components = [Component::Recordings];
    let (_transaction, _id) = start(&fixture, &components, &[Some(b"recording before")]);
    let outside = fixture.root.join("outside-tree");
    fs::write(&outside, b"outside tree bytes").unwrap();
    symlink(
        &outside,
        fixture.live(Component::Recordings).join("linked.wav"),
    )
    .unwrap();
    assert!(recover_at_startup(&fixture.data, &fixture.settings).is_err());
    assert_eq!(fs::read(&outside).unwrap(), b"outside tree bytes");
}

#[test]
fn shared_settings_root_excludes_another_profile_until_guard_drops() {
    let first = Fixture::new();
    let second_data = first.root.join("other-data");
    fs::create_dir_all(&second_data).unwrap();

    let guard = recover_at_startup(&first.data, &first.settings).unwrap();
    assert!(recover_at_startup(&second_data, &first.settings).is_err());
    drop(guard);
    drop(recover_at_startup(&second_data, &first.settings).unwrap());
}
