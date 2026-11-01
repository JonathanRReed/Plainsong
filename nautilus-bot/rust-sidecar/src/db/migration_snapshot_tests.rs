use super::*;

const KEY: &str = "0123456789abcdef0123456789abcdef";

fn legacy(path: &Path, fail_migration: bool) -> Connection {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(&format!(
        "PRAGMA key = \"x'{}'\";",
        hex_database_key(KEY).unwrap()
    ))
    .unwrap();
    conn.execute_batch("CREATE TABLE migration_marker (text TEXT); INSERT INTO migration_marker VALUES ('private transcript sentinel'); PRAGMA user_version = 0;").unwrap();
    if fail_migration {
        conn.execute_batch("CREATE VIEW recordings AS SELECT 'blocked' AS id;")
            .unwrap();
    }
    conn
}

fn snapshots(path: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<_> = fs::read_dir(path.with_file_name("plainsong.db.migration-snapshots"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    entries.sort();
    entries
}

fn keyed_snapshot(path: &Path) -> Connection {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(&format!(
        "PRAGMA key = \"x'{}'\";",
        hex_database_key(KEY).unwrap()
    ))
    .unwrap();
    conn
}

#[test]
fn startup_snapshot_is_encrypted_and_precedes_schema_upgrade() {
    let dir = crate::test_fs::TempDir::new("migration-snapshot");
    let path = dir.path().join("plainsong.db");
    drop(legacy(&path, false));
    let db = Database::open_at_path(&path, Some(KEY)).unwrap();
    assert_eq!(
        db.conn
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        CURRENT_SCHEMA_VERSION
    );
    let files = snapshots(&path);
    assert_eq!(files.len(), 1);
    let bytes = fs::read(&files[0]).unwrap();
    assert!(!bytes.starts_with(b"SQLite format 3"));
    assert!(!bytes
        .windows(b"private transcript sentinel".len())
        .any(|window| window == b"private transcript sentinel"));
    let unkeyed = Connection::open(&files[0]).unwrap();
    assert!(unkeyed
        .query_row("SELECT count(*) FROM sqlite_master", [], |row| row
            .get::<_, i64>(0))
        .is_err());
    let snapshot = keyed_snapshot(&files[0]);
    assert_eq!(
        snapshot
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        snapshot
            .query_row("SELECT text FROM migration_marker", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "private transcript sentinel"
    );
    assert!(!table_exists(&snapshot, "recordings").unwrap());
    drop(db);
    drop(Database::open_at_path(&path, Some(KEY)).unwrap());
    assert_eq!(
        snapshots(&path),
        files,
        "ordinary startup must not rotate snapshots"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&files[0]).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn startup_snapshot_retains_last_two_complete_exports() {
    let dir = crate::test_fs::TempDir::new("migration-snapshot-retention");
    let path = dir.path().join("plainsong.db");
    let conn = legacy(&path, false);
    let first = snapshot_before_schema_upgrade(&conn, &path, KEY)
        .unwrap()
        .unwrap();
    for _ in 0..3 {
        snapshot_before_schema_upgrade(&conn, &path, KEY).unwrap();
    }
    let files = snapshots(&path);
    assert_eq!(files.len(), 2);
    assert!(!first.exists());
    for file in files {
        assert_eq!(
            keyed_snapshot(&file)
                .query_row("SELECT count(*) FROM migration_marker", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}

#[test]
fn failed_startup_migration_rolls_back_and_preserves_encrypted_snapshot() {
    let dir = crate::test_fs::TempDir::new("migration-snapshot-rollback");
    let path = dir.path().join("plainsong.db");
    drop(legacy(&path, true));
    let error = Database::open_at_path(&path, Some(KEY)).err().unwrap();
    assert!(format!("{error:#}").contains("rolled back"));
    let live = keyed_snapshot(&path);
    assert_eq!(
        live.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(!table_exists(&live, "projects").unwrap());
    let files = snapshots(&path);
    assert_eq!(files.len(), 1);
    assert_eq!(
        keyed_snapshot(&files[0])
            .query_row("SELECT text FROM migration_marker", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "private transcript sentinel"
    );
}

#[test]
fn snapshot_failure_blocks_schema_changes_and_new_databases_need_no_snapshot() {
    let dir = crate::test_fs::TempDir::new("migration-snapshot-failure");
    let path = dir.path().join("plainsong.db");
    drop(Database::open_at_path(&path, Some(KEY)).unwrap());
    assert!(!path
        .with_file_name("plainsong.db.migration-snapshots")
        .exists());
    fs::remove_file(&path).unwrap();
    drop(legacy(&path, false));
    fs::write(
        path.with_file_name("plainsong.db.migration-snapshots"),
        "blocked",
    )
    .unwrap();
    assert!(Database::open_at_path(&path, Some(KEY)).is_err());
    let live = keyed_snapshot(&path);
    assert_eq!(
        live.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(!table_exists(&live, "projects").unwrap());
}

#[test]
fn snapshot_uses_the_current_schema_version_and_includes_wal_rows() {
    let dir = crate::test_fs::TempDir::new("migration-snapshot-wal");
    let path = dir.path().join("plainsong.db");
    let conn = legacy(&path, false);
    conn.execute_batch(&format!(
        "PRAGMA user_version = {}; PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; INSERT INTO migration_marker VALUES ('pending WAL row');",
        CURRENT_SCHEMA_VERSION - 1
    )).unwrap();
    let file = snapshot_before_schema_upgrade(&conn, &path, KEY)
        .unwrap()
        .unwrap();
    let snapshot = keyed_snapshot(&file);
    assert_eq!(
        snapshot
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        CURRENT_SCHEMA_VERSION - 1
    );
    assert_eq!(
        snapshot
            .query_row("SELECT count(*) FROM migration_marker", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert!(file
        .file_name()
        .unwrap()
        .to_string_lossy()
        .contains(&format!("before-v{CURRENT_SCHEMA_VERSION}")));
}

#[test]
fn snapshot_skips_current_and_future_versions_and_unkeyed_profiles() {
    let dir = crate::test_fs::TempDir::new("migration-snapshot-versions");
    let path = dir.path().join("plainsong.db");
    let conn = legacy(&path, false);
    for version in [CURRENT_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION + 1] {
        conn.execute_batch(&format!("PRAGMA user_version = {version};"))
            .unwrap();
        assert!(snapshot_before_schema_upgrade(&conn, &path, KEY)
            .unwrap()
            .is_none());
    }
    drop(conn);
    assert!(Database::open_at_path(&path, Some(KEY)).is_err());
    fs::remove_file(&path).unwrap();
    let plaintext = Connection::open(&path).unwrap();
    plaintext
        .execute_batch("CREATE TABLE migration_marker (text TEXT);")
        .unwrap();
    drop(plaintext);
    drop(Database::open_at_path(&path, None).unwrap());
    assert!(!path
        .with_file_name("plainsong.db.migration-snapshots")
        .exists());
}

#[test]
fn startup_snapshot_precedes_v3_recording_asides_migration() {
    let dir = crate::test_fs::TempDir::new("migration-snapshot-asides-v3");
    let path = dir.path().join("plainsong.db");
    let db = Database::open_at_path(&path, Some(KEY)).unwrap();
    assert_eq!(CURRENT_SCHEMA_VERSION, 4);
    db.conn
        .execute_batch("DROP TABLE recording_asides; PRAGMA user_version = 2;")
        .unwrap();
    drop(db);

    let db = Database::open_at_path(&path, Some(KEY)).unwrap();
    assert!(table_exists(&db.conn, "recording_asides").unwrap());
    assert_eq!(
        db.conn
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        CURRENT_SCHEMA_VERSION
    );
    let files = snapshots(&path);
    assert_eq!(files.len(), 1);
    let snapshot = keyed_snapshot(&files[0]);
    assert_eq!(
        snapshot
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert!(!table_exists(&snapshot, "recording_asides").unwrap());
    assert!(table_exists(&snapshot, "recordings").unwrap());
}

#[test]
fn startup_snapshot_precedes_v4_compact_audio_migration_from_asides_v3() {
    let dir = crate::test_fs::TempDir::new("migration-snapshot-compact-v4");
    let path = dir.path().join("plainsong.db");
    let db = Database::open_at_path(&path, Some(KEY)).unwrap();
    db.conn
        .execute_batch("DROP TABLE meeting_audio_finalization; PRAGMA user_version = 3;")
        .unwrap();
    drop(db);
    let db = Database::open_at_path(&path, Some(KEY)).unwrap();
    assert!(table_exists(&db.conn, "meeting_audio_finalization").unwrap());
    assert!(table_exists(&db.conn, "recording_asides").unwrap());
    assert_eq!(
        db.conn
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        CURRENT_SCHEMA_VERSION
    );
    let files = snapshots(&path);
    assert_eq!(files.len(), 1);
    let snapshot = keyed_snapshot(&files[0]);
    assert_eq!(
        snapshot
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert!(!table_exists(&snapshot, "meeting_audio_finalization").unwrap());
    assert!(table_exists(&snapshot, "recording_asides").unwrap());
}
