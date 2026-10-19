//! Durable offline queue for attendance events (SQLite in the app data directory).
//! Holds attendance events and non-secret cached state only; tokens never go here.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueuedEvent {
    /// Client-generated UUID; the server uses it as the idempotency key.
    pub id: String,
    pub user_id: String,
    pub device_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub occurred_at: String,
    /// PENDING until the server accepts it (row deleted) or rejects it (kept for the employee to see).
    #[serde(default = "pending")]
    pub status: String,
    #[serde(default)]
    pub reason: Option<String>,
}

fn pending() -> String {
    "PENDING".into()
}

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    // Fails fast on a damaged file ("file is not a database", corrupt pages).
    let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if check != "ok" {
        return Err(rusqlite::Error::InvalidQuery);
    }
    // WAL + FULL sync: a committed enqueue survives a crash or power loss.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS events (
           seq         INTEGER PRIMARY KEY AUTOINCREMENT, -- FIFO order
           id          TEXT NOT NULL UNIQUE,
           user_id     TEXT NOT NULL,
           device_id   TEXT NOT NULL,
           type        TEXT NOT NULL CHECK (type IN ('CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT')),
           occurred_at TEXT NOT NULL,
           status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'REJECTED')),
           reason      TEXT
         ) STRICT;
         CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
         -- Activity intervals awaiting upload. OPEN = still being extended (checkpointed every
         -- sample so a crash loses at most one sample period); PENDING = closed, to upload.
         CREATE TABLE IF NOT EXISTS activity (
           seq       INTEGER PRIMARY KEY AUTOINCREMENT,
           id        TEXT NOT NULL UNIQUE,
           user_id   TEXT NOT NULL,
           device_id TEXT NOT NULL,
           kind      TEXT NOT NULL CHECK (kind IN ('ACTIVE', 'IDLE')),
           app_id    TEXT,
           app_name  TEXT,
           start_ms  INTEGER NOT NULL,
           end_ms    INTEGER NOT NULL,
           status    TEXT NOT NULL CHECK (status IN ('OPEN', 'PENDING', 'REJECTED')),
           reason    TEXT,
           CHECK (end_ms >= start_ms)
         ) STRICT;
         CREATE INDEX IF NOT EXISTS activity_scope ON activity(user_id, device_id, status, start_ms);
         -- Screenshot metadata (the WebP files live next to this database in screenshots/; see
         -- screenshot.rs). SAVING = file being written; PENDING = to register; REGISTERED = metadata
         -- accepted, bytes to upload; STORED = cloud storage confirmed (file removed after a grace
         -- period); FAILED/REJECTED = kept for the employee until dismissed.
         CREATE TABLE IF NOT EXISTS screenshots (
           seq             INTEGER PRIMARY KEY AUTOINCREMENT,
           id              TEXT NOT NULL UNIQUE,
           user_id         TEXT NOT NULL,
           device_id       TEXT NOT NULL,
           session_id      TEXT NOT NULL,
           captured_ms     INTEGER NOT NULL,
           width           INTEGER NOT NULL,
           height          INTEGER NOT NULL,
           size_bytes      INTEGER NOT NULL CHECK (size_bytes > 0),
           checksum        TEXT NOT NULL,
           status          TEXT NOT NULL CHECK (status IN ('SAVING', 'PENDING', 'REGISTERED', 'STORED', 'FAILED', 'REJECTED')),
           retries         INTEGER NOT NULL DEFAULT 0,
           next_attempt_ms INTEGER NOT NULL DEFAULT 0,
           last_error      TEXT,
           stored_ms       INTEGER
         ) STRICT;
         CREATE INDEX IF NOT EXISTS screenshots_scope ON screenshots(user_id, device_id, status, captured_ms);",
    )?;
    Ok(conn)
}

/// Opens the queue. A damaged file is never deleted: it is moved aside (with its WAL) as
/// `<name>.damaged-<unix-seconds>` for support to inspect, and a fresh queue is created.
/// Returns the moved-aside path when that happened so the UI can say so.
pub fn open_or_recover(path: &Path) -> rusqlite::Result<(Connection, Option<PathBuf>)> {
    match open(path) {
        Ok(conn) => Ok((conn, None)),
        Err(_) if path.exists() => {
            let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let aside = path.with_extension(format!("damaged-{secs}"));
            for suffix in ["", "-wal", "-shm"] {
                let from = PathBuf::from(format!("{}{suffix}", path.display()));
                if from.exists() {
                    std::fs::rename(&from, format!("{}{suffix}", aside.display())).map_err(|_| rusqlite::Error::InvalidPath(from))?;
                }
            }
            Ok((open(path)?, Some(aside)))
        }
        Err(e) => Err(e),
    }
}

/// Idempotent: re-adding an existing event id is a no-op.
pub fn add(conn: &Connection, e: &QueuedEvent) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO events (id, user_id, device_id, type, occurred_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![e.id, e.user_id, e.device_id, e.kind, e.occurred_at],
    )?;
    Ok(())
}

/// Pending and rejected events of one employee on one registered device, oldest first.
pub fn list(conn: &Connection, user_id: &str, device_id: &str) -> rusqlite::Result<Vec<QueuedEvent>> {
    let mut stmt = conn.prepare(
        "SELECT id, user_id, device_id, type, occurred_at, status, reason FROM events
         WHERE user_id = ?1 AND device_id = ?2 ORDER BY seq",
    )?;
    stmt.query_map(params![user_id, device_id], |r| {
        Ok(QueuedEvent {
            id: r.get(0)?,
            user_id: r.get(1)?,
            device_id: r.get(2)?,
            kind: r.get(3)?,
            occurred_at: r.get(4)?,
            status: r.get(5)?,
            reason: r.get(6)?,
        })
    })?
    .collect()
}

/// Server accepted (or already had) these events: drop them.
pub fn ack(conn: &mut Connection, ids: &[String]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for id in ids {
        tx.execute("DELETE FROM events WHERE id = ?1", params![id])?;
    }
    tx.commit()
}

pub fn reject(conn: &Connection, id: &str, reason: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE events SET status = 'REJECTED', reason = ?2 WHERE id = ?1", params![id, reason])?;
    Ok(())
}

/// The employee has seen the rejected events; remove them.
pub fn dismiss_rejected(conn: &Connection, user_id: &str, device_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM events WHERE status = 'REJECTED' AND user_id = ?1 AND device_id = ?2",
        params![user_id, device_id],
    )?;
    Ok(())
}

pub fn kv_get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| r.get(0)).optional()
}

pub fn kv_set(conn: &Connection, key: &str, value: Option<&str>) -> rusqlite::Result<()> {
    match value {
        Some(v) => conn.execute(
            "INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, v],
        )?,
        None => conn.execute("DELETE FROM kv WHERE key = ?1", params![key])?,
    };
    Ok(())
}

// ---- Activity intervals ------------------------------------------------------------

/// Unsynced intervals kept locally beyond this pause collection instead of dropping data.
pub const MAX_PENDING_ACTIVITY: i64 = 50_000;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRow {
    pub id: String,
    pub kind: String,
    pub app_id: Option<String>,
    pub app_name: Option<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub status: String,
    pub reason: Option<String>,
}

/// Inserts or updates (while still OPEN) an interval for the employee + device scope.
pub fn activity_save(conn: &Connection, user_id: &str, device_id: &str, i: &crate::activity::Interval, status: &str) -> rusqlite::Result<()> {
    let kind = match i.kind {
        crate::activity::Kind::Active => "ACTIVE",
        crate::activity::Kind::Idle => "IDLE",
    };
    conn.execute(
        "INSERT INTO activity (id, user_id, device_id, kind, app_id, app_name, start_ms, end_ms, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET end_ms = excluded.end_ms, status = excluded.status WHERE activity.status = 'OPEN'",
        params![
            i.id, user_id, device_id, kind,
            i.app.as_ref().and_then(|a| a.id.clone()), i.app.as_ref().map(|a| a.name.clone()),
            i.start_ms, i.end_ms, status
        ],
    )?;
    Ok(())
}

/// One collector sample in one transaction: closed intervals become PENDING, and the still-open
/// ones (the open interval and any held ones) replace this scope's previous OPEN checkpoint, so an
/// interval the tracker cut to nothing does not linger.
pub fn activity_checkpoint<'a>(
    conn: &Connection,
    user_id: &str,
    device_id: &str,
    closed: &[crate::activity::Interval],
    open: impl IntoIterator<Item = &'a crate::activity::Interval>,
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for i in closed {
        activity_save(&tx, user_id, device_id, i, "PENDING")?;
    }
    tx.execute("DELETE FROM activity WHERE status = 'OPEN' AND user_id = ?1 AND device_id = ?2", params![user_id, device_id])?;
    for i in open {
        activity_save(&tx, user_id, device_id, i, "OPEN")?;
    }
    tx.commit()
}

/// After a crash or forced quit: intervals left OPEN end at their last checkpoint.
/// Returns how many were recovered. Empty (zero-length) leftovers are removed.
pub fn activity_recover(conn: &Connection) -> rusqlite::Result<usize> {
    let n = conn.execute("UPDATE activity SET status = 'PENDING' WHERE status = 'OPEN' AND end_ms > start_ms", [])?;
    conn.execute("DELETE FROM activity WHERE status = 'OPEN'", [])?;
    Ok(n)
}

/// Pending and rejected intervals of one scope, oldest first.
pub fn activity_list(conn: &Connection, user_id: &str, device_id: &str, limit: i64) -> rusqlite::Result<Vec<ActivityRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, app_id, app_name, start_ms, end_ms, status, reason FROM activity
         WHERE user_id = ?1 AND device_id = ?2 AND status IN ('PENDING', 'REJECTED') ORDER BY start_ms, seq LIMIT ?3",
    )?;
    stmt.query_map(params![user_id, device_id, limit], |r| {
        Ok(ActivityRow {
            id: r.get(0)?, kind: r.get(1)?, app_id: r.get(2)?, app_name: r.get(3)?,
            start_ms: r.get(4)?, end_ms: r.get(5)?, status: r.get(6)?, reason: r.get(7)?,
        })
    })?
    .collect()
}

pub fn activity_ack(conn: &mut Connection, ids: &[String]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for id in ids {
        tx.execute("DELETE FROM activity WHERE id = ?1 AND status = 'PENDING'", params![id])?;
    }
    tx.commit()
}

pub fn activity_reject(conn: &Connection, id: &str, reason: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE activity SET status = 'REJECTED', reason = ?2 WHERE id = ?1 AND status = 'PENDING'", params![id, reason])?;
    Ok(())
}

pub fn activity_dismiss_rejected(conn: &Connection, user_id: &str, device_id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM activity WHERE status = 'REJECTED' AND user_id = ?1 AND device_id = ?2", params![user_id, device_id])?;
    Ok(())
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Unsynced {
    pub active_ms: i64,
    pub idle_ms: i64,
    pub pending: i64,
    pub rejected: i64,
}

/// Not-yet-uploaded time (pending + the open interval) since `since_ms`, for the "today" display.
pub fn activity_unsynced(conn: &Connection, user_id: &str, device_id: &str, since_ms: i64) -> rusqlite::Result<Unsynced> {
    conn.query_row(
        "SELECT
           coalesce(sum(CASE WHEN kind = 'ACTIVE' AND status != 'REJECTED' THEN max(0, end_ms - max(start_ms, ?3)) END), 0),
           coalesce(sum(CASE WHEN kind = 'IDLE' AND status != 'REJECTED' THEN max(0, end_ms - max(start_ms, ?3)) END), 0),
           count(CASE WHEN status = 'PENDING' THEN 1 END),
           count(CASE WHEN status = 'REJECTED' THEN 1 END)
         FROM activity WHERE user_id = ?1 AND device_id = ?2",
        params![user_id, device_id, since_ms],
        |r| Ok(Unsynced { active_ms: r.get(0)?, idle_ms: r.get(1)?, pending: r.get(2)?, rejected: r.get(3)? }),
    )
}

/// All unsynced intervals on this computer (backpressure check).
pub fn activity_backlog(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT count(*) FROM activity WHERE status = 'PENDING'", [], |r| r.get(0))
}

#[cfg(test)]
pub mod tests {
    use super::*;

    fn temp_db() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("wf-queue-test-{}.db", uuid::Uuid::new_v4()))
    }

    /// The database and its WAL side files.
    pub fn remove_db(path: &std::path::Path) {
        for suffix in ["", "-wal", "-shm"] {
            std::fs::remove_file(format!("{}{suffix}", path.display())).ok();
        }
    }

    fn event(id: &str, user: &str, kind: &str) -> QueuedEvent {
        QueuedEvent {
            id: id.into(),
            user_id: user.into(),
            device_id: "dev-1".into(),
            kind: kind.into(),
            occurred_at: "2026-10-12T09:00:00.000Z".into(),
            status: pending(),
            reason: None,
        }
    }

    #[test]
    fn events_survive_reopen_in_fifo_order() {
        let path = temp_db();
        {
            let conn = open(&path).unwrap();
            for (id, kind) in [("e1", "CLOCK_IN"), ("e2", "BREAK_START"), ("e3", "BREAK_END")] {
                add(&conn, &event(id, "u1", kind)).unwrap();
            }
        } // connection dropped, as on app exit or crash after commit
        let conn = open(&path).unwrap();
        let ids: Vec<_> = list(&conn, "u1", "dev-1").unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(ids, ["e1", "e2", "e3"]);
        remove_db(&path);
    }

    #[test]
    fn add_is_idempotent_and_ack_removes() {
        let path = temp_db();
        let mut conn = open(&path).unwrap();
        add(&conn, &event("e1", "u1", "CLOCK_IN")).unwrap();
        add(&conn, &event("e1", "u1", "CLOCK_IN")).unwrap();
        assert_eq!(list(&conn, "u1", "dev-1").unwrap().len(), 1);
        ack(&mut conn, &["e1".into()]).unwrap();
        assert!(list(&conn, "u1", "dev-1").unwrap().is_empty());
        remove_db(&path);
    }

    #[test]
    fn queue_is_scoped_to_employee_and_device() {
        let path = temp_db();
        let conn = open(&path).unwrap();
        add(&conn, &event("a", "u1", "CLOCK_IN")).unwrap();
        add(&conn, &event("b", "u2", "CLOCK_IN")).unwrap();
        assert_eq!(list(&conn, "u1", "dev-1").unwrap()[0].id, "a");
        assert_eq!(list(&conn, "u2", "dev-1").unwrap()[0].id, "b");
        assert!(list(&conn, "u1", "dev-2").unwrap().is_empty());
        remove_db(&path);
    }

    #[test]
    fn rejected_events_are_kept_until_dismissed() {
        let path = temp_db();
        let conn = open(&path).unwrap();
        add(&conn, &event("a", "u1", "CLOCK_OUT")).unwrap();
        reject(&conn, "a", "Cannot clock out while clocked out").unwrap();
        let rows = list(&conn, "u1", "dev-1").unwrap();
        assert_eq!((rows[0].status.as_str(), rows[0].reason.as_deref()), ("REJECTED", Some("Cannot clock out while clocked out")));
        dismiss_rejected(&conn, "u1", "dev-1").unwrap();
        assert!(list(&conn, "u1", "dev-1").unwrap().is_empty());
        assert!(conn.execute("INSERT INTO events (id, user_id, device_id, type, occurred_at) VALUES ('x','u','d','NAP','t')", []).is_err());
        remove_db(&path);
    }

    #[test]
    fn damaged_queue_is_moved_aside_not_deleted() {
        let path = temp_db();
        std::fs::write(&path, b"this is not a sqlite database, but it is the user's data").unwrap();
        let (conn, aside) = open_or_recover(&path).unwrap();
        let aside = aside.expect("recovery reported");
        assert_eq!(std::fs::read(&aside).unwrap(), b"this is not a sqlite database, but it is the user's data");
        add(&conn, &event("e1", "u1", "CLOCK_IN")).unwrap();
        assert_eq!(list(&conn, "u1", "dev-1").unwrap().len(), 1, "fresh queue works");
        drop(conn);
        assert!(open_or_recover(&path).unwrap().1.is_none(), "healthy file opens normally");
        remove_db(&path);
        std::fs::remove_file(aside).ok();
    }

    fn interval(id: &str, start: i64, end: i64) -> crate::activity::Interval {
        crate::activity::Interval {
            id: id.into(),
            kind: crate::activity::Kind::Active,
            app: Some(crate::activity::App { id: Some("com.example.Code".into()), name: "Code".into() }),
            start_ms: start,
            end_ms: end,
        }
    }

    #[test]
    fn activity_checkpoint_survives_crash_and_is_recovered_once() {
        let path = temp_db();
        {
            let conn = open(&path).unwrap();
            activity_save(&conn, "u1", "d1", &interval("a", 0, 15_000), "PENDING").unwrap();
            // Open interval checkpointed twice, then the process dies without closing it.
            activity_save(&conn, "u1", "d1", &interval("b", 15_000, 30_000), "OPEN").unwrap();
            activity_save(&conn, "u1", "d1", &interval("b", 15_000, 45_000), "OPEN").unwrap();
            activity_save(&conn, "u1", "d1", &interval("empty", 45_000, 45_000), "OPEN").unwrap();
        }
        let mut conn = open(&path).unwrap();
        assert_eq!(activity_recover(&conn).unwrap(), 1);
        let rows = activity_list(&conn, "u1", "d1", 100).unwrap();
        assert_eq!(rows.iter().map(|r| (r.id.as_str(), r.end_ms)).collect::<Vec<_>>(), [("a", 15_000), ("b", 45_000)]);
        assert_eq!(activity_recover(&conn).unwrap(), 0, "idempotent");
        // A closed row is never changed by a late checkpoint.
        activity_save(&conn, "u1", "d1", &interval("b", 15_000, 99_000), "OPEN").unwrap();
        assert_eq!(activity_list(&conn, "u1", "d1", 100).unwrap()[1].end_ms, 45_000);

        assert_eq!(activity_unsynced(&conn, "u1", "d1", 10_000).unwrap(), Unsynced { active_ms: 35_000, idle_ms: 0, pending: 2, rejected: 0 });
        activity_reject(&conn, "a", "outside clocked-in time").unwrap();
        activity_ack(&mut conn, &["b".into(), "a".into()]).unwrap();
        let rows = activity_list(&conn, "u1", "d1", 100).unwrap();
        assert_eq!(rows.iter().map(|r| (r.id.as_str(), r.status.as_str())).collect::<Vec<_>>(), [("a", "REJECTED")], "rejected kept until dismissed");
        assert!(activity_list(&conn, "u2", "d1", 100).unwrap().is_empty(), "scoped");
        activity_dismiss_rejected(&conn, "u1", "d1").unwrap();
        assert_eq!(activity_backlog(&conn).unwrap(), 0);
        remove_db(&path);
    }

    #[test]
    fn kv_roundtrip() {
        let path = temp_db();
        let conn = open(&path).unwrap();
        assert_eq!(kv_get(&conn, "k").unwrap(), None);
        kv_set(&conn, "k", Some("1")).unwrap();
        kv_set(&conn, "k", Some("2")).unwrap();
        assert_eq!(kv_get(&conn, "k").unwrap().as_deref(), Some("2"));
        kv_set(&conn, "k", None).unwrap();
        assert_eq!(kv_get(&conn, "k").unwrap(), None);
        remove_db(&path);
    }
}
