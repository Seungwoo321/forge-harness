use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::ExitCode,
    time::{SystemTime, UNIX_EPOCH},
};

const MIGRATION: &str = include_str!("../migrations/0001_initial.sql");
const MIGRATION_VERSION: i64 = 1;

fn timestamp() -> Result<String, Box<dyn std::error::Error>> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_secs()
        .to_string())
}

fn database_path(root: &Path) -> PathBuf {
    root.join(".local").join("forge").join("forge.sqlite3")
}

fn open_database(root: &Path, branch: &str) -> Result<Connection, Box<dyn std::error::Error>> {
    let root = root.canonicalize()?;
    let path = database_path(&root);
    fs::create_dir_all(path.parent().ok_or("database path has no parent")?)?;
    let mut connection = Connection::open(path)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;

    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > MIGRATION_VERSION {
        return Err(format!(
            "database schema {version} is newer than supported schema {MIGRATION_VERSION}"
        )
        .into());
    }
    if version == 0 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(MIGRATION)?;
        let checksum = format!("sha256:{:x}", Sha256::digest(MIGRATION.as_bytes()));
        let now = timestamp()?;
        transaction.execute(
            "INSERT INTO migration(version,name,checksum,applied_at) VALUES (?1,?2,?3,?4)",
            params![MIGRATION_VERSION, "initial", checksum, now],
        )?;
        transaction.execute(
            "INSERT INTO project(id,root,branch_identity,created_at) VALUES ('project',?1,?2,?3)",
            params![root.to_string_lossy(), branch, now],
        )?;
        transaction.pragma_update(None, "user_version", MIGRATION_VERSION)?;
        transaction.commit()?;
    }
    let binding: Option<(String, String)> = connection
        .query_row(
            "SELECT root, branch_identity FROM project WHERE id='project'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match binding {
        Some((stored_root, stored_branch))
            if stored_root == root.to_string_lossy() && stored_branch == branch =>
        {
            Ok(connection)
        }
        Some(_) => Err("database is bound to a different project root or branch identity".into()),
        None => Err("database migration is incomplete: project binding is missing".into()),
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("init") => {
            let root = PathBuf::from(
                args.next()
                    .ok_or("usage: forge-daemon init <project-root> <branch-identity>")?,
            );
            let branch = args
                .next()
                .ok_or("usage: forge-daemon init <project-root> <branch-identity>")?;
            if args.next().is_some() || branch.trim().is_empty() {
                return Err("invalid init arguments".into());
            }
            let connection = open_database(&root, &branch)?;
            let version: i64 =
                connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
            println!(
                "initialized {} (schema {version})",
                database_path(&root.canonicalize()?).display()
            );
            Ok(())
        }
        Some("status") => {
            let root = PathBuf::from(
                args.next()
                    .ok_or("usage: forge-daemon status <project-root> <branch-identity>")?,
            );
            let branch = args
                .next()
                .ok_or("usage: forge-daemon status <project-root> <branch-identity>")?;
            if args.next().is_some() {
                return Err("invalid status arguments".into());
            }
            let connection = open_database(&root, &branch)?;
            let version: i64 =
                connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
            println!("ready (schema {version})");
            Ok(())
        }
        _ => Err("usage: forge-daemon init|status <project-root> <branch-identity>".into()),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("forge-daemon: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let path = env::temp_dir().join(format!(
            "forge-daemon-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn migration_creates_required_relations_and_is_idempotent() {
        let root = temp_root();
        let db = open_database(&root, "branch-a").unwrap();
        assert_eq!(
            db.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
                .unwrap(),
            1
        );
        let count: i64 = db.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('canon_source','goal','goal_source','goal_dependency','scenario','goal_scenario','task','task_goal','task_scenario','task_acceptance','decision','attempt','task_session','runner_operation_ref','evidence_ref','event','effect_intent','migration','legacy_migration')", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 19);
        assert_eq!(
            db.query_row("SELECT count(*) FROM migration WHERE version=1", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
            1
        );
        drop(db);
        let reopened = open_database(&root, "branch-a").unwrap();
        assert_eq!(
            reopened
                .query_row("SELECT count(*) FROM migration", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(open_database(&root, "branch-b").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn constraints_enforce_single_active_task_and_append_only_events() {
        let root = temp_root();
        let db = open_database(&root, "branch-a").unwrap();
        db.execute("INSERT INTO task(id,kind,title,state,revision,allowed_paths_json,prerequisite_json,required_evidence_json,created_at) VALUES ('t1','implementation','one','active',1,'[]','[]','[]','0')", []).unwrap();
        assert!(db.execute("INSERT INTO task(id,kind,title,state,revision,allowed_paths_json,prerequisite_json,required_evidence_json,created_at) VALUES ('t2','implementation','two','active',1,'[]','[]','[]','0')", []).is_err());
        db.execute("INSERT INTO event(entity_type,entity_id,revision,payload_json,created_at) VALUES ('task','t1',1,'{}','0')", []).unwrap();
        assert!(
            db.execute(
                "UPDATE event SET payload_json='{}' WHERE entity_id='t1'",
                []
            )
            .is_err()
        );
        assert!(
            db.execute("DELETE FROM event WHERE entity_id='t1'", [])
                .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }
}
