import { createHash } from "node:crypto";
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
  {
    id: "0008_timelapses",
    statements: [
      // Videos made from one session's stored screenshots. The file lives on the API host
      // (short-lived, regenerable); the row stays as the record of who made it and what happened.
      `CREATE TABLE timelapses (
        id                    TEXT PRIMARY KEY,
        employee_id           TEXT NOT NULL REFERENCES employee_profiles(id) ON DELETE RESTRICT,
        attendance_session_id TEXT NOT NULL REFERENCES attendance_sessions(id) ON DELETE RESTRICT,
        requested_by          TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        fps                   INTEGER NOT NULL CHECK (fps BETWEEN 1 AND 30),
        status                TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'CANCELLED', 'EXPIRED', 'DELETED')),
        frames_total          INTEGER NOT NULL CHECK (frames_total >= 0),
        frames_done           INTEGER NOT NULL DEFAULT 0 CHECK (frames_done >= 0),
        frames_skipped        INTEGER NOT NULL DEFAULT 0 CHECK (frames_skipped >= 0),
        first_captured_at     TEXT,
        last_captured_at      TEXT,
        size_bytes            INTEGER,
        sha256                TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
        error                 TEXT,
        created_at            TEXT NOT NULL DEFAULT ${NOW},
        started_at            TEXT,
        finished_at           TEXT,
        expires_at            TEXT,
        CHECK (status != 'READY' OR (sha256 IS NOT NULL AND size_bytes IS NOT NULL AND expires_at IS NOT NULL))
      ) STRICT`,
      // At most one job queued or encoding per session: a second request gets the same job.
      "CREATE UNIQUE INDEX timelapses_one_active ON timelapses(attendance_session_id) WHERE status IN ('QUEUED', 'RUNNING')",
      "CREATE INDEX timelapses_status ON timelapses(status, created_at)",
      "CREATE TRIGGER timelapses_no_delete BEFORE DELETE ON timelapses BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      // Every create, view, download, cancel and delete of a timelapse (append-only).
      `CREATE TABLE timelapse_access_log (
        id           TEXT PRIMARY KEY,
        timelapse_id TEXT NOT NULL REFERENCES timelapses(id) ON DELETE RESTRICT,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        action       TEXT NOT NULL CHECK (action IN ('CREATE', 'VIEW', 'DOWNLOAD', 'CANCEL', 'DELETE')),
        accessed_at  TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      "CREATE INDEX timelapse_access_log_timelapse ON timelapse_access_log(timelapse_id)",
      "CREATE TRIGGER timelapse_access_log_no_update BEFORE UPDATE ON timelapse_access_log BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER timelapse_access_log_no_delete BEFORE DELETE ON timelapse_access_log BEGIN SELECT RAISE(ABORT, 'append_only'); END",
    ],
  },
  {
    id: "0009_screenshot_privacy_masks",
    statements: [
      // Privacy masks (rectangles blacked out on the device before encoding), part of each policy
      // version. Existing versions get none, which is what was captured under them.
      `ALTER TABLE screenshot_policies ADD COLUMN mask_regions TEXT NOT NULL DEFAULT '[]'
         CHECK (json_valid(mask_regions) AND json_type(mask_regions) = 'array' AND json_array_length(mask_regions) <= 20)`,
      // How many masks the agent applied to this image (checked against the policy at registration).
      "ALTER TABLE screenshots ADD COLUMN mask_count INTEGER NOT NULL DEFAULT 0 CHECK (mask_count BETWEEN 0 AND 20)",
      "DROP TRIGGER screenshots_immutable",
      `CREATE TRIGGER screenshots_immutable BEFORE UPDATE OF id, employee_id, device_id, attendance_session_id, idempotency_key,
         captured_at, device_captured_at, width, height, mime_type, file_size_bytes, checksum, storage_provider, storage_key, created_at, mask_count
       ON screenshots BEGIN SELECT RAISE(ABORT, 'screenshot_immutable'); END`,
    ],
  },
  {
    id: "0010_leave_requests",
    statements: [
      // Policy-neutral leave requests (F10): what was asked and what was decided. No types, balances
      // or payroll fields, and no link to attendance. Dates are local dates in the employee's zone.
      `CREATE TABLE leave_requests (
        id            TEXT PRIMARY KEY,
        employee_id   TEXT NOT NULL REFERENCES employee_profiles(id) ON DELETE RESTRICT,
        requested_by  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        start_date    TEXT NOT NULL CHECK (date(start_date) IS start_date),
        end_date      TEXT NOT NULL CHECK (date(end_date) IS end_date),
        portion       TEXT NOT NULL CHECK (portion IN ('FULL_DAY', 'FIRST_HALF', 'SECOND_HALF', 'SHORT')),
        start_time    TEXT CHECK (start_time IS NULL OR start_time GLOB '[01][0-9]:[0-5][0-9]' OR start_time GLOB '2[0-3]:[0-5][0-9]'),
        end_time      TEXT CHECK (end_time IS NULL OR end_time GLOB '[01][0-9]:[0-5][0-9]' OR end_time GLOB '2[0-3]:[0-5][0-9]'),
        reason        TEXT CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 500),
        status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
        decided_by    TEXT REFERENCES users(id) ON DELETE RESTRICT,
        decided_at    TEXT,
        decision_note TEXT CHECK (decision_note IS NULL OR length(trim(decision_note)) BETWEEN 1 AND 1000),
        created_at    TEXT NOT NULL DEFAULT ${NOW},
        updated_at    TEXT NOT NULL DEFAULT ${NOW},
        CHECK (end_date >= start_date),
        CHECK (portion = 'FULL_DAY' OR end_date = start_date),
        CHECK ((portion = 'SHORT') = (start_time IS NOT NULL AND end_time IS NOT NULL)),
        CHECK (portion = 'SHORT' OR (start_time IS NULL AND end_time IS NULL)),
        CHECK (end_time IS NULL OR end_time > start_time),
        CHECK ((status = 'PENDING') = (decided_by IS NULL)),
        CHECK ((status = 'PENDING') = (decided_at IS NULL)),
        CHECK (status <> 'CANCELLED' OR decided_by = requested_by),
        CHECK (status NOT IN ('APPROVED', 'REJECTED') OR decided_by <> requested_by)
      ) STRICT`,
      "CREATE INDEX leave_requests_employee ON leave_requests(employee_id, start_date)",
      "CREATE INDEX leave_requests_status ON leave_requests(status, created_at)",
      // Decided exactly once (approve, reject or cancel); the request itself never changes; nothing is deleted.
      `CREATE TRIGGER leave_requests_decide_once BEFORE UPDATE ON leave_requests
       WHEN OLD.status <> 'PENDING' OR NEW.employee_id IS NOT OLD.employee_id OR NEW.requested_by IS NOT OLD.requested_by
         OR NEW.start_date IS NOT OLD.start_date OR NEW.end_date IS NOT OLD.end_date OR NEW.portion IS NOT OLD.portion
         OR NEW.start_time IS NOT OLD.start_time OR NEW.end_time IS NOT OLD.end_time
         OR NEW.reason IS NOT OLD.reason OR NEW.created_at IS NOT OLD.created_at
       BEGIN SELECT RAISE(ABORT, 'already_reviewed'); END`,
      "CREATE TRIGGER leave_requests_no_delete BEFORE DELETE ON leave_requests BEGIN SELECT RAISE(ABORT, 'append_only'); END",
    ],
  },
  {
    id: "0011_project_time",
    statements: [
      // Projects and tasks are administered by admins; nothing is deleted (archive / close instead).
      `CREATE TABLE projects (
        id          TEXT PRIMARY KEY,
        code        TEXT NOT NULL UNIQUE CHECK (code = upper(code) AND length(code) BETWEEN 2 AND 32),
        name        TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
        description TEXT CHECK (description IS NULL OR length(description) <= 1000),
        status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
        created_by  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at  TEXT NOT NULL DEFAULT ${NOW},
        updated_at  TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      `CREATE TABLE project_tasks (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        title      TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
        status     TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL DEFAULT ${NOW},
        updated_at TEXT NOT NULL DEFAULT ${NOW},
        UNIQUE (id, project_id)
      ) STRICT`,
      // Assignment history: removal ends a row (kept); one current assignment per employee and project.
      `CREATE TABLE project_members (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        employee_id TEXT NOT NULL REFERENCES employee_profiles(id) ON DELETE RESTRICT,
        assigned_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        assigned_at TEXT NOT NULL DEFAULT ${NOW},
        removed_by  TEXT REFERENCES users(id) ON DELETE RESTRICT,
        removed_at  TEXT,
        CHECK ((removed_by IS NULL) = (removed_at IS NULL))
      ) STRICT`,
      "CREATE UNIQUE INDEX project_members_current ON project_members(project_id, employee_id) WHERE removed_at IS NULL",
      `CREATE TRIGGER project_members_end_once BEFORE UPDATE ON project_members
       WHEN OLD.removed_at IS NOT NULL OR NEW.project_id IS NOT OLD.project_id OR NEW.employee_id IS NOT OLD.employee_id
         OR NEW.assigned_by IS NOT OLD.assigned_by OR NEW.assigned_at IS NOT OLD.assigned_at
       BEGIN SELECT RAISE(ABORT, 'append_only'); END`,
      "CREATE TRIGGER project_members_no_delete BEFORE DELETE ON project_members BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      // Timer entries: server times only; one running per employee; ended once; never edited or deleted.
      `CREATE TABLE task_time_entries (
        id                    TEXT PRIMARY KEY,
        employee_id           TEXT NOT NULL REFERENCES employee_profiles(id) ON DELETE RESTRICT,
        project_id            TEXT NOT NULL,
        task_id               TEXT NOT NULL,
        attendance_session_id TEXT NOT NULL REFERENCES attendance_sessions(id) ON DELETE RESTRICT,
        started_at            TEXT NOT NULL,
        ended_at              TEXT,
        end_reason            TEXT CHECK (end_reason IN ('PAUSED', 'STOPPED', 'BREAK', 'CLOCK_OUT')),
        created_at            TEXT NOT NULL DEFAULT ${NOW},
        FOREIGN KEY (task_id, project_id) REFERENCES project_tasks(id, project_id) ON DELETE RESTRICT,
        CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
        CHECK (ended_at IS NULL OR ended_at >= started_at)
      ) STRICT`,
      "CREATE UNIQUE INDEX task_time_entries_one_running ON task_time_entries(employee_id) WHERE ended_at IS NULL",
      "CREATE INDEX task_time_entries_employee_started ON task_time_entries(employee_id, started_at)",
      "CREATE INDEX task_time_entries_project_started ON task_time_entries(project_id, started_at)",
      `CREATE TRIGGER task_time_entries_end_once BEFORE UPDATE ON task_time_entries
       WHEN OLD.ended_at IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.employee_id IS NOT OLD.employee_id
         OR NEW.project_id IS NOT OLD.project_id OR NEW.task_id IS NOT OLD.task_id
         OR NEW.attendance_session_id IS NOT OLD.attendance_session_id OR NEW.started_at IS NOT OLD.started_at
         OR NEW.created_at IS NOT OLD.created_at
       BEGIN SELECT RAISE(ABORT, 'append_only'); END`,
      "CREATE TRIGGER task_time_entries_no_delete BEFORE DELETE ON task_time_entries BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      // Every admin change to projects, tasks and assignments (who, when, what).
      `CREATE TABLE project_audit (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        actor_id   TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        action     TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
        details    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details)),
        created_at TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      "CREATE INDEX project_audit_project ON project_audit(project_id, created_at)",
      "CREATE TRIGGER project_audit_no_update BEFORE UPDATE ON project_audit BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER project_audit_no_delete BEFORE DELETE ON project_audit BEGIN SELECT RAISE(ABORT, 'append_only'); END",
    ],
  },
  {
    id: "0012_email_reports",
    statements: [
      // Report definitions (admin-managed). Never deleted: deactivate instead.
      `CREATE TABLE report_schedules (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
        frequency        TEXT NOT NULL CHECK (frequency IN ('DAILY', 'WEEKLY', 'MONTHLY')),
        timezone         TEXT NOT NULL,
        employee_id      TEXT REFERENCES employee_profiles(id) ON DELETE RESTRICT,  -- NULL: all current employees
        include_projects INTEGER NOT NULL DEFAULT 1 CHECK (include_projects IN (0, 1)),
        active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_by       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at       TEXT NOT NULL DEFAULT ${NOW},
        updated_at       TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      "CREATE TRIGGER report_schedules_no_delete BEFORE DELETE ON report_schedules BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      // Recipients are user accounts (never free-form addresses); removal ends the row.
      `CREATE TABLE report_recipients (
        id          TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES report_schedules(id) ON DELETE RESTRICT,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        added_by    TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        added_at    TEXT NOT NULL DEFAULT ${NOW},
        removed_by  TEXT REFERENCES users(id) ON DELETE RESTRICT,
        removed_at  TEXT,
        CHECK ((removed_by IS NULL) = (removed_at IS NULL))
      ) STRICT`,
      "CREATE UNIQUE INDEX report_recipients_current ON report_recipients(schedule_id, user_id) WHERE removed_at IS NULL",
      "CREATE TRIGGER report_recipients_no_delete BEFORE DELETE ON report_recipients BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      // One run per schedule and period: a second scheduler tick or "run now" cannot duplicate it.
      `CREATE TABLE report_runs (
        id           TEXT PRIMARY KEY,
        schedule_id  TEXT NOT NULL REFERENCES report_schedules(id) ON DELETE RESTRICT,
        period_from  TEXT NOT NULL CHECK (date(period_from) IS period_from),
        period_to    TEXT NOT NULL CHECK (date(period_to) IS period_to AND period_to >= period_from),
        triggered_by TEXT REFERENCES users(id) ON DELETE RESTRICT,  -- NULL: the scheduler
        created_at   TEXT NOT NULL DEFAULT ${NOW},
        UNIQUE (schedule_id, period_from)
      ) STRICT`,
      "CREATE TRIGGER report_runs_no_update BEFORE UPDATE ON report_runs BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER report_runs_no_delete BEFORE DELETE ON report_runs BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      // One delivery per run and recipient: never two emails for the same report. No report content is stored.
      `CREATE TABLE report_deliveries (
        id              TEXT PRIMARY KEY,
        run_id          TEXT NOT NULL REFERENCES report_runs(id) ON DELETE RESTRICT,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        email           TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'SENDING', 'RETRYING', 'SENT', 'MOCKED', 'NOT_CONFIGURED', 'SKIPPED', 'FAILED')),
        provider        TEXT,
        attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
        next_attempt_at TEXT,
        claimed_until   TEXT,
        last_error      TEXT CHECK (last_error IS NULL OR length(last_error) <= 300),
        message_id      TEXT,
        finished_at     TEXT,
        created_at      TEXT NOT NULL DEFAULT ${NOW},
        updated_at      TEXT NOT NULL DEFAULT ${NOW},
        UNIQUE (run_id, user_id),
        CHECK ((status IN ('SENT', 'MOCKED', 'NOT_CONFIGURED', 'SKIPPED', 'FAILED')) = (finished_at IS NOT NULL))
      ) STRICT`,
      "CREATE INDEX report_deliveries_due ON report_deliveries(status, next_attempt_at)",
      // A finished delivery never changes again (no second send of the same report).
      `CREATE TRIGGER report_deliveries_final BEFORE UPDATE ON report_deliveries
       WHEN OLD.finished_at IS NOT NULL OR NEW.run_id IS NOT OLD.run_id OR NEW.user_id IS NOT OLD.user_id OR NEW.email IS NOT OLD.email
       BEGIN SELECT RAISE(ABORT, 'append_only'); END`,
      "CREATE TRIGGER report_deliveries_no_delete BEFORE DELETE ON report_deliveries BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      // Every attempt: outcome and a short error (never the report content; only its SHA-256).
      `CREATE TABLE report_delivery_attempts (
        id             TEXT PRIMARY KEY,
        delivery_id    TEXT NOT NULL REFERENCES report_deliveries(id) ON DELETE RESTRICT,
        attempt        INTEGER NOT NULL CHECK (attempt >= 1),
        outcome        TEXT NOT NULL CHECK (outcome IN ('SENT', 'MOCKED', 'NOT_CONFIGURED', 'SKIPPED', 'TRANSIENT_ERROR', 'PERMANENT_ERROR', 'INTERRUPTED')),
        error          TEXT CHECK (error IS NULL OR length(error) <= 300),
        content_sha256 TEXT,
        created_at     TEXT NOT NULL DEFAULT ${NOW},
        UNIQUE (delivery_id, attempt)
      ) STRICT`,
      "CREATE TRIGGER report_delivery_attempts_no_update BEFORE UPDATE ON report_delivery_attempts BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER report_delivery_attempts_no_delete BEFORE DELETE ON report_delivery_attempts BEGIN SELECT RAISE(ABORT, 'append_only'); END",
    ],
  },
  {
    id: "0013_website_usage",
    statements: [
      // Separate DRAFT notice for website tracking (not approved by HR/Legal); acknowledged per employee
      // in monitoring_consents like the activity and screenshot notices.
      `INSERT INTO monitoring_notices (version, title, points, draft) VALUES ('2026-10-websites-draft-1', 'Website tracking (domain names only)', json('${JSON.stringify(["Only if your organization turns website tracking on and you connect the Insight Workfolio browser extension yourself: while you are clocked in and not on a break, it records the domain name of the website in the browser tab in front (for example docs.example.com) and for how long.", "It never records page addresses after the domain, search terms, page titles, page content, form entries, passwords, keystrokes, browser history, bookmarks or cookies.", "It does not run in private or incognito windows, and nothing is recorded while the browser is not in front, while you are idle, on a break or clocked out.", "This replaces the statement in the activity notice that websites are not recorded, for as long as website tracking is on and the extension is connected. You can disconnect the extension at any time in the desktop app or the extension.", "Your administrators can see the domains and times; they may group domains into categories they define. You can see your own records in the desktop app. Records are deleted after the retention period set by your organization."]).replace(/'/g, "''")}'), 1)`,
      // Organization policy, append-only (latest seq in effect). No rows = off.
      `CREATE TABLE website_policies (
        seq            INTEGER PRIMARY KEY,
        enabled        INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 1 AND 365),
        notice_version TEXT NOT NULL REFERENCES monitoring_notices(version) ON DELETE RESTRICT,
        reason         TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 500),
        changed_by     TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        effective_at   TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      "CREATE TRIGGER website_policies_no_update BEFORE UPDATE ON website_policies BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER website_policies_no_delete BEFORE DELETE ON website_policies BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      // A browser extension the employee connected with a one-time pairing code. Only hashes are stored.
      `CREATE TABLE website_extension_links (
        id                 TEXT PRIMARY KEY,
        employee_id        TEXT NOT NULL REFERENCES employee_profiles(id) ON DELETE RESTRICT,
        label              TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 60),
        pairing_code_hash  TEXT NOT NULL UNIQUE,
        pairing_expires_at TEXT NOT NULL,
        token_hash         TEXT UNIQUE,
        claimed_at         TEXT,
        last_used_at       TEXT,
        revoked_at         TEXT,
        revoked_by         TEXT REFERENCES users(id) ON DELETE RESTRICT,
        created_at         TEXT NOT NULL DEFAULT ${NOW},
        CHECK ((token_hash IS NULL) = (claimed_at IS NULL)),
        CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
      ) STRICT`,
      "CREATE INDEX website_extension_links_employee ON website_extension_links(employee_id)",
      "CREATE TRIGGER website_extension_links_no_delete BEFORE DELETE ON website_extension_links BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      // Domain-only intervals (server-corrected times). Deleted only by retention.
      `CREATE TABLE website_intervals (
        id                    TEXT PRIMARY KEY,
        employee_id           TEXT NOT NULL REFERENCES employee_profiles(id) ON DELETE RESTRICT,
        link_id               TEXT NOT NULL REFERENCES website_extension_links(id) ON DELETE RESTRICT,
        attendance_session_id TEXT NOT NULL REFERENCES attendance_sessions(id) ON DELETE RESTRICT,
        policy_seq            INTEGER NOT NULL REFERENCES website_policies(seq) ON DELETE RESTRICT,
        client_id             TEXT NOT NULL,
        domain                TEXT NOT NULL CHECK (domain = lower(domain) AND length(domain) BETWEEN 3 AND 253
                                AND instr(domain, '.') > 0 AND domain NOT GLOB '*[/?#:@ %\\]*'),
        started_at            TEXT NOT NULL,
        ended_at              TEXT NOT NULL,
        duration_ms           INTEGER NOT NULL CHECK (duration_ms BETWEEN 1000 AND 900000),
        received_at           TEXT NOT NULL,
        UNIQUE (employee_id, client_id),
        CHECK (ended_at > started_at)
      ) STRICT`,
      "CREATE INDEX website_intervals_employee_started ON website_intervals(employee_id, started_at)",
      "CREATE INDEX website_intervals_domain_started ON website_intervals(domain, started_at)",
      "CREATE INDEX website_intervals_started ON website_intervals(started_at)",
      `CREATE TRIGGER website_intervals_no_overlap BEFORE INSERT ON website_intervals
       WHEN EXISTS (SELECT 1 FROM website_intervals WHERE employee_id = NEW.employee_id AND started_at < NEW.ended_at AND ended_at > NEW.started_at)
       BEGIN SELECT RAISE(ABORT, 'website_overlap'); END`,
      "CREATE TRIGGER website_intervals_no_update BEFORE UPDATE ON website_intervals BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      // Admin category rules; removal ends a rule (kept). One current rule per domain and match.
      `CREATE TABLE website_category_rules (
        id         TEXT PRIMARY KEY,
        domain     TEXT NOT NULL CHECK (domain = lower(domain) AND length(domain) BETWEEN 3 AND 253),
        match      TEXT NOT NULL CHECK (match IN ('EXACT', 'SUBDOMAINS')),
        category   TEXT NOT NULL CHECK (category IN ('PRODUCTIVE', 'NEUTRAL', 'UNPRODUCTIVE')),
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL DEFAULT ${NOW},
        updated_at TEXT NOT NULL DEFAULT ${NOW},
        removed_at TEXT,
        removed_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
        CHECK ((removed_at IS NULL) = (removed_by IS NULL))
      ) STRICT`,
      "CREATE UNIQUE INDEX website_category_rules_current ON website_category_rules(domain, match) WHERE removed_at IS NULL",
      "CREATE TRIGGER website_category_rules_no_delete BEFORE DELETE ON website_category_rules BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      // Admin changes to rules, extension links and retention runs (policy changes are in website_policies).
      `CREATE TABLE website_audit (
        id         TEXT PRIMARY KEY,
        actor_id   TEXT REFERENCES users(id) ON DELETE RESTRICT,  -- NULL: the retention scheduler
        action     TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
        details    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details)),
        created_at TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      "CREATE TRIGGER website_audit_no_update BEFORE UPDATE ON website_audit BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER website_audit_no_delete BEFORE DELETE ON website_audit BEGIN SELECT RAISE(ABORT, 'append_only'); END",
    ],
  },
  {
    id: "0014_platform_roles",
    statements: [
      // Identity of administrators: Super Admin (CEO) or Admin (IT). Same permissions (role = 'ADMIN').
      // NULL for employees, and for admins created before this migration until set below.
      "ALTER TABLE users ADD COLUMN admin_title TEXT CHECK (admin_title IS NULL OR admin_title IN ('SUPER_ADMIN', 'ADMIN'))",
      "UPDATE users SET admin_title = 'ADMIN' WHERE role = 'ADMIN'",
      // Every identity change: who, whom, from, to, why. Append-only.
      `CREATE TABLE role_changes (
        id             TEXT PRIMARY KEY,
        target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        actor_id       TEXT REFERENCES users(id) ON DELETE RESTRICT,  -- NULL: the server-side bootstrap tool
        from_role      TEXT NOT NULL CHECK (from_role IN ('SUPER_ADMIN', 'ADMIN', 'EMPLOYEE')),
        to_role        TEXT NOT NULL CHECK (to_role IN ('SUPER_ADMIN', 'ADMIN', 'EMPLOYEE')),
        reason         TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 500),
        created_at     TEXT NOT NULL DEFAULT ${NOW},
        CHECK (from_role <> to_role),
        CHECK (actor_id IS NULL OR actor_id <> target_user_id)
      ) STRICT`,
      "CREATE INDEX role_changes_target ON role_changes(target_user_id, created_at)",
      "CREATE TRIGGER role_changes_no_update BEFORE UPDATE ON role_changes BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER role_changes_no_delete BEFORE DELETE ON role_changes BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      // Website category rules may also say UNCLASSIFIED explicitly (new rules start there). SQLite
      // cannot alter a CHECK, so this table from 0013 (no references to it) is rebuilt with its rows.
      `CREATE TABLE website_category_rules_v2 (
        id         TEXT PRIMARY KEY,
        domain     TEXT NOT NULL CHECK (domain = lower(domain) AND length(domain) BETWEEN 3 AND 253),
        match      TEXT NOT NULL CHECK (match IN ('EXACT', 'SUBDOMAINS')),
        category   TEXT NOT NULL CHECK (category IN ('UNCLASSIFIED', 'PRODUCTIVE', 'NEUTRAL', 'UNPRODUCTIVE')),
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL DEFAULT ${NOW},
        updated_at TEXT NOT NULL DEFAULT ${NOW},
        removed_at TEXT,
        removed_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
        CHECK ((removed_at IS NULL) = (removed_by IS NULL))
      ) STRICT`,
      "INSERT INTO website_category_rules_v2 SELECT id, domain, match, category, created_by, created_at, updated_at, removed_at, removed_by FROM website_category_rules",
      "DROP TRIGGER website_category_rules_no_delete",
      "DROP TABLE website_category_rules",
      "ALTER TABLE website_category_rules_v2 RENAME TO website_category_rules",
      "CREATE UNIQUE INDEX website_category_rules_current ON website_category_rules(domain, match) WHERE removed_at IS NULL",
      "CREATE TRIGGER website_category_rules_no_delete BEFORE DELETE ON website_category_rules BEGIN SELECT RAISE(ABORT, 'append_only'); END",
    ],
  },
  {
    id: "0015_account_audit",
    statements: [
      // Central account and security audit (P1): account lifecycle, sessions, devices. Append-only.
      // Plain ids, no foreign keys: the history must outlive any change to the rows it describes.
      // Never holds passwords, tokens, hashes or personal content (the API rejects such metadata keys).
      `CREATE TABLE account_audit (
        id             TEXT PRIMARY KEY,
        actor_user_id  TEXT,  -- NULL: the server itself (bootstrap tool, automatic revocation)
        target_user_id TEXT,
        action         TEXT NOT NULL CHECK (length(action) BETWEEN 3 AND 64),
        resource_type  TEXT NOT NULL CHECK (resource_type IN ('ACCOUNT', 'SESSION', 'DEVICE', 'SETUP_LINK')),
        resource_id    TEXT,
        reason         TEXT CHECK (reason IS NULL OR length(reason) <= 500),
        metadata       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata) AND length(metadata) <= 2000),
        created_at     TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      "CREATE INDEX account_audit_created ON account_audit(created_at, id)",
      "CREATE INDEX account_audit_actor ON account_audit(actor_user_id, created_at)",
      "CREATE INDEX account_audit_target ON account_audit(target_user_id, created_at)",
      "CREATE TRIGGER account_audit_no_update BEFORE UPDATE ON account_audit BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER account_audit_no_delete BEFORE DELETE ON account_audit BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      // Session listing: which client signed in and when the session was last renewed. NULL on rows
      // created before this migration (shown as unknown, never guessed).
      "ALTER TABLE sessions ADD COLUMN client TEXT CHECK (client IS NULL OR client IN ('WEB', 'DESKTOP'))",
      "ALTER TABLE sessions ADD COLUMN refreshed_at TEXT",
      "CREATE INDEX sessions_user_live ON sessions(user_id, revoked_at, expires_at)",
      // The unified audit view filters every source by time; the access logs are the largest sources.
      "CREATE INDEX screenshot_access_log_time ON screenshot_access_log(accessed_at)",
      "CREATE INDEX timelapse_access_log_time ON timelapse_access_log(accessed_at)",
    ],
  },
  {
    id: "0016_data_layer_integrity",
    statements: [
      // Indexes for filters the services run (shared data layer audit, 2026-10-30).
      "CREATE INDEX screenshots_session ON screenshots(attendance_session_id, upload_status)",
      "CREATE INDEX screenshots_captured ON screenshots(captured_at)",
      "CREATE INDEX task_time_entries_started ON task_time_entries(started_at)",
      "CREATE INDEX activity_intervals_employee_received ON activity_intervals(employee_id, received_at)",
      "CREATE INDEX attendance_corrections_request ON attendance_corrections(request_id)",
      "CREATE INDEX timelapses_session ON timelapses(attendance_session_id, created_at)",
      "CREATE INDEX role_changes_created ON role_changes(created_at)",
      "CREATE INDEX website_audit_created ON website_audit(created_at)",
      "CREATE INDEX project_audit_created ON project_audit(created_at)",
      // Core records are never deleted by the application (accounts are disabled, devices revoked,
      // projects archived, shifts corrected): refuse deletes outright instead of relying on foreign keys,
      // which only protect rows that something still references.
      "CREATE TRIGGER users_no_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER employee_profiles_no_delete BEFORE DELETE ON employee_profiles BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER devices_no_delete BEFORE DELETE ON devices BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER attendance_sessions_no_delete BEFORE DELETE ON attendance_sessions BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER break_sessions_no_delete BEFORE DELETE ON break_sessions BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER projects_no_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER project_tasks_no_delete BEFORE DELETE ON project_tasks BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      // A consent must name a published notice (monitoring_consents predates monitoring_notices, so it
      // has no foreign key; the API already checks this).
      `CREATE TRIGGER monitoring_consents_known_notice BEFORE INSERT ON monitoring_consents
         WHEN NOT EXISTS (SELECT 1 FROM monitoring_notices WHERE version = NEW.notice_version)
         BEGIN SELECT RAISE(ABORT, 'unknown_notice'); END`,
    ],
  },
  {
    id: "0017_work_schedule_and_app_categories",
    statements: [
      // Organisation-wide work schedule (late clock-in / absence). Append-only like monitoring_policies;
      // no rows = disabled (nothing is ever labelled late or absent). Workdays: ISO weekday digits
      // 1 = Monday … 7 = Sunday, each at most once (e.g. '12345').
      `CREATE TABLE work_schedule_policies (
        seq            INTEGER PRIMARY KEY,
        enabled        INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        expected_start TEXT NOT NULL CHECK (expected_start GLOB '[01][0-9]:[0-5][0-9]' OR expected_start GLOB '2[0-3]:[0-5][0-9]'),
        grace_minutes  INTEGER NOT NULL CHECK (grace_minutes BETWEEN 0 AND 240),
        workdays       TEXT NOT NULL CHECK (length(workdays) BETWEEN 1 AND 7 AND workdays NOT GLOB '*[^1-7]*'
                         AND length(workdays) - length(replace(workdays, '1', '')) <= 1
                         AND length(workdays) - length(replace(workdays, '2', '')) <= 1
                         AND length(workdays) - length(replace(workdays, '3', '')) <= 1
                         AND length(workdays) - length(replace(workdays, '4', '')) <= 1
                         AND length(workdays) - length(replace(workdays, '5', '')) <= 1
                         AND length(workdays) - length(replace(workdays, '6', '')) <= 1
                         AND length(workdays) - length(replace(workdays, '7', '')) <= 1),
        reason         TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 500),
        changed_by     TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        effective_at   TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      "CREATE TRIGGER work_schedule_policies_no_update BEFORE UPDATE ON work_schedule_policies BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER work_schedule_policies_no_delete BEFORE DELETE ON work_schedule_policies BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      // The daily attendance view reads every clock-in in a one-day window across employees.
      "CREATE INDEX attendance_sessions_clock_in ON attendance_sessions(clock_in_at)",
      // Admin productivity labels for applications (F05), applied when reports are read. A rule is
      // removed by ending it (kept); only its category may change while it is current. One current rule
      // per kind and value (case-insensitive).
      `CREATE TABLE application_category_rules (
        id         TEXT PRIMARY KEY,
        match_kind TEXT NOT NULL CHECK (match_kind IN ('IDENTIFIER', 'NAME')),
        value      TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 255 AND value = trim(value)),
        category   TEXT NOT NULL CHECK (category IN ('PRODUCTIVE', 'NEUTRAL', 'UNPRODUCTIVE')),
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL DEFAULT ${NOW},
        updated_at TEXT NOT NULL DEFAULT ${NOW},
        ended_at   TEXT,
        ended_by   TEXT REFERENCES users(id) ON DELETE RESTRICT,
        CHECK ((ended_at IS NULL) = (ended_by IS NULL))
      ) STRICT`,
      "CREATE UNIQUE INDEX application_category_rules_current ON application_category_rules(match_kind, lower(value)) WHERE ended_at IS NULL",
      `CREATE TRIGGER application_category_rules_immutable BEFORE UPDATE ON application_category_rules
       WHEN OLD.ended_at IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.match_kind IS NOT OLD.match_kind OR NEW.value IS NOT OLD.value
         OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
       BEGIN SELECT RAISE(ABORT, 'append_only'); END`,
      "CREATE TRIGGER application_category_rules_no_delete BEFORE DELETE ON application_category_rules BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      // Every rule change: who, what, when. Append-only (like website_audit).
      `CREATE TABLE activity_category_audit (
        id         TEXT PRIMARY KEY,
        actor_id   TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        action     TEXT NOT NULL CHECK (action IN ('RULE_ADDED', 'RULE_CHANGED', 'RULE_REMOVED')),
        rule_id    TEXT NOT NULL REFERENCES application_category_rules(id) ON DELETE RESTRICT,
        details    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details) AND length(details) <= 2000),
        created_at TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      "CREATE INDEX activity_category_audit_created ON activity_category_audit(created_at)",
      "CREATE TRIGGER activity_category_audit_no_update BEFORE UPDATE ON activity_category_audit BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER activity_category_audit_no_delete BEFORE DELETE ON activity_category_audit BEGIN SELECT RAISE(ABORT, 'append_only'); END",
    ],
  },
  // 0018 is reserved (another change); migrate() applies a missing lower id whenever it appears.
  {
    id: "0019_screenshot_blur_policy",
    statements: [
      // Whole-image blur applied on the device before encoding (after masks), part of each policy
      // version. Existing versions had none, which is what was captured under them.
      "ALTER TABLE screenshot_policies ADD COLUMN blur INTEGER NOT NULL DEFAULT 0 CHECK (blur IN (0, 1))",
      // Whether the agent blurred this image (checked against the effective setting at registration).
      "ALTER TABLE screenshots ADD COLUMN blurred INTEGER NOT NULL DEFAULT 0 CHECK (blurred IN (0, 1))",
      "DROP TRIGGER screenshots_immutable",
      `CREATE TRIGGER screenshots_immutable BEFORE UPDATE OF id, employee_id, device_id, attendance_session_id, idempotency_key,
         captured_at, device_captured_at, width, height, mime_type, file_size_bytes, checksum, storage_provider, storage_key, created_at, mask_count, blurred
       ON screenshots BEGIN SELECT RAISE(ABORT, 'screenshot_immutable'); END`,
      // Per-employee blur override history (append-only). Effective at T: the latest row for the
      // employee with effective_at <= T; blur NULL = cleared (the organisation policy applies).
      `CREATE TABLE screenshot_blur_overrides (
        id           TEXT PRIMARY KEY,
        employee_id  TEXT NOT NULL REFERENCES employee_profiles(id) ON DELETE RESTRICT,
        blur         INTEGER CHECK (blur IS NULL OR blur IN (0, 1)),
        reason       TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 500),
        changed_by   TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        effective_at TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      "CREATE INDEX screenshot_blur_overrides_employee ON screenshot_blur_overrides(employee_id, effective_at)",
      "CREATE INDEX screenshot_blur_overrides_effective ON screenshot_blur_overrides(effective_at)",
      "CREATE TRIGGER screenshot_blur_overrides_no_update BEFORE UPDATE ON screenshot_blur_overrides BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER screenshot_blur_overrides_no_delete BEFORE DELETE ON screenshot_blur_overrides BEGIN SELECT RAISE(ABORT, 'append_only'); END",
    ],
  },
  // 0020 is reserved (another change).
  {
    id: "0021_leave_types",
    statements: [
      // W36/W35: admin-defined leave types. Balances are computed (allowance minus approved usage),
      // never stored. NULL allowance or quota = no limit. Types are deactivated, never deleted.
      `CREATE TABLE leave_types (
        id                    TEXT PRIMARY KEY,
        name                  TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 60),
        paid                  INTEGER NOT NULL CHECK (paid IN (0, 1)),
        yearly_allowance_days REAL CHECK (yearly_allowance_days IS NULL OR yearly_allowance_days BETWEEN 0 AND 366),
        short_hours_per_month REAL CHECK (short_hours_per_month IS NULL OR short_hours_per_month BETWEEN 0 AND 744),
        active                INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_by            TEXT REFERENCES users(id) ON DELETE RESTRICT,
        created_at            TEXT NOT NULL DEFAULT ${NOW},
        updated_at            TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      "CREATE TRIGGER leave_types_no_delete BEFORE DELETE ON leave_types BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      // The default type for every existing request (and any insert that names none): unpaid and
      // unlimited, so nothing recorded before types existed changes meaning or becomes unapprovable.
      "INSERT INTO leave_types (id, name, paid) VALUES ('00000000-0000-4000-8000-000000000001', 'General', 0)",
      "ALTER TABLE leave_requests ADD COLUMN leave_type_id TEXT REFERENCES leave_types(id) ON DELETE RESTRICT",
      "DROP TRIGGER leave_requests_decide_once",
      "UPDATE leave_requests SET leave_type_id = '00000000-0000-4000-8000-000000000001'",
      // As before, plus the type is fixed. The one exception is leave_requests_default_type filling a
      // NULL type right after insert (a NULL never persists, so nothing else can use it).
      `CREATE TRIGGER leave_requests_decide_once BEFORE UPDATE ON leave_requests
       WHEN NOT (OLD.leave_type_id IS NULL AND NEW.leave_type_id = '00000000-0000-4000-8000-000000000001' AND NEW.status IS OLD.status)
        AND (OLD.status <> 'PENDING' OR NEW.employee_id IS NOT OLD.employee_id OR NEW.requested_by IS NOT OLD.requested_by
         OR NEW.start_date IS NOT OLD.start_date OR NEW.end_date IS NOT OLD.end_date OR NEW.portion IS NOT OLD.portion
         OR NEW.start_time IS NOT OLD.start_time OR NEW.end_time IS NOT OLD.end_time
         OR NEW.reason IS NOT OLD.reason OR NEW.created_at IS NOT OLD.created_at
         OR (OLD.leave_type_id IS NOT NULL AND NEW.leave_type_id IS NOT OLD.leave_type_id))
       BEGIN SELECT RAISE(ABORT, 'already_reviewed'); END`,
      `CREATE TRIGGER leave_requests_default_type AFTER INSERT ON leave_requests WHEN NEW.leave_type_id IS NULL
       BEGIN UPDATE leave_requests SET leave_type_id = '00000000-0000-4000-8000-000000000001' WHERE id = NEW.id; END`,
      "CREATE INDEX leave_requests_type ON leave_requests(leave_type_id, employee_id, start_date)",
    ],
  },
  {
    id: "0022_holidays",
    statements: [
      // W38: organisation-wide holidays, one per local date (read in each employee's own zone).
      `CREATE TABLE holidays (
        id         TEXT PRIMARY KEY,
        date       TEXT NOT NULL UNIQUE CHECK (date(date) IS date),
        name       TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
    ],
  },
  {
    id: "0023_session_device",
    statements: [
      // API-08: the device a session was used from (bound on device register/heartbeat), so revoking the
      // device also revokes its sessions. NULL for web sessions and sessions from before this migration.
      "ALTER TABLE sessions ADD COLUMN device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT",
      "CREATE INDEX sessions_device ON sessions(device_id) WHERE device_id IS NOT NULL",
    ],
  },
  {
    id: "0024_teams",
    statements: [
      // W40/W41: teams. An employee may belong to several teams (Workfolio). A team head (users.id) reads
      // only the members of the active teams they head (docs/teams.md). Teams are deactivated, never deleted.
      `CREATE TABLE teams (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 80 AND name = trim(name)),
        head_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
        active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_by   TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at   TEXT NOT NULL DEFAULT ${NOW},
        updated_at   TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      "CREATE INDEX teams_head ON teams(head_user_id) WHERE head_user_id IS NOT NULL",
      "CREATE TRIGGER teams_no_delete BEFORE DELETE ON teams BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER teams_immutable BEFORE UPDATE OF id, created_by, created_at ON teams BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      // Membership rows are added or removed, never changed.
      `CREATE TABLE team_members (
        team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
        employee_id TEXT NOT NULL REFERENCES employee_profiles(id) ON DELETE RESTRICT,
        added_by    TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        added_at    TEXT NOT NULL DEFAULT ${NOW},
        PRIMARY KEY (team_id, employee_id)
      ) STRICT`,
      "CREATE INDEX team_members_employee ON team_members(employee_id)",
      "CREATE TRIGGER team_members_no_update BEFORE UPDATE ON team_members BEGIN SELECT RAISE(ABORT, 'append_only'); END",
    ],
  },
  {
    id: "0025_person_overrides",
    statements: [
      // W22: applications (bundle id on macOS, exe file name on Windows, matched case-insensitively by
      // the desktop) whose foreground use never counts as idle, e.g. video calls. Part of each monitoring
      // policy version; existing versions had none.
      `ALTER TABLE monitoring_policies ADD COLUMN idle_excluded_apps TEXT NOT NULL DEFAULT '[]'
         CHECK (json_valid(idle_excluded_apps) AND json_type(idle_excluded_apps) = 'array' AND length(idle_excluded_apps) <= 30000)`,
      // W17/W21: per-employee overrides of the schedule start / workdays and the idle threshold.
      // Append-only history; each row is the employee's full override set from effective_at on.
      // NULL = inherit the organisation value (all NULL = cleared).
      `CREATE TABLE employee_tracking_overrides (
        id                     TEXT PRIMARY KEY,
        employee_id            TEXT NOT NULL REFERENCES employee_profiles(id) ON DELETE RESTRICT,
        expected_start         TEXT CHECK (expected_start IS NULL OR expected_start GLOB '[01][0-9]:[0-5][0-9]' OR expected_start GLOB '2[0-3]:[0-5][0-9]'),
        workdays               TEXT CHECK (workdays IS NULL OR (length(workdays) BETWEEN 1 AND 7 AND workdays NOT GLOB '*[^1-7]*'
                                  AND length(workdays) - length(replace(workdays, '1', '')) <= 1
                                  AND length(workdays) - length(replace(workdays, '2', '')) <= 1
                                  AND length(workdays) - length(replace(workdays, '3', '')) <= 1
                                  AND length(workdays) - length(replace(workdays, '4', '')) <= 1
                                  AND length(workdays) - length(replace(workdays, '5', '')) <= 1
                                  AND length(workdays) - length(replace(workdays, '6', '')) <= 1
                                  AND length(workdays) - length(replace(workdays, '7', '')) <= 1)),
        idle_threshold_seconds INTEGER CHECK (idle_threshold_seconds IS NULL OR idle_threshold_seconds BETWEEN 30 AND 3600),
        reason                 TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 500),
        changed_by             TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        effective_at           TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      "CREATE INDEX employee_tracking_overrides_employee ON employee_tracking_overrides(employee_id, effective_at)",
      "CREATE TRIGGER employee_tracking_overrides_no_update BEFORE UPDATE ON employee_tracking_overrides BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      "CREATE TRIGGER employee_tracking_overrides_no_delete BEFORE DELETE ON employee_tracking_overrides BEGIN SELECT RAISE(ABORT, 'append_only'); END",
    ],
  },
  {
    id: "0026_alert_rules",
    statements: [
      // F06: admin-defined alert rules from a fixed set of kinds (docs/alerts.md). threshold is a
      // percentage (IDLE_SHARE_ABOVE) or minutes (NO_ACTIVITY_FOR); at_time a local HH:MM (NOT_CLOCKED_IN_BY).
      `CREATE TABLE alert_rules (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
        kind       TEXT NOT NULL CHECK (kind IN ('LATE_CLOCK_IN', 'NOT_CLOCKED_IN_BY', 'IDLE_SHARE_ABOVE', 'NO_ACTIVITY_FOR')),
        threshold  INTEGER,
        at_time    TEXT CHECK (at_time IS NULL OR at_time GLOB '[01][0-9]:[0-5][0-9]' OR at_time GLOB '2[0-3]:[0-5][0-9]'),
        active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL DEFAULT ${NOW},
        updated_at TEXT NOT NULL DEFAULT ${NOW},
        CHECK ((kind = 'NOT_CLOCKED_IN_BY') = (at_time IS NOT NULL)),
        CHECK ((kind IN ('IDLE_SHARE_ABOVE', 'NO_ACTIVITY_FOR')) = (threshold IS NOT NULL)),
        CHECK (kind <> 'IDLE_SHARE_ABOVE' OR threshold BETWEEN 1 AND 99),
        CHECK (kind <> 'NO_ACTIVITY_FOR' OR threshold BETWEEN 5 AND 720)
      ) STRICT`,
      // At most one alert per rule, employee and local date (the evaluator inserts with ON CONFLICT DO NOTHING).
      `CREATE TABLE alerts (
        id              TEXT PRIMARY KEY,
        rule_id         TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE RESTRICT,
        employee_id     TEXT NOT NULL REFERENCES employee_profiles(id) ON DELETE RESTRICT,
        date            TEXT NOT NULL CHECK (date(date) IS date),
        detail          TEXT NOT NULL CHECK (length(detail) BETWEEN 1 AND 300),
        created_at      TEXT NOT NULL DEFAULT ${NOW},
        acknowledged_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
        acknowledged_at TEXT,
        CHECK ((acknowledged_by IS NULL) = (acknowledged_at IS NULL)),
        UNIQUE (rule_id, employee_id, date)
      ) STRICT`,
      "CREATE INDEX alerts_created ON alerts(created_at)",
      // Acknowledged once; nothing else about an alert changes.
      `CREATE TRIGGER alerts_acknowledge_once BEFORE UPDATE ON alerts
       WHEN OLD.acknowledged_at IS NOT NULL OR NEW.rule_id IS NOT OLD.rule_id OR NEW.employee_id IS NOT OLD.employee_id
         OR NEW.date IS NOT OLD.date OR NEW.detail IS NOT OLD.detail OR NEW.created_at IS NOT OLD.created_at
       BEGIN SELECT RAISE(ABORT, 'already_reviewed'); END`,
    ],
  },
  {
    id: "0027_team_labels_self_view",
    statements: [
      // F05 per team: a team's own label for an application, overriding the organisation rule for the
      // members of that (active) team (docs/teams.md). Never edited: a change ends the current row and
      // adds a new one, so the rows are the history (who, when). One current row per team, kind and value.
      `CREATE TABLE team_application_category_rules (
        id         TEXT PRIMARY KEY,
        team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
        match_kind TEXT NOT NULL CHECK (match_kind IN ('IDENTIFIER', 'NAME')),
        value      TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 255 AND value = trim(value)),
        category   TEXT NOT NULL CHECK (category IN ('PRODUCTIVE', 'NEUTRAL', 'UNPRODUCTIVE')),
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL DEFAULT ${NOW},
        ended_at   TEXT,
        ended_by   TEXT REFERENCES users(id) ON DELETE RESTRICT,
        CHECK ((ended_at IS NULL) = (ended_by IS NULL))
      ) STRICT`,
      "CREATE UNIQUE INDEX team_application_category_rules_current ON team_application_category_rules(team_id, match_kind, lower(value)) WHERE ended_at IS NULL",
      // Only ending a current row is allowed.
      `CREATE TRIGGER team_application_category_rules_immutable BEFORE UPDATE ON team_application_category_rules
       WHEN OLD.ended_at IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.team_id IS NOT OLD.team_id OR NEW.match_kind IS NOT OLD.match_kind
         OR NEW.value IS NOT OLD.value OR NEW.category IS NOT OLD.category OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
       BEGIN SELECT RAISE(ABORT, 'append_only'); END`,
      "CREATE TRIGGER team_application_category_rules_no_delete BEFORE DELETE ON team_application_category_rules BEGIN SELECT RAISE(ABORT, 'append_only'); END",
      // F08: per-employee override of the organisation's screenshot self-view switch, part of each
      // tracking-override version. NULL = inherit (every existing version), 1 = allow, 0 = deny.
      "ALTER TABLE employee_tracking_overrides ADD COLUMN screenshot_self_view INTEGER CHECK (screenshot_self_view IS NULL OR screenshot_self_view IN (0, 1))",
    ],
  },
  {
    id: "0028_auto_timelapse",
    statements: [
      // F01: part of each screenshot policy version (who, when, why). Off for every existing version.
      "ALTER TABLE screenshot_policies ADD COLUMN auto_timelapse INTEGER NOT NULL DEFAULT 0 CHECK (auto_timelapse IN (0, 1))",
      // Jobs queued by that setting rather than by an admin's click; every existing job was manual.
      "ALTER TABLE timelapses ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0 CHECK (automatic IN (0, 1))",
    ],
  },
  {
    id: "0029_device_live_state",
    statements: [
      // What the desktop last reported about "now" (POST /activity/sync `current`): the open interval is
      // not uploaded, so this is the only source for "idle right now". Overwritten in place (a live
      // value, not history); *_at is the server's receive time, used for staleness. All NULL = no report.
      "ALTER TABLE devices ADD COLUMN activity_state TEXT CHECK (activity_state IS NULL OR activity_state IN ('ACTIVE', 'IDLE', 'UNOBSERVED'))",
      "ALTER TABLE devices ADD COLUMN activity_state_since TEXT",
      "ALTER TABLE devices ADD COLUMN activity_state_at TEXT",
      "ALTER TABLE devices ADD COLUMN screenshot_state TEXT CHECK (screenshot_state IS NULL OR screenshot_state IN ('OK', 'PERMISSION_DENIED', 'CAPTURE_FAILED'))",
      "ALTER TABLE devices ADD COLUMN screenshot_state_at TEXT",
      // Why a person deleted a screenshot (required by the API); NULL for retention and earlier deletes.
      "ALTER TABLE screenshots ADD COLUMN deleted_reason TEXT CHECK (deleted_reason IS NULL OR length(deleted_reason) <= 500)",
    ],
  },
  {
    id: "0030_account_invitations",
    statements: [
      // One row per invitation email (docs/invitations.md). The link itself is never stored: only its
      // setup token's id (the token table keeps the sha256). ACCEPTED/EXPIRED are derived from the token
      // and the account, not stored. last_error is a short provider message, never the email body.
      `CREATE TABLE account_invitations (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        setup_token_id TEXT NOT NULL UNIQUE REFERENCES account_setup_tokens(id) ON DELETE RESTRICT,
        recipient      TEXT NOT NULL,
        provider       TEXT NOT NULL CHECK (provider IN ('mock', 'graph')),
        status         TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
        attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        sent_at        TEXT,
        last_error     TEXT CHECK (last_error IS NULL OR length(last_error) <= 300),
        created_by     TEXT REFERENCES users(id) ON DELETE RESTRICT,
        created_at     TEXT NOT NULL DEFAULT ${NOW},
        updated_at     TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT`,
      "CREATE INDEX account_invitations_user ON account_invitations(user_id, created_at)",
    ],
  },
];

const checksum = (m: Migration) => createHash("sha256").update(JSON.stringify(m.statements)).digest("hex");

/**
 * Applies pending migrations, each atomically together with its bookkeeping row (id + checksum of its
 * statements). Safe to run repeatedly and concurrently. Refuses to start (throws) when:
 * - the code's migration ids are not unique and ascending (a migration inserted out of order);
 * - the database lists a migration this build does not know (it was migrated by a newer build);
 * - an applied migration's statements were edited afterwards (checksum mismatch). Rows applied before
 *   checksums existed are stamped with the current checksum on first sight.
 * Returns the ids applied by this call.
 */
export async function migrate(db: Client): Promise<string[]> {
  for (let i = 1; i < MIGRATIONS.length; i++) {
    if (!(MIGRATIONS[i - 1]!.id < MIGRATIONS[i]!.id)) throw new Error(`Migration ids must be unique and ascending: ${MIGRATIONS[i]!.id}`);
  }
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT ${NOW}, checksum TEXT) STRICT`,
  );
  const columns = (await db.execute("SELECT name FROM pragma_table_info('schema_migrations')")).rows.map((r) => String(r.name));
  if (!columns.includes("checksum")) {
    await db.execute("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT").catch((err: unknown) => {
      if (!/duplicate column/i.test(String((err as Error).message))) throw err; // a concurrent runner added it
    });
  }
  const applied = new Map((await db.execute("SELECT id, checksum FROM schema_migrations")).rows.map((r) => [String(r.id), r.checksum === null ? null : String(r.checksum)]));
  const known = new Map(MIGRATIONS.map((m) => [m.id, m]));
  const unknown = [...applied.keys()].filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Database has migrations this build does not know (${unknown.join(", ")}); refusing to start`);
  for (const [id, sum] of applied) {
    const expected = checksum(known.get(id)!);
    if (sum === null) await db.execute({ sql: "UPDATE schema_migrations SET checksum = ? WHERE id = ? AND checksum IS NULL", args: [expected, id] });
    else if (sum !== expected) throw new Error(`Migration ${id} was changed after it was applied (checksum mismatch); add a new migration instead`);
  }
  const ran: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    try {
      await db.batch([...m.statements, { sql: "INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)", args: [m.id, checksum(m)] }], "write");
      ran.push(m.id);
    } catch (err) {
      // A concurrent runner may have applied it first (our batch rolled back): continue if so.
      const row = (await db.execute({ sql: "SELECT checksum FROM schema_migrations WHERE id = ?", args: [m.id] })).rows[0];
      if (row && row.checksum === checksum(m)) continue;
      throw new Error(`Migration ${m.id} failed: ${(err as Error).message}`, { cause: err });
    }
  }
  return ran;
}

export interface MigrationStatus {
  /** Ids recorded in schema_migrations that this build knows, ascending. */
  applied: string[];
  /** Ids in this build not yet applied, ascending (may include a lower id below an applied one: gap-fill). */
  pending: string[];
  /** Ids recorded in the database that this build does not know (migrated by a newer build). */
  unknown: string[];
  /** Applied ids whose recorded checksum differs from this build's statements. */
  edited: string[];
}

/**
 * READ-ONLY comparison of the database's schema_migrations with this build (SELECTs only; never creates
 * the bookkeeping table or stamps checksums). Hosted API startup uses it instead of migrate().
 */
export async function migrationStatus(db: Client): Promise<MigrationStatus> {
  const table = await db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'");
  // SELECT *: a table from before checksums existed has no checksum column (read as NULL below).
  const rows = table.rows.length ? (await db.execute("SELECT * FROM schema_migrations ORDER BY id")).rows : [];
  const known = new Map(MIGRATIONS.map((m) => [m.id, m]));
  const recorded = rows.map((r) => ({ id: String(r.id), sum: r.checksum == null ? null : String(r.checksum) }));
  const done = new Set(recorded.map((r) => r.id));
  return {
    applied: recorded.filter((r) => known.has(r.id)).map((r) => r.id),
    pending: MIGRATIONS.filter((m) => !done.has(m.id)).map((m) => m.id),
    unknown: recorded.filter((r) => !known.has(r.id)).map((r) => r.id),
    // A NULL checksum predates checksums; migrate() stamps it, so it is not an edit.
    edited: recorded.filter((r) => known.has(r.id) && r.sum !== null && r.sum !== checksum(known.get(r.id)!)).map((r) => r.id),
  };
}

/** The latest migration applied to this database (for startup diagnostics), or null. */
export async function schemaVersion(db: Client): Promise<string | null> {
  const row = (await db.execute("SELECT max(id) AS id FROM schema_migrations")).rows[0];
  return row?.id == null ? null : String(row.id);
}
