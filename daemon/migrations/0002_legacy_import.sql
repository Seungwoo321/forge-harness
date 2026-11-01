ALTER TABLE legacy_migration RENAME TO legacy_migration_v1;

CREATE TABLE legacy_migration (
    source_path TEXT PRIMARY KEY,
    source_digest TEXT NOT NULL,
    source_record_id TEXT NOT NULL UNIQUE,
    target_task_id TEXT REFERENCES task(id),
    imported_at TEXT NOT NULL,
    reconciliation_json TEXT NOT NULL CHECK(json_valid(reconciliation_json)),
    legacy_kind TEXT NOT NULL,
    legacy_state TEXT NOT NULL,
    legacy_revision INTEGER NOT NULL CHECK(legacy_revision > 0)
) STRICT;

INSERT INTO legacy_migration(
    source_path, source_digest, source_record_id, target_task_id, imported_at,
    reconciliation_json, legacy_kind, legacy_state, legacy_revision
)
SELECT source_path, source_digest, source_record_id, target_task_id, imported_at,
       reconciliation_json, '', '', 1
FROM legacy_migration_v1;

DROP TABLE legacy_migration_v1;

CREATE TABLE legacy_payload (
    source_path TEXT NOT NULL REFERENCES legacy_migration(source_path),
    payload_ref TEXT NOT NULL,
    payload_kind TEXT NOT NULL CHECK(payload_kind IN ('unit-record','ledger','evidence','failure','stage','artifact')),
    capture_status TEXT NOT NULL CHECK(capture_status IN ('captured','missing','external')),
    payload_digest TEXT,
    expected_digest TEXT,
    content BLOB,
    PRIMARY KEY(source_path, payload_ref),
    CHECK((capture_status = 'captured' AND content IS NOT NULL AND payload_digest IS NOT NULL)
       OR (capture_status <> 'captured' AND content IS NULL AND payload_digest IS NULL))
) STRICT;

CREATE INDEX legacy_payload_kind ON legacy_payload(source_path, payload_kind);

CREATE TRIGGER legacy_payload_no_update
BEFORE UPDATE ON legacy_payload
BEGIN SELECT RAISE(ABORT, 'legacy payload is immutable'); END;

CREATE TRIGGER legacy_payload_no_delete
BEFORE DELETE ON legacy_payload
BEGIN SELECT RAISE(ABORT, 'legacy payload is immutable'); END;
