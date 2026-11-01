use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    error::Error,
    fs,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

type ImportResult<T> = Result<T, Box<dyn Error>>;

#[derive(Clone, Debug, Eq, PartialEq)]
struct Payload {
    reference: String,
    kind: String,
    status: String,
    digest: Option<String>,
    expected_digest: Option<String>,
    content: Option<Vec<u8>>,
}

#[derive(Debug)]
struct UnitImport {
    source_path: String,
    source_digest: String,
    record_id: String,
    kind: String,
    state: String,
    revision: i64,
    reconciliation: String,
    payloads: Vec<Payload>,
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn timestamp() -> ImportResult<String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_secs()
        .to_string())
}

fn safe_unit_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn relative_string(path: &Path) -> ImportResult<String> {
    let value = path
        .to_str()
        .ok_or("legacy payload path is not valid UTF-8")?
        .replace('\\', "/");
    if value.is_empty() || value.starts_with('/') {
        return Err("legacy payload path is not a normalized relative path".into());
    }
    Ok(value)
}

fn payload_kind(path: &Path) -> ImportResult<&'static str> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if name == "unit.json" {
        Ok("unit-record")
    } else if name == "ledger.ndjson" {
        Ok("ledger")
    } else if path.components().any(|part| part.as_os_str() == "failures") {
        Ok("failure")
    } else if path.components().any(|part| part.as_os_str() == "stages") {
        Ok("stage")
    } else if path.components().any(|part| part.as_os_str() == "evidence") {
        Ok("evidence")
    } else {
        Ok("artifact")
    }
}

fn read_inside_root(root: &Path, relative: &Path) -> ImportResult<Option<(String, Vec<u8>)>> {
    let relative = relative_string(relative)?;
    let mut current = root.to_path_buf();
    let components = Path::new(&relative).components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(part) = component else {
            return Err("legacy evidence reference is not normalized".into());
        };
        current.push(part);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "legacy evidence reference traverses a symbolic link: {}",
                current.display()
            )
            .into());
        }
        if index + 1 < components.len() && !metadata.is_dir() {
            return Err(format!(
                "legacy evidence reference traverses a non-directory: {}",
                current.display()
            )
            .into());
        }
        if index + 1 == components.len() {
            if !metadata.is_file() {
                return Err(format!(
                    "legacy evidence reference is not a regular file: {}",
                    current.display()
                )
                .into());
            }
            return Ok(Some((relative, fs::read(current)?)));
        }
    }
    Ok(None)
}

fn scan_unit_files(
    root: &Path,
    directory: &Path,
    files: &mut BTreeMap<String, Payload>,
) -> ImportResult<()> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            return Err(format!("legacy unit contains a symbolic link: {}", path.display()).into());
        }
        if metadata.is_dir() {
            scan_unit_files(root, &path, files)?;
            continue;
        }
        if !metadata.is_file() {
            return Err(format!(
                "legacy unit contains a non-regular file: {}",
                path.display()
            )
            .into());
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(".lock") || name.contains(".tmp-") {
            return Err(format!(
                "legacy unit has an active or incomplete write: {}",
                path.display()
            )
            .into());
        }
        let relative = relative_string(path.strip_prefix(root)?)?;
        let content = fs::read(&path)?;
        files.insert(
            relative.clone(),
            Payload {
                reference: relative,
                kind: payload_kind(path.strip_prefix(root)?)?.to_owned(),
                status: "captured".to_owned(),
                digest: Some(digest(&content)),
                expected_digest: None,
                content: Some(content),
            },
        );
    }
    Ok(())
}

fn pointer_escape(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

fn reference_kind(pointer: &str) -> &'static str {
    if pointer.to_ascii_lowercase().contains("failure") {
        "failure"
    } else if pointer.to_ascii_lowercase().contains("stage") {
        "stage"
    } else if pointer.to_ascii_lowercase().contains("evidence") {
        "evidence"
    } else {
        "artifact"
    }
}

fn normalized_reference(value: &str) -> ImportResult<Option<PathBuf>> {
    let path = Path::new(value);
    if path.is_absolute() {
        return Ok(None);
    }
    if value.contains("://") || value.starts_with("file:") {
        return Ok(None);
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => normalized.push(part),
            Component::ParentDir => {
                return Err("legacy evidence reference escapes its source root".into());
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("legacy evidence reference is not a relative path".into());
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err("legacy evidence reference has an empty path".into());
    }
    Ok(Some(normalized))
}

fn collect_references(
    value: &Value,
    pointer: &str,
    source_root: &Path,
    unit_directory: &Path,
    files: &BTreeMap<String, Payload>,
    output: &mut Vec<(String, Payload, Value)>,
) -> ImportResult<()> {
    match value {
        Value::Object(object) => {
            if let (Some(path), Some(expected)) = (
                object.get("path").and_then(Value::as_str),
                object.get("digest").and_then(Value::as_str),
            ) {
                let reference_path = normalized_reference(path)?;
                let absolute = Path::new(path).is_absolute();
                let relative_to_root = if absolute {
                    Path::new(path)
                        .strip_prefix(source_root)
                        .ok()
                        .map(PathBuf::from)
                } else {
                    reference_path.clone()
                };
                let relative_to_unit = if absolute {
                    Path::new(path)
                        .strip_prefix(unit_directory)
                        .ok()
                        .map(PathBuf::from)
                } else {
                    reference_path
                        .clone()
                        .map(|relative| unit_directory.join(relative))
                        .and_then(|candidate| {
                            candidate.strip_prefix(source_root).ok().map(PathBuf::from)
                        })
                };
                let candidates = [relative_to_root, relative_to_unit];
                let mut captured = None;
                for candidate in candidates.iter().flatten() {
                    let key = relative_string(candidate)?;
                    if let Some(payload) = files.get(&key) {
                        captured = Some((payload.content.clone(), payload.digest.clone()));
                        break;
                    }
                    if let Some((_, content)) = read_inside_root(source_root, candidate)? {
                        captured = Some((Some(content.clone()), Some(digest(&content))));
                        break;
                    }
                }
                let (status, content, actual_digest) = match captured {
                    Some((content, actual_digest)) => ("captured", content, actual_digest),
                    None if absolute && Path::new(path).strip_prefix(source_root).is_err() => {
                        ("external", None, None)
                    }
                    None if !absolute && (path.contains("://") || path.starts_with("file:")) => {
                        ("external", None, None)
                    }
                    None => ("missing", None, None),
                };
                let payload_ref = format!("@reference:{pointer}");
                let reference = json!({
                    "pointer": pointer,
                    "path": path,
                    "expectedDigest": expected,
                    "payloadRef": payload_ref,
                    "captureStatus": status,
                    "payloadDigest": actual_digest,
                });
                output.push((
                    payload_ref.clone(),
                    Payload {
                        reference: payload_ref,
                        kind: reference_kind(pointer).to_owned(),
                        status: status.to_owned(),
                        digest: actual_digest,
                        expected_digest: Some(expected.to_owned()),
                        content,
                    },
                    reference,
                ));
            }
            for (key, child) in object {
                let child_pointer = format!("{pointer}/{}", pointer_escape(key));
                collect_references(
                    child,
                    &child_pointer,
                    source_root,
                    unit_directory,
                    files,
                    output,
                )?;
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                collect_references(
                    child,
                    &format!("{pointer}/{index}"),
                    source_root,
                    unit_directory,
                    files,
                    output,
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn aggregate_digest(payloads: &BTreeMap<String, Payload>) -> String {
    let mut hasher = Sha256::new();
    for (reference, payload) in payloads {
        for field in [
            reference.as_bytes(),
            payload.kind.as_bytes(),
            payload.status.as_bytes(),
            payload.digest.as_deref().unwrap_or("").as_bytes(),
            payload.expected_digest.as_deref().unwrap_or("").as_bytes(),
        ] {
            hasher.update((field.len() as u64).to_be_bytes());
            hasher.update(field);
        }
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn load_unit(root: &Path, unit_directory: &Path) -> ImportResult<UnitImport> {
    let name = unit_directory
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("legacy unit directory name is not valid UTF-8")?;
    if !safe_unit_name(name) {
        return Err(format!("legacy unit directory name is unsafe: {name}").into());
    }
    let record_path = unit_directory.join("unit.json");
    let record_metadata = fs::symlink_metadata(&record_path)?;
    if record_metadata.file_type().is_symlink() || !record_metadata.is_file() {
        return Err(format!(
            "legacy Unit Record is not a regular file: {}",
            record_path.display()
        )
        .into());
    }
    let record_bytes = fs::read(&record_path)?;
    let record: Value = serde_json::from_slice(&record_bytes)?;
    let object = record
        .as_object()
        .ok_or("legacy Unit Record must be a JSON object")?;
    if object.get("schema").and_then(Value::as_str) != Some("harness.unit/1") {
        return Err(format!(
            "unsupported Unit Record schema in {}",
            record_path.display()
        )
        .into());
    }
    let record_id = object
        .get("unit")
        .and_then(Value::as_str)
        .ok_or("legacy Unit Record unit id is missing")?;
    if record_id != name {
        return Err(format!("Unit Record id does not match directory: {name}").into());
    }
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .ok_or("legacy Unit Record kind is missing")?
        .to_owned();
    let state = object
        .get("state")
        .and_then(Value::as_str)
        .ok_or("legacy Unit Record state is missing")?
        .to_owned();
    let revision = object
        .get("revision")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or("legacy Unit Record revision must be a positive integer")?;

    let mut payloads = BTreeMap::new();
    scan_unit_files(root, unit_directory, &mut payloads)?;
    let source_path = relative_string(record_path.strip_prefix(root)?)?;
    if !payloads.contains_key(&source_path) {
        return Err("legacy Unit Record was not captured as a payload".into());
    }

    let mut references = Vec::new();
    let mut reference_rows = Vec::new();
    collect_references(
        &record,
        "",
        root,
        unit_directory,
        &payloads,
        &mut reference_rows,
    )?;
    for (_, payload, reference) in reference_rows {
        references.push(reference);
        let reference_payload = payload.clone();
        let key = reference_payload.reference.clone();
        if payloads.insert(key.clone(), reference_payload).is_some() {
            return Err(format!("duplicate legacy reference payload: {key}").into());
        }
    }
    let source_digest = aggregate_digest(&payloads);
    let reconciliation = serde_json::to_string(&json!({
        "references": references,
        "sourceRecordDigest": payloads[&source_path].digest,
        "archiveDigest": source_digest,
    }))?;
    Ok(UnitImport {
        source_path,
        source_digest,
        record_id: record_id.to_owned(),
        kind,
        state,
        revision,
        reconciliation,
        payloads: payloads.into_values().collect(),
    })
}

fn load_units(root: &Path) -> ImportResult<Vec<UnitImport>> {
    let units_path = root.join("units");
    let units_metadata = match fs::symlink_metadata(&units_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    if units_metadata.file_type().is_symlink() || !units_metadata.is_dir() {
        return Err("legacy units path must be a regular directory".into());
    }
    let mut entries = fs::read_dir(&units_path)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    let mut imports = Vec::new();
    for entry in entries {
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(format!(
                "legacy units contains an unexpected entry: {}",
                entry.path().display()
            )
            .into());
        }
        imports.push(load_unit(root, &entry.path())?);
    }
    Ok(imports)
}

fn same_payloads(
    connection: &Connection,
    source_path: &str,
    expected: &[Payload],
) -> ImportResult<bool> {
    let mut statement = connection.prepare(
        "SELECT payload_ref,payload_kind,capture_status,payload_digest,expected_digest,content
         FROM legacy_payload WHERE source_path=?1 ORDER BY payload_ref",
    )?;
    let rows = statement.query_map([source_path], |row| {
        Ok(Payload {
            reference: row.get(0)?,
            kind: row.get(1)?,
            status: row.get(2)?,
            digest: row.get(3)?,
            expected_digest: row.get(4)?,
            content: row.get(5)?,
        })
    })?;
    let stored = rows.collect::<Result<Vec<_>, _>>()?;
    let mut expected = expected.to_vec();
    expected.sort_by(|left, right| left.reference.cmp(&right.reference));
    Ok(stored == expected)
}

fn insert_payloads(
    connection: &Connection,
    source_path: &str,
    payloads: &[Payload],
) -> ImportResult<()> {
    for payload in payloads {
        connection.execute(
            "INSERT INTO legacy_payload(
                source_path,payload_ref,payload_kind,capture_status,payload_digest,expected_digest,content
             ) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                source_path,
                payload.reference,
                payload.kind,
                payload.status,
                payload.digest,
                payload.expected_digest,
                payload.content,
            ],
        )?;
    }
    Ok(())
}

pub fn import_json_records(
    connection: &mut Connection,
    _project_root: &Path,
    legacy_root: &Path,
) -> ImportResult<Value> {
    let root = legacy_root.canonicalize()?;
    if !root.is_dir() {
        return Err("legacy state root must be a directory".into());
    }
    let imports = load_units(&root)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut imported = 0_u64;
    let mut unchanged = 0_u64;
    for unit in &imports {
        let previous: Option<(String, String, String, String, i64)> = transaction
            .query_row(
                "SELECT source_digest,source_record_id,legacy_kind,legacy_state,legacy_revision
                 FROM legacy_migration WHERE source_path=?1",
                [&unit.source_path],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        if let Some((source_digest, record_id, kind, state, revision)) = previous {
            if source_digest != unit.source_digest
                || record_id != unit.record_id
                || kind != unit.kind
                || state != unit.state
                || revision != unit.revision
            {
                return Err(
                    format!("legacy source changed after import: {}", unit.source_path).into(),
                );
            }
            if !same_payloads(&transaction, &unit.source_path, &unit.payloads)? {
                return Err(format!(
                    "archived payload changed or is incomplete: {}",
                    unit.source_path
                )
                .into());
            }
            unchanged += 1;
            continue;
        }
        transaction.execute(
            "INSERT INTO legacy_migration(
                source_path,source_digest,source_record_id,target_task_id,imported_at,
                reconciliation_json,legacy_kind,legacy_state,legacy_revision
             ) VALUES (?1,?2,?3,NULL,?4,?5,?6,?7,?8)",
            params![
                unit.source_path,
                unit.source_digest,
                unit.record_id,
                timestamp()?,
                unit.reconciliation,
                unit.kind,
                unit.state,
                unit.revision,
            ],
        )?;
        insert_payloads(&transaction, &unit.source_path, &unit.payloads)?;
        imported += 1;
    }
    transaction.commit()?;
    Ok(json!({ "imported": imported, "unchanged": unchanged, "records": imports.len() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        source: PathBuf,
        connection: Connection,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!(
            "forge-legacy-import-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let source = root.join("old-state");
        fs::create_dir_all(&source).unwrap();
        let connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        connection.execute_batch(super::super::MIGRATION_1).unwrap();
        connection.execute_batch(super::super::MIGRATION_2).unwrap();
        Fixture {
            root,
            source,
            connection,
        }
    }

    fn add_unit(
        source: &Path,
        name: &str,
        state: &str,
        evidence_path: &str,
        report: Option<&[u8]>,
    ) -> Vec<u8> {
        let unit = source.join("units").join(name);
        fs::create_dir_all(unit.join("stages")).unwrap();
        fs::create_dir_all(unit.join("failures")).unwrap();
        fs::create_dir_all(unit.join("evidence")).unwrap();
        let report_bytes = report.unwrap_or(b"report bytes");
        if !evidence_path.starts_with("../") {
            fs::write(unit.join(evidence_path), report_bytes).unwrap();
        }
        fs::write(unit.join("ledger.ndjson"), b"{\"event\":\"intent\"}\n").unwrap();
        fs::write(
            unit.join("failures").join("fail-1.json"),
            b"{\"id\":\"fail-1\"}\n",
        )
        .unwrap();
        fs::write(
            unit.join("stages").join("scope.1.input.json"),
            b"{\"stage\":\"scope\"}\n",
        )
        .unwrap();
        let record = json!({
            "schema": "harness.unit/1",
            "unit": name,
            "revision": 7,
            "kind": "impl",
            "state": state,
            "evidence": [{"path": evidence_path, "digest": digest(report_bytes)}],
            "failures": [{"path": format!("units/{name}/failures/fail-1.json"), "digest": digest(b"{\"id\":\"fail-1\"}\n")}]
        });
        let bytes = serde_json::to_vec(&record).unwrap();
        fs::write(unit.join("unit.json"), &bytes).unwrap();
        bytes
    }

    #[test]
    fn imports_exact_record_payloads_and_referenced_evidence_without_mutating_sources() {
        let mut fixture = fixture();
        let bytes = add_unit(
            &fixture.source,
            "unit-a",
            "SelfGated",
            "evidence/report.json",
            Some(b"exact report\n"),
        );
        let unit_dir = fixture.source.join("units/unit-a");
        let record_before = fs::read(unit_dir.join("unit.json")).unwrap();
        let report_before = fs::read(unit_dir.join("evidence/report.json")).unwrap();
        let receipt =
            import_json_records(&mut fixture.connection, &fixture.root, &fixture.source).unwrap();
        assert_eq!(receipt["imported"], 1);
        assert_eq!(receipt["unchanged"], 0);
        let metadata: (String, String, String, String, i64, Option<String>) = fixture.connection.query_row(
            "SELECT source_record_id,source_digest,legacy_kind,legacy_state,legacy_revision,target_task_id
             FROM legacy_migration WHERE source_path='units/unit-a/unit.json'",
            [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
        ).unwrap();
        assert_eq!(metadata.0, "unit-a");
        assert_eq!(metadata.2, "impl");
        assert_eq!(metadata.3, "SelfGated");
        assert_eq!(metadata.4, 7);
        assert_eq!(metadata.5, None);
        assert!(metadata.1.starts_with("sha256:"));
        let stored_record: Vec<u8> = fixture.connection.query_row(
            "SELECT content FROM legacy_payload WHERE source_path='units/unit-a/unit.json' AND payload_kind='unit-record'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(stored_record, bytes);
        let stored_report: Vec<u8> = fixture.connection.query_row(
            "SELECT content FROM legacy_payload WHERE source_path='units/unit-a/unit.json' AND payload_ref='units/unit-a/evidence/report.json'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(stored_report, b"exact report\n");
        let expected_digest: String = fixture.connection.query_row(
            "SELECT expected_digest FROM legacy_payload WHERE source_path='units/unit-a/unit.json' AND payload_ref LIKE '@reference:%'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(expected_digest, digest(b"exact report\n"));
        assert_eq!(fs::read(unit_dir.join("unit.json")).unwrap(), record_before);
        assert_eq!(
            fs::read(unit_dir.join("evidence/report.json")).unwrap(),
            report_before
        );
    }

    #[test]
    fn identical_replay_is_idempotent_and_changed_source_rolls_back_new_rows() {
        let mut fixture = fixture();
        add_unit(
            &fixture.source,
            "unit-b",
            "Accepted",
            "evidence/report.json",
            Some(b"first"),
        );
        let first =
            import_json_records(&mut fixture.connection, &fixture.root, &fixture.source).unwrap();
        assert_eq!(first["imported"], 1);
        let replay =
            import_json_records(&mut fixture.connection, &fixture.root, &fixture.source).unwrap();
        assert_eq!(replay["imported"], 0);
        assert_eq!(replay["unchanged"], 1);
        add_unit(
            &fixture.source,
            "unit-b",
            "Delivered",
            "evidence/report.json",
            Some(b"changed"),
        );
        add_unit(
            &fixture.source,
            "unit-a",
            "Scoped",
            "evidence/report.json",
            Some(b"new"),
        );
        let error = import_json_records(&mut fixture.connection, &fixture.root, &fixture.source)
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("legacy source changed after import")
        );
        let count: i64 = fixture
            .connection
            .query_row("SELECT count(*) FROM legacy_migration", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            count, 1,
            "new unit-a row must roll back with unit-b conflict"
        );
        let replay_after_change =
            import_json_records(&mut fixture.connection, &fixture.root, &fixture.source)
                .unwrap_err();
        assert!(
            replay_after_change
                .to_string()
                .contains("legacy source changed after import")
        );
    }

    #[test]
    fn rejects_path_traversal_before_writing_any_import_rows() {
        let mut fixture = fixture();
        add_unit(
            &fixture.source,
            "unit-a",
            "SelfGated",
            "../outside/report.json",
            Some(b"outside"),
        );
        let result = import_json_records(&mut fixture.connection, &fixture.root, &fixture.source);
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("escapes its source root")
        );
        let count: i64 = fixture
            .connection
            .query_row("SELECT count(*) FROM legacy_migration", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}
