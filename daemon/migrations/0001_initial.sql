CREATE TABLE project (
    id TEXT PRIMARY KEY CHECK (id = 'project'),
    root TEXT NOT NULL,
    branch_identity TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE migration (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE canon_source (
    id TEXT PRIMARY KEY,
    authority_id TEXT NOT NULL,
    logical_path TEXT NOT NULL,
    owner TEXT NOT NULL,
    revision TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    approval_ref TEXT NOT NULL,
    parent_id TEXT REFERENCES canon_source(id),
    UNIQUE(authority_id, logical_path, revision)
) STRICT;

CREATE TABLE goal (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('proposed','approved','blocked','complete','cancelled')),
    revision INTEGER NOT NULL CHECK (revision > 0)
) STRICT;

CREATE TABLE goal_source (
    goal_id TEXT NOT NULL REFERENCES goal(id),
    source_id TEXT NOT NULL REFERENCES canon_source(id),
    anchor TEXT NOT NULL,
    PRIMARY KEY(goal_id, source_id, anchor)
) STRICT;

CREATE TABLE goal_dependency (
    goal_id TEXT NOT NULL REFERENCES goal(id),
    prerequisite_goal_id TEXT NOT NULL REFERENCES goal(id),
    PRIMARY KEY(goal_id, prerequisite_goal_id),
    CHECK(goal_id <> prerequisite_goal_id)
) STRICT;

CREATE TABLE scenario (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    given_text TEXT NOT NULL CHECK(length(trim(given_text)) > 0),
    when_text TEXT NOT NULL CHECK(length(trim(when_text)) > 0),
    then_text TEXT NOT NULL CHECK(length(trim(then_text)) > 0),
    state TEXT NOT NULL CHECK (state IN ('proposed','approved','retired')),
    revision INTEGER NOT NULL CHECK (revision > 0)
) STRICT;

CREATE TABLE goal_scenario (
    goal_id TEXT NOT NULL REFERENCES goal(id),
    scenario_id TEXT NOT NULL REFERENCES scenario(id),
    PRIMARY KEY(goal_id, scenario_id)
) STRICT;

CREATE TABLE task (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('design','implementation','operations','migration')),
    title TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('ready','active','blocked','review','complete','cancelled')),
    owner TEXT,
    revision INTEGER NOT NULL CHECK (revision > 0),
    allowed_paths_json TEXT NOT NULL CHECK(json_valid(allowed_paths_json)),
    prerequisite_json TEXT NOT NULL CHECK(json_valid(prerequisite_json)),
    required_evidence_json TEXT NOT NULL CHECK(json_valid(required_evidence_json)),
    created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX one_active_task ON task((1)) WHERE state IN ('active','blocked','review');

CREATE TABLE task_goal (
    task_id TEXT NOT NULL REFERENCES task(id),
    goal_id TEXT NOT NULL REFERENCES goal(id),
    PRIMARY KEY(task_id, goal_id)
) STRICT;

CREATE TABLE task_scenario (
    task_id TEXT NOT NULL REFERENCES task(id),
    scenario_id TEXT NOT NULL REFERENCES scenario(id),
    PRIMARY KEY(task_id, scenario_id)
) STRICT;

CREATE TABLE task_acceptance (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES task(id),
    statement TEXT NOT NULL CHECK(length(trim(statement)) > 0),
    kind TEXT NOT NULL CHECK(kind IN ('behavioral','non_behavioral')),
    source_id TEXT NOT NULL REFERENCES canon_source(id),
    source_anchor TEXT NOT NULL,
    required INTEGER NOT NULL CHECK(required IN (0,1))
) STRICT;

CREATE TABLE decision (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES task(id),
    goal_id TEXT REFERENCES goal(id),
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    authority_ref TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK(task_id IS NOT NULL OR goal_id IS NOT NULL)
) STRICT;

CREATE TABLE attempt (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES task(id),
    number INTEGER NOT NULL CHECK(number > 0),
    state TEXT NOT NULL CHECK(state IN ('active','passed','failed','abandoned')),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    UNIQUE(task_id, number)
) STRICT;

CREATE TABLE task_session (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES task(id),
    role TEXT NOT NULL CHECK(role IN ('owner','resolver','reviewer')),
    status TEXT NOT NULL CHECK(status IN ('requested','running','blocked','completed','failed','closed')),
    app_session_ref TEXT,
    operation_id TEXT NOT NULL UNIQUE,
    started_at TEXT,
    ended_at TEXT
) STRICT;
CREATE UNIQUE INDEX one_live_owner_session ON task_session(role)
    WHERE role = 'owner' AND status IN ('requested','running','blocked');

CREATE TABLE runner_operation_ref (
    operation_id TEXT PRIMARY KEY,
    task_session_id TEXT NOT NULL REFERENCES task_session(id),
    operation TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    app_operation_ref TEXT,
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE evidence_ref (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES task(id),
    attempt_id TEXT REFERENCES attempt(id),
    acceptance_id TEXT REFERENCES task_acceptance(id),
    authority_uri TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK(verdict IN ('pass','fail','informational')),
    created_at TEXT NOT NULL,
    CHECK(attempt_id IS NOT NULL OR acceptance_id IS NOT NULL)
) STRICT;

CREATE TABLE event (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT UNIQUE,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT,
    revision INTEGER NOT NULL CHECK(revision > 0),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE effect_intent (
    operation_id TEXT PRIMARY KEY,
    effect TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','executing','completed','unknown','failed')),
    receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE legacy_migration (
    source_path TEXT PRIMARY KEY,
    source_digest TEXT NOT NULL,
    source_record_id TEXT NOT NULL,
    target_task_id TEXT NOT NULL REFERENCES task(id),
    imported_at TEXT NOT NULL,
    reconciliation_json TEXT NOT NULL CHECK(json_valid(reconciliation_json))
) STRICT;

CREATE TRIGGER event_no_update BEFORE UPDATE ON event BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;
CREATE TRIGGER event_no_delete BEFORE DELETE ON event BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;
CREATE TRIGGER effect_intent_no_delete BEFORE DELETE ON effect_intent BEGIN SELECT RAISE(ABORT, 'effect history is append-only'); END;
