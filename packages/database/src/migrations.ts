import type { Client } from "@libsql/client";

/** UTC ISO-8601 with milliseconds; same shape as `Date#toISOString()`, so strings compare chronologically. */
const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

interface Migration {
  id: string;
  statements: string[];
}

/**
 * Append-only. Never edit or reorder an applied migration; add a new one instead.
 * Migrations must be additive (no DROP / destructive ALTER) unless explicitly approved.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: "0001_auth_and_employees",
    statements: [
      `CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE CHECK (email = lower(trim(email)) AND length(email) BETWEEN 3 AND 254),
        password_hash TEXT,  -- NULL until the user completes one-time password setup
        role          TEXT NOT NULL CHECK (role IN ('ADMIN', 'EMPLOYEE')),
        status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
        created_at    TEXT NOT NULL DEFAULT ${NOW},
        updated_at    TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      `CREATE TABLE employee_profiles (
        id                TEXT PRIMARY KEY,
        user_id           TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
        employee_code     TEXT NOT NULL UNIQUE CHECK (employee_code = upper(employee_code) AND length(employee_code) BETWEEN 2 AND 32),
        full_name         TEXT NOT NULL CHECK (length(full_name) BETWEEN 1 AND 120),
        timezone          TEXT NOT NULL DEFAULT 'Asia/Kolkata',
        employment_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (employment_status IN ('ACTIVE', 'ON_LEAVE', 'TERMINATED')),
        created_at        TEXT NOT NULL DEFAULT ${NOW},
        updated_at        TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      // device_identifier is a SHA-256 of the app's random installation UUID (0002); never a hardware ID.
      `CREATE TABLE devices (
        id                TEXT PRIMARY KEY,
        employee_id       TEXT NOT NULL REFERENCES employee_profiles(id) ON DELETE RESTRICT,
        device_name       TEXT NOT NULL CHECK (length(device_name) BETWEEN 1 AND 120),
        platform          TEXT NOT NULL CHECK (platform IN ('windows', 'macos')),
        device_identifier TEXT NOT NULL,
        registered_at     TEXT NOT NULL DEFAULT ${NOW},
        last_seen_at      TEXT,
        revoked_at        TEXT,
        UNIQUE (employee_id, device_identifier)
      ) STRICT`,
      `CREATE TABLE sessions (
        id                 TEXT PRIMARY KEY,
        user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        refresh_token_hash TEXT NOT NULL UNIQUE,
        expires_at         TEXT NOT NULL,
        revoked_at         TEXT,
        created_at         TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      "CREATE INDEX sessions_user_id ON sessions(user_id)",
      `CREATE TABLE account_setup_tokens (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at    TEXT,
        created_at TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      "CREATE INDEX account_setup_tokens_user_id ON account_setup_tokens(user_id)",
    ],
  },
  {
    id: "0002_devices_and_attendance",
    statements: [
      // MVP policy: one active device per employee. Revoked rows stay for the audit trail.
      "CREATE UNIQUE INDEX devices_one_active_per_employee ON devices(employee_id) WHERE revoked_at IS NULL",

      `CREATE TABLE attendance_sessions (
        id           TEXT PRIMARY KEY,
        employee_id  TEXT NOT NULL REFERENCES employee_profiles(id) ON DELETE RESTRICT,
        device_id    TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
        clock_in_at  TEXT NOT NULL,
        clock_out_at TEXT,
        status       TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
        created_at   TEXT NOT NULL DEFAULT ${NOW},
        updated_at   TEXT NOT NULL DEFAULT ${NOW},
        CHECK ((status = 'OPEN') = (clock_out_at IS NULL)),
        CHECK (clock_out_at IS NULL OR clock_out_at >= clock_in_at)
      ) STRICT`,
      "CREATE UNIQUE INDEX attendance_sessions_one_open ON attendance_sessions(employee_id) WHERE clock_out_at IS NULL",
      "CREATE INDEX attendance_sessions_employee_clock_in ON attendance_sessions(employee_id, clock_in_at)",
      // Intervals [clock_in, clock_out) of one employee never overlap (an open session runs to +infinity).
      `CREATE TRIGGER attendance_sessions_no_overlap BEFORE INSERT ON attendance_sessions
       WHEN EXISTS (SELECT 1 FROM attendance_sessions
                    WHERE employee_id = NEW.employee_id
                      AND clock_in_at < coalesce(NEW.clock_out_at, '9999')
                      AND coalesce(clock_out_at, '9999') > NEW.clock_in_at)
       BEGIN SELECT RAISE(ABORT, 'attendance_overlap'); END`,
      // Closed sessions are immutable and clock-in never changes: no silent overwrites.
      // Future corrections go through attendance_corrections with an explicit migration.
      `CREATE TRIGGER attendance_sessions_immutable BEFORE UPDATE ON attendance_sessions
       WHEN OLD.status = 'CLOSED' OR NEW.clock_in_at IS NOT OLD.clock_in_at
         OR NEW.employee_id IS NOT OLD.employee_id OR NEW.device_id IS NOT OLD.device_id
       BEGIN SELECT RAISE(ABORT, 'attendance_immutable'); END`,

      `CREATE TABLE break_sessions (
        id                    TEXT PRIMARY KEY,
        attendance_session_id TEXT NOT NULL REFERENCES attendance_sessions(id) ON DELETE RESTRICT,
        started_at            TEXT NOT NULL,
        ended_at              TEXT,
        status                TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
        created_at            TEXT NOT NULL DEFAULT ${NOW},
        updated_at            TEXT NOT NULL DEFAULT ${NOW},
        CHECK ((status = 'OPEN') = (ended_at IS NULL)),
        CHECK (ended_at IS NULL OR ended_at >= started_at)
      ) STRICT`,
      "CREATE UNIQUE INDEX break_sessions_one_open ON break_sessions(attendance_session_id) WHERE ended_at IS NULL",
      "CREATE INDEX break_sessions_session_started ON break_sessions(attendance_session_id, started_at)",
      // A break starts inside an open session, after its clock-in, and overlaps no other break.
      `CREATE TRIGGER break_sessions_valid_insert BEFORE INSERT ON break_sessions
       WHEN NOT EXISTS (SELECT 1 FROM attendance_sessions
                        WHERE id = NEW.attendance_session_id AND status = 'OPEN' AND clock_in_at <= NEW.started_at)
         OR EXISTS (SELECT 1 FROM break_sessions
                    WHERE attendance_session_id = NEW.attendance_session_id
                      AND started_at < coalesce(NEW.ended_at, '9999')
                      AND coalesce(ended_at, '9999') > NEW.started_at)
       BEGIN SELECT RAISE(ABORT, 'break_overlap'); END`,
      `CREATE TRIGGER break_sessions_immutable BEFORE UPDATE ON break_sessions
       WHEN OLD.status = 'CLOSED' OR NEW.started_at IS NOT OLD.started_at
         OR NEW.attendance_session_id IS NOT OLD.attendance_session_id
       BEGIN SELECT RAISE(ABORT, 'attendance_immutable'); END`,
      // Clock-out only after every break of the session has ended.
      `CREATE TRIGGER attendance_sessions_close_after_breaks BEFORE UPDATE OF clock_out_at ON attendance_sessions
       WHEN NEW.clock_out_at IS NOT NULL AND EXISTS (
         SELECT 1 FROM break_sessions
         WHERE attendance_session_id = NEW.id AND coalesce(ended_at, '9999') > NEW.clock_out_at)
       BEGIN SELECT RAISE(ABORT, 'break_open'); END`,

      // Append-only log of every attendance action received, accepted or rejected.
      `CREATE TABLE attendance_events (
        id              TEXT PRIMARY KEY,
        employee_id     TEXT NOT NULL REFERENCES employee_profiles(id) ON DELETE RESTRICT,
        device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
        event_type      TEXT NOT NULL CHECK (event_type IN ('CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT')),
        occurred_at     TEXT NOT NULL,  -- effective UTC time: server time online, skew-corrected device time offline
        device_time     TEXT,           -- raw device clock reading (desktop sync uploads)
        received_at     TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        source          TEXT NOT NULL CHECK (source IN ('ONLINE', 'OFFLINE_SYNC')),
        outcome         TEXT NOT NULL CHECK (outcome IN ('ACCEPTED', 'REJECTED')),
        reject_reason   TEXT,
        created_at      TEXT NOT NULL DEFAULT ${NOW},
        UNIQUE (employee_id, idempotency_key),
        CHECK ((outcome = 'REJECTED') = (reject_reason IS NOT NULL))
      ) STRICT`,
      "CREATE INDEX attendance_events_employee_received ON attendance_events(employee_id, received_at)",
      "CREATE TRIGGER attendance_events_no_update BEFORE UPDATE ON attendance_events BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER attendance_events_no_delete BEFORE DELETE ON attendance_events BEGIN SELECT RAISE(ABORT, 'append_only'); END",

      // No API writes this yet; the table fixes the audit-trail shape for admin corrections.
      `CREATE TABLE attendance_corrections (
        id                    TEXT PRIMARY KEY,
        attendance_session_id TEXT NOT NULL REFERENCES attendance_sessions(id) ON DELETE RESTRICT,
        requested_by          TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        approved_by           TEXT REFERENCES users(id) ON DELETE RESTRICT,
        original_values       TEXT NOT NULL CHECK (json_valid(original_values)),
        corrected_values      TEXT NOT NULL CHECK (json_valid(corrected_values)),
        reason                TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 1000),
        created_at            TEXT NOT NULL DEFAULT ${NOW},
        CHECK (approved_by IS NULL OR approved_by <> requested_by)
      ) STRICT`,
      "CREATE INDEX attendance_corrections_session ON attendance_corrections(attendance_session_id)",
      // Only a one-time approval may be recorded; nothing else ever changes or disappears.
      `CREATE TRIGGER attendance_corrections_append_only BEFORE UPDATE ON attendance_corrections
       WHEN OLD.approved_by IS NOT NULL OR NEW.attendance_session_id IS NOT OLD.attendance_session_id
         OR NEW.requested_by IS NOT OLD.requested_by OR NEW.original_values IS NOT OLD.original_values
         OR NEW.corrected_values IS NOT OLD.corrected_values OR NEW.reason IS NOT OLD.reason
         OR NEW.created_at IS NOT OLD.created_at
       BEGIN SELECT RAISE(ABORT, 'append_only'); END`,
      "CREATE TRIGGER attendance_corrections_no_delete BEFORE DELETE ON attendance_corrections BEGIN SELECT RAISE(ABORT, 'append_only'); END",
    ],
  },
  {
    id: "0003_correction_workflow",
    statements: [
      // Employee requests; nothing changes until an admin (not the requester) approves.
      `CREATE TABLE correction_requests (
        id                    TEXT PRIMARY KEY,
        employee_id           TEXT NOT NULL REFERENCES employee_profiles(id) ON DELETE RESTRICT,
        requested_by          TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        type                  TEXT NOT NULL CHECK (type IN ('MISSING_CLOCK_IN', 'MISSING_CLOCK_OUT', 'BREAK_TIME', 'ATTENDANCE_TIME')),
        attendance_session_id TEXT REFERENCES attendance_sessions(id) ON DELETE RESTRICT,
        break_session_id      TEXT REFERENCES break_sessions(id) ON DELETE RESTRICT,
        proposed              TEXT NOT NULL CHECK (json_valid(proposed)),
        reason                TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 1000),
        status                TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
        reviewed_by           TEXT REFERENCES users(id) ON DELETE RESTRICT,
        reviewed_at           TEXT,
        review_reason         TEXT CHECK (review_reason IS NULL OR length(trim(review_reason)) BETWEEN 3 AND 1000),
        created_at            TEXT NOT NULL DEFAULT ${NOW},
        updated_at            TEXT NOT NULL DEFAULT ${NOW},
        CHECK ((status = 'PENDING') = (reviewed_by IS NULL)),
        CHECK ((status = 'PENDING') = (reviewed_at IS NULL)),
        CHECK (status = 'PENDING' OR review_reason IS NOT NULL),
        CHECK (reviewed_by IS NULL OR reviewed_by <> requested_by)
      ) STRICT`,
      "CREATE INDEX correction_requests_employee ON correction_requests(employee_id, created_at)",
      "CREATE INDEX correction_requests_status ON correction_requests(status, created_at)",
      // A request is reviewed exactly once; its content never changes; nothing is deleted.
      `CREATE TRIGGER correction_requests_review_once BEFORE UPDATE ON correction_requests
       WHEN OLD.status <> 'PENDING' OR NEW.employee_id IS NOT OLD.employee_id OR NEW.requested_by IS NOT OLD.requested_by
         OR NEW.type IS NOT OLD.type OR NEW.attendance_session_id IS NOT OLD.attendance_session_id
         OR NEW.break_session_id IS NOT OLD.break_session_id OR NEW.proposed IS NOT OLD.proposed
         OR NEW.reason IS NOT OLD.reason OR NEW.created_at IS NOT OLD.created_at
       BEGIN SELECT RAISE(ABORT, 'already_reviewed'); END`,
      "CREATE TRIGGER correction_requests_no_delete BEFORE DELETE ON correction_requests BEGIN SELECT RAISE(ABORT, 'append_only'); END",

      // attendance_corrections (0002) becomes the record of each applied change, linked to its request.
      "ALTER TABLE attendance_corrections ADD COLUMN request_id TEXT REFERENCES correction_requests(id)",
      // Sessions/breaks point at the approved correction that last changed them.
      "ALTER TABLE attendance_sessions ADD COLUMN correction_id TEXT REFERENCES attendance_corrections(id)",
      "ALTER TABLE break_sessions ADD COLUMN correction_id TEXT REFERENCES attendance_corrections(id)",

      // Replace the 0002 immutability guards (triggers only, no data touched): closed records and
      // clock-in times may change only in the same statement that links a new, approved
      // attendance_corrections row for that session.
      "DROP TRIGGER attendance_sessions_immutable",
      `CREATE TRIGGER attendance_sessions_immutable BEFORE UPDATE ON attendance_sessions
       WHEN NEW.employee_id IS NOT OLD.employee_id OR NEW.device_id IS NOT OLD.device_id
         OR ((OLD.status = 'CLOSED' OR NEW.clock_in_at IS NOT OLD.clock_in_at)
             AND NOT (NEW.correction_id IS NOT OLD.correction_id AND EXISTS (
               SELECT 1 FROM attendance_corrections c
               WHERE c.id = NEW.correction_id AND c.attendance_session_id = NEW.id AND c.approved_by IS NOT NULL)))
       BEGIN SELECT RAISE(ABORT, 'attendance_immutable'); END`,
      "DROP TRIGGER break_sessions_immutable",
      `CREATE TRIGGER break_sessions_immutable BEFORE UPDATE ON break_sessions
       WHEN NEW.attendance_session_id IS NOT OLD.attendance_session_id
         OR ((OLD.status = 'CLOSED' OR NEW.started_at IS NOT OLD.started_at)
             AND NOT (NEW.correction_id IS NOT OLD.correction_id AND EXISTS (
               SELECT 1 FROM attendance_corrections c
               WHERE c.id = NEW.correction_id AND c.attendance_session_id = NEW.attendance_session_id AND c.approved_by IS NOT NULL)))
       BEGIN SELECT RAISE(ABORT, 'attendance_immutable'); END`,
      // Updated times must keep the 0002 invariants (no overlaps, breaks inside their session).
      `CREATE TRIGGER attendance_sessions_no_overlap_update BEFORE UPDATE OF clock_in_at, clock_out_at ON attendance_sessions
       WHEN EXISTS (SELECT 1 FROM attendance_sessions
                    WHERE employee_id = NEW.employee_id AND id <> NEW.id
                      AND clock_in_at < coalesce(NEW.clock_out_at, '9999')
                      AND coalesce(clock_out_at, '9999') > NEW.clock_in_at)
       BEGIN SELECT RAISE(ABORT, 'attendance_overlap'); END`,
      `CREATE TRIGGER attendance_sessions_contain_breaks BEFORE UPDATE OF clock_in_at ON attendance_sessions
       WHEN EXISTS (SELECT 1 FROM break_sessions WHERE attendance_session_id = NEW.id AND started_at < NEW.clock_in_at)
       BEGIN SELECT RAISE(ABORT, 'break_overlap'); END`,
      `CREATE TRIGGER break_sessions_valid_update BEFORE UPDATE OF started_at, ended_at ON break_sessions
       WHEN EXISTS (SELECT 1 FROM break_sessions
                    WHERE attendance_session_id = NEW.attendance_session_id AND id <> NEW.id
                      AND started_at < coalesce(NEW.ended_at, '9999')
                      AND coalesce(ended_at, '9999') > NEW.started_at)
         OR NOT EXISTS (SELECT 1 FROM attendance_sessions s
                        WHERE s.id = NEW.attendance_session_id AND s.clock_in_at <= NEW.started_at
                          AND (s.clock_out_at IS NULL OR coalesce(NEW.ended_at, '9999') <= s.clock_out_at))
       BEGIN SELECT RAISE(ABORT, 'break_overlap'); END`,
      // Finds the event that recorded a session's clock-in (history "source" column).
      "CREATE INDEX attendance_events_employee_type_time ON attendance_events(employee_id, event_type, occurred_at)",
    ],
  },
  {
    id: "0004_activity_monitoring",
    statements: [
      // Employees acknowledge the monitoring notice (per version) before any activity is accepted.
      `CREATE TABLE monitoring_consents (
        id              TEXT PRIMARY KEY,
        employee_id     TEXT NOT NULL REFERENCES employee_profiles(id) ON DELETE RESTRICT,
        notice_version  TEXT NOT NULL CHECK (length(notice_version) BETWEEN 1 AND 64),
        acknowledged_at TEXT NOT NULL DEFAULT ${NOW},
        UNIQUE (employee_id, notice_version)
      ) STRICT`,
      "CREATE TRIGGER monitoring_consents_no_update BEFORE UPDATE ON monitoring_consents BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER monitoring_consents_no_delete BEFORE DELETE ON monitoring_consents BEGIN SELECT RAISE(ABORT, 'append_only'); END",

      // Aggregated foreground-application intervals. Raw samples are never stored. Only an
      // application name/identifier: no window titles, documents, URLs or input.
      `CREATE TABLE activity_intervals (
        id                     TEXT PRIMARY KEY,
        employee_id            TEXT NOT NULL REFERENCES employee_profiles(id) ON DELETE RESTRICT,
        device_id              TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
        attendance_session_id  TEXT NOT NULL REFERENCES attendance_sessions(id) ON DELETE RESTRICT,
        kind                   TEXT NOT NULL CHECK (kind IN ('ACTIVE', 'IDLE')),
        application_identifier TEXT CHECK (application_identifier IS NULL OR length(application_identifier) BETWEEN 1 AND 255),
        application_name       TEXT CHECK (application_name IS NULL OR length(application_name) BETWEEN 1 AND 255),
        started_at             TEXT NOT NULL,
        ended_at               TEXT NOT NULL,
        active_seconds         INTEGER NOT NULL CHECK (active_seconds >= 0),
        idle_seconds           INTEGER NOT NULL CHECK (idle_seconds >= 0),
        source                 TEXT NOT NULL CHECK (source IN ('DESKTOP_MACOS', 'DESKTOP_WINDOWS')),
        device_started_at      TEXT NOT NULL,  -- raw device clock before skew correction
        received_at            TEXT NOT NULL,
        idempotency_key        TEXT NOT NULL,
        created_at             TEXT NOT NULL DEFAULT ${NOW},
        UNIQUE (employee_id, idempotency_key),
        CHECK (ended_at > started_at),
        CHECK ((kind = 'ACTIVE' AND idle_seconds = 0 AND application_name IS NOT NULL)
            OR (kind = 'IDLE' AND active_seconds = 0 AND application_name IS NULL AND application_identifier IS NULL))
      ) STRICT`,
      "CREATE INDEX activity_intervals_employee_started ON activity_intervals(employee_id, started_at)",
      "CREATE INDEX activity_intervals_session ON activity_intervals(attendance_session_id)",
      // One employee's intervals never overlap, so no time is counted twice.
      `CREATE TRIGGER activity_intervals_no_overlap BEFORE INSERT ON activity_intervals
       WHEN EXISTS (SELECT 1 FROM activity_intervals
                    WHERE employee_id = NEW.employee_id AND started_at < NEW.ended_at AND ended_at > NEW.started_at)
       BEGIN SELECT RAISE(ABORT, 'activity_overlap'); END`,
      "CREATE TRIGGER activity_intervals_no_update BEFORE UPDATE ON activity_intervals BEGIN SELECT RAISE(ABORT, 'append_only'); END",
    ],
  },
  {
    id: "0005_monitoring_policy_and_retention",
    statements: [
      // Employee-visible monitoring notices. Append-only: a wording change is a new version.
      `CREATE TABLE monitoring_notices (
        version    TEXT PRIMARY KEY CHECK (length(version) BETWEEN 1 AND 64),
        title      TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        points     TEXT NOT NULL CHECK (json_valid(points) AND json_type(points) = 'array' AND json_array_length(points) BETWEEN 1 AND 20),
        draft      INTEGER NOT NULL CHECK (draft IN (0, 1)),
        created_by TEXT REFERENCES users(id) ON DELETE RESTRICT,  -- NULL for the seeded notice
        created_at TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      "CREATE TRIGGER monitoring_notices_no_update BEFORE UPDATE ON monitoring_notices BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER monitoring_notices_no_delete BEFORE DELETE ON monitoring_notices BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      // The Day 5 draft notice, verbatim, so existing acknowledgements keep pointing at its text.
      `INSERT INTO monitoring_notices (version, title, points, draft) VALUES ('2026-10-draft-1', 'Activity monitoring on this computer', json('${JSON.stringify([
        "While you are clocked in and not on a break, this app records which application is in the foreground (its name and identifier) and for how long.",
        "It records when you are idle: no keyboard or mouse input for the configured time, or the screen is locked. It never records what you type or click.",
        "It does not record window titles, document names, websites or URLs, clipboard contents, keystrokes or screenshots.",
        "Nothing is recorded before you clock in, during breaks or after you clock out. The app always shows whether monitoring is on.",
        "Your administrators can see these records for attendance and workload purposes. You can see your own totals in this app.",
      ])}'), 1)`,

      // Server-controlled monitoring policy. Append-only history: the row with the highest seq is in
      // effect from its effective_at; earlier rows say what applied at earlier times (used to check
      // uploads recorded offline). No rows = the API's env defaults.
      `CREATE TABLE monitoring_policies (
        seq                    INTEGER PRIMARY KEY,
        monitoring_enabled     INTEGER NOT NULL CHECK (monitoring_enabled IN (0, 1)),
        sample_seconds         INTEGER NOT NULL CHECK (sample_seconds BETWEEN 5 AND 300),
        idle_threshold_seconds INTEGER NOT NULL CHECK (idle_threshold_seconds BETWEEN 30 AND 3600),
        retention_days         INTEGER NOT NULL CHECK (retention_days BETWEEN 7 AND 3650),
        retention_approved     INTEGER NOT NULL CHECK (retention_approved IN (0, 1)),
        notice_version         TEXT NOT NULL REFERENCES monitoring_notices(version) ON DELETE RESTRICT,
        reason                 TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
        changed_by             TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        effective_at           TEXT NOT NULL DEFAULT ${NOW},
        CHECK (idle_threshold_seconds >= 2 * sample_seconds)
      ) STRICT`,
      "CREATE TRIGGER monitoring_policies_no_update BEFORE UPDATE ON monitoring_policies BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER monitoring_policies_no_delete BEFORE DELETE ON monitoring_policies BEGIN SELECT RAISE(ABORT, 'append_only'); END",

      // Every retention purge is recorded (no silent deletion). triggered_by NULL = scheduled job.
      `CREATE TABLE activity_retention_runs (
        id             TEXT PRIMARY KEY,
        cutoff         TEXT NOT NULL,
        retention_days INTEGER NOT NULL,
        deleted        INTEGER NOT NULL CHECK (deleted >= 0),
        triggered_by   TEXT REFERENCES users(id) ON DELETE RESTRICT,
        ran_at         TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      "CREATE TRIGGER activity_retention_runs_no_update BEFORE UPDATE ON activity_retention_runs BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER activity_retention_runs_no_delete BEFORE DELETE ON activity_retention_runs BEGIN SELECT RAISE(ABORT, 'append_only'); END",

      // With this index the overlap trigger (0004) searches only intervals ending after the new one
      // starts (a handful for chronological uploads) instead of the employee's whole history.
      "CREATE INDEX activity_intervals_employee_ended ON activity_intervals(employee_id, ended_at)",
      // Retention purge scans by end time across employees.
      "CREATE INDEX activity_intervals_ended ON activity_intervals(ended_at)",
      // Intervals are at most 24 h (also validated by the API), which bounds every overlap search.
      `CREATE TRIGGER activity_intervals_max_duration BEFORE INSERT ON activity_intervals
       WHEN julianday(NEW.ended_at) - julianday(NEW.started_at) > 1
       BEGIN SELECT RAISE(ABORT, 'activity_too_long'); END`,
    ],
  },
  {
    id: "0006_screenshots",
    statements: [
      // Screenshot-specific notice (same append-only notices table; acknowledgements in monitoring_consents).
      `INSERT INTO monitoring_notices (version, title, points, draft) VALUES ('2026-10-screenshots-draft-1', 'Screenshots on this computer', json('${JSON.stringify([
        "When your organization turns screenshots on, this app takes a picture of your main screen at a fixed interval while you are clocked in and not on a break.",
        "Screenshots show whatever is on your main screen at that moment and may include personal or sensitive information (messages, documents, websites). Other monitors are not captured. Nothing is blurred or hidden automatically.",
        "No screenshots are taken before you acknowledge this notice, during breaks, after you clock out, while the screen is locked or while the computer is asleep.",
        "The app always shows whether screenshots are on, when the next one is due and when the last one was taken. macOS asks you to allow screen recording; you can withdraw it in System Settings at any time, which stops screenshots.",
        "Screenshots are uploaded to your organization's Microsoft 365 storage. Only administrators can view them, and every view is logged. They are deleted after the retention period set by your organization.",
      ]).replaceAll("'", "''")}'), 1)`,

      // Server-controlled screenshot policy. Append-only like monitoring_policies; no rows = defaults (off).
      `CREATE TABLE screenshot_policies (
        seq                  INTEGER PRIMARY KEY,
        screenshots_enabled  INTEGER NOT NULL CHECK (screenshots_enabled IN (0, 1)),
        interval_seconds     INTEGER NOT NULL CHECK (interval_seconds BETWEEN 60 AND 3600),
        webp_quality         INTEGER NOT NULL CHECK (webp_quality BETWEEN 30 AND 95),
        max_dimension        INTEGER NOT NULL CHECK (max_dimension BETWEEN 640 AND 3840),
        capture_scope        TEXT NOT NULL CHECK (capture_scope = 'PRIMARY_DISPLAY'),
        retention_days       INTEGER NOT NULL CHECK (retention_days BETWEEN 7 AND 3650),
        retention_approved   INTEGER NOT NULL CHECK (retention_approved IN (0, 1)),
        notice_version       TEXT NOT NULL REFERENCES monitoring_notices(version) ON DELETE RESTRICT,
        reason               TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
        changed_by           TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        effective_at         TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      "CREATE TRIGGER screenshot_policies_no_update BEFORE UPDATE ON screenshot_policies BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER screenshot_policies_no_delete BEFORE DELETE ON screenshot_policies BEGIN SELECT RAISE(ABORT, 'append_only'); END",

      // Metadata only: the image lives in the storage provider (SharePoint/OneDrive via Graph), never here.
      `CREATE TABLE screenshots (
        id                    TEXT PRIMARY KEY,
        employee_id           TEXT NOT NULL REFERENCES employee_profiles(id) ON DELETE RESTRICT,
        device_id             TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
        attendance_session_id TEXT NOT NULL REFERENCES attendance_sessions(id) ON DELETE RESTRICT,
        idempotency_key       TEXT NOT NULL,
        captured_at           TEXT NOT NULL,
        device_captured_at    TEXT NOT NULL,  -- raw device clock before skew correction
        width                 INTEGER NOT NULL CHECK (width BETWEEN 1 AND 3840),
        height                INTEGER NOT NULL CHECK (height BETWEEN 1 AND 3840),
        mime_type             TEXT NOT NULL CHECK (mime_type = 'image/webp'),
        file_size_bytes       INTEGER NOT NULL CHECK (file_size_bytes BETWEEN 1 AND 10485760),
        checksum              TEXT NOT NULL CHECK (length(checksum) = 64),  -- SHA-256, hex
        storage_provider      TEXT NOT NULL CHECK (storage_provider IN ('LOCAL_DEV', 'MICROSOFT_GRAPH')),
        storage_key           TEXT NOT NULL UNIQUE,  -- server-generated path; no names or content
        storage_item_id       TEXT,                  -- provider's id, once storage confirmed
        upload_status         TEXT NOT NULL CHECK (upload_status IN ('REGISTERED', 'STORED', 'DELETED')),
        stored_at             TEXT,
        deleted_at            TEXT,
        deleted_by            TEXT REFERENCES users(id) ON DELETE RESTRICT,  -- NULL with deleted_at = scheduled retention
        created_at            TEXT NOT NULL DEFAULT ${NOW},
        updated_at            TEXT NOT NULL DEFAULT ${NOW},
        UNIQUE (employee_id, idempotency_key),
        CHECK (upload_status = 'REGISTERED' OR stored_at IS NOT NULL OR deleted_at IS NOT NULL),
        CHECK ((upload_status = 'DELETED') = (deleted_at IS NOT NULL))
      ) STRICT`,
      "CREATE INDEX screenshots_employee_captured ON screenshots(employee_id, captured_at)",
      "CREATE INDEX screenshots_status_captured ON screenshots(upload_status, captured_at)",
      // What was captured, by whom and where is fixed once registered; only the upload state moves.
      `CREATE TRIGGER screenshots_immutable BEFORE UPDATE OF id, employee_id, device_id, attendance_session_id, idempotency_key,
         captured_at, device_captured_at, width, height, mime_type, file_size_bytes, checksum, storage_provider, storage_key, created_at
       ON screenshots BEGIN SELECT RAISE(ABORT, 'screenshot_immutable'); END`,
      // REGISTERED -> STORED -> DELETED (or REGISTERED -> DELETED); never back.
      `CREATE TRIGGER screenshots_transition BEFORE UPDATE OF upload_status ON screenshots
       WHEN NOT (OLD.upload_status = NEW.upload_status
              OR (OLD.upload_status = 'REGISTERED' AND NEW.upload_status IN ('STORED', 'DELETED'))
              OR (OLD.upload_status = 'STORED' AND NEW.upload_status = 'DELETED'))
       BEGIN SELECT RAISE(ABORT, 'screenshot_transition'); END`,
      // Rows are the audit trail of what was captured and deleted: never removed.
      "CREATE TRIGGER screenshots_no_delete BEFORE DELETE ON screenshots BEGIN SELECT RAISE(ABORT, 'append_only'); END",

      // Every view of a screenshot image (append-only).
      `CREATE TABLE screenshot_access_log (
        id            TEXT PRIMARY KEY,
        screenshot_id TEXT NOT NULL REFERENCES screenshots(id) ON DELETE RESTRICT,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        accessed_at   TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      "CREATE INDEX screenshot_access_log_screenshot ON screenshot_access_log(screenshot_id)",
      "CREATE TRIGGER screenshot_access_log_no_update BEFORE UPDATE ON screenshot_access_log BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER screenshot_access_log_no_delete BEFORE DELETE ON screenshot_access_log BEGIN SELECT RAISE(ABORT, 'append_only'); END",
    ],
  },
  {
    id: "0007_screenshot_gallery_and_retention_runs",
    statements: [
      // What the viewer did: full-size view or gallery thumbnail (same bytes, both logged). Earlier rows were views.
      "ALTER TABLE screenshot_access_log ADD COLUMN action TEXT NOT NULL DEFAULT 'VIEW' CHECK (action IN ('VIEW', 'THUMBNAIL'))",
      "CREATE INDEX screenshot_access_log_user ON screenshot_access_log(user_id, accessed_at)",
      // Whether employees may view their own screenshots (admins always can). Earlier policies allowed it.
      "ALTER TABLE screenshot_policies ADD COLUMN employee_self_view INTEGER NOT NULL DEFAULT 1 CHECK (employee_self_view IN (0, 1))",
      // One row per retention run (no silent deletion): what was deleted, what failed, and how the
      // provider deletes (SharePoint recycle bin = still recoverable for a while).
      `CREATE TABLE screenshot_retention_runs (
        id             TEXT PRIMARY KEY,
        cutoff         TEXT NOT NULL,
        retention_days INTEGER NOT NULL,
        deleted        INTEGER NOT NULL CHECK (deleted >= 0),
        failed         INTEGER NOT NULL CHECK (failed >= 0),
        deletion_mode  TEXT NOT NULL CHECK (deletion_mode IN ('LOCAL_DEV', 'RECYCLE_BIN', 'PERMANENT')),
        triggered_by   TEXT REFERENCES users(id) ON DELETE RESTRICT,  -- NULL = scheduled job
        ran_at         TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      "CREATE TRIGGER screenshot_retention_runs_no_update BEFORE UPDATE ON screenshot_retention_runs BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER screenshot_retention_runs_no_delete BEFORE DELETE ON screenshot_retention_runs BEGIN SELECT RAISE(ABORT, 'append_only'); END",
    ],
  },
];

/**
 * Applies pending migrations, each atomically together with its bookkeeping row.
 * Safe to run repeatedly and concurrently: a racing runner fails its batch and rolls back.
 * Returns the ids applied by this call.
 */
export async function migrate(db: Client): Promise<string[]> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT ${NOW}) STRICT`,
  );
  const applied = new Set((await db.execute("SELECT id FROM schema_migrations")).rows.map((r) => String(r.id)));
  const ran: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    await db.batch([...m.statements, { sql: "INSERT INTO schema_migrations (id) VALUES (?)", args: [m.id] }], "write");
    ran.push(m.id);
  }
  return ran;
}
