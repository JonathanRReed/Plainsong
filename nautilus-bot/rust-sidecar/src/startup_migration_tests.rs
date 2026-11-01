use rusqlite::Connection;
use std::{fs, path::Path, process::Command};

const KEY: &str = "startup-migration-test-key-only";
const CHILD_PROFILE: &str = "PLAINSONG_MIGRATION_TEST_PROFILE";

fn keyed(path: &Path) -> Connection {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", hex::encode(KEY)))
        .unwrap();
    conn
}

fn version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap()
}

fn snapshots(profile: &Path) -> Vec<std::path::PathBuf> {
    let mut files: Vec<_> =
        fs::read_dir(profile.join("Plainsong/plainsong.db.migration-snapshots"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
    files.sort();
    files
}

fn restart(profile: &Path, fails: bool) {
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "startup_migration_tests::isolated_startup_child",
            "--nocapture",
        ])
        .env(CHILD_PROFILE, profile)
        .env("PLAINSONG_DATA_DIR", profile)
        .env("PLAINSONG_CONFIG_DIR", profile)
        .env(
            "PLAINSONG_MIGRATION_TEST_FAILS",
            if fails { "1" } else { "0" },
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "startup child failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn isolated_startup_child() {
    let Some(profile) = std::env::var_os(CHILD_PROFILE) else {
        return;
    };
    let profile = std::path::PathBuf::from(profile);
    assert!(profile.is_absolute());
    assert_eq!(crate::paths::data_dir().unwrap(), profile);
    // The production startup function receives a test key directly. No secret
    // store is instantiated, and no test key override enters production code.
    let opened = crate::open_database_with_vault_key_recovery(Some(KEY));
    if std::env::var("PLAINSONG_MIGRATION_TEST_FAILS").unwrap() == "1" {
        assert!(opened.is_err());
    } else {
        let (db, recovery) = opened.unwrap();
        assert_eq!(recovery, crate::VaultStartupMigration::default());
        drop(db);
        assert!(version(&keyed(&profile.join("Plainsong/plainsong.db"))) > 0);
    }
}

#[test]
fn encrypted_startup_snapshot_survives_restarts_retention_and_migration_failure() {
    let dir = crate::test_fs::TempDir::new("startup-encrypted-migration");
    let profile = dir.path();
    fs::create_dir(profile.join("Plainsong")).unwrap();
    let path = profile.join("Plainsong/plainsong.db");
    keyed(&path).execute_batch("CREATE TABLE migration_marker (value TEXT); INSERT INTO migration_marker VALUES ('test-only encrypted sentinel'); PRAGMA user_version = 0;").unwrap();

    restart(profile, false);
    let current_version = version(&keyed(&path));
    let first = snapshots(profile);
    assert_eq!(first.len(), 1);
    let before = keyed(&first[0]);
    assert_eq!(version(&before), 0);
    assert!(
        before.prepare("SELECT id FROM recordings").is_err(),
        "snapshot must precede migration DDL"
    );
    drop(before);
    restart(profile, false);
    assert_eq!(
        snapshots(profile),
        first,
        "current-schema restart must not rotate snapshots"
    );

    // Recreate an older schema version across process restarts, as a later
    // application upgrade would. This follows the runtime version, including v3.
    for _ in 0..2 {
        keyed(&path)
            .execute_batch("PRAGMA user_version = 0;")
            .unwrap();
        restart(profile, false);
    }
    let retained = snapshots(profile);
    assert_eq!(retained.len(), 2);
    assert!(!first[0].exists());
    assert_eq!(version(&keyed(&path)), current_version);

    keyed(&path).execute_batch("PRAGMA user_version = 0; DROP TABLE projects; CREATE VIEW projects AS SELECT 'blocked' AS id;").unwrap();
    restart(profile, true);
    let files = snapshots(profile);
    assert_eq!(
        files.len(),
        2,
        "failed migration still retains two complete snapshots"
    );
    let failed_snapshot = files.iter().find(|file| !retained.contains(file)).unwrap();
    assert_eq!(
        version(&keyed(&path)),
        0,
        "failed migration must roll back its version"
    );
    let preserved = keyed(failed_snapshot);
    assert_eq!(version(&preserved), 0);
    assert_eq!(
        preserved
            .query_row(
                "SELECT type FROM sqlite_master WHERE name='projects'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "view"
    );
    for file in files {
        let bytes = fs::read(&file).unwrap();
        assert!(!bytes.starts_with(b"SQLite format 3"));
        assert!(!bytes
            .windows(b"test-only encrypted sentinel".len())
            .any(|window| window == b"test-only encrypted sentinel"));
        assert!(Connection::open(&file)
            .unwrap()
            .prepare("SELECT * FROM sqlite_master")
            .is_err());
        let snapshot = keyed(&file);
        assert_eq!(version(&snapshot), 0);
        assert_eq!(
            snapshot
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert_eq!(
            snapshot
                .query_row("SELECT value FROM migration_marker", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "test-only encrypted sentinel"
        );
    }
}
