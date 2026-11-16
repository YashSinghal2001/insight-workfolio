# Revoked-device inventory and reset (Phase 8)

Status: **waiting for the owner.** No employee record has been changed. Nothing will be reset until specific
employee IDs are confirmed.

## 1. What was inspected

| Database | Result |
|---|---|
| Local `apps/api/data/dev.db` (schema `0019`) | 0 devices, 0 revoked devices, nothing to reset. |
| Production `/var/lib/workfolio/db/workfolio.db` | **Not inspected.** There is no shell from this machine (SSH key refused, see project status audit 2026-11-16) and production access was not authorized. |

So the table requested (Employee | Device | OS | Device ID | Current status | Last seen) cannot be filled
from here. Run the read-only query below on the VPS and paste the output back.

## 2. Read-only inventory query

Uses only columns that exist **before** migration 0031, so it runs on production as it is today. It only
SELECTs (`-readonly`), never prints installation ids or their hashes ("Device ID" is the record UUID).

As root in the Hostinger web console:

```bash
sudo -u workfolio sqlite3 -readonly /var/lib/workfolio/db/workfolio.db <<'SQL'
.headers on
.mode markdown
SELECT '1. All devices' AS section;
SELECT p.full_name AS employee, u.email, p.employee_code AS code, d.device_name AS device,
  CASE d.platform WHEN 'macos' THEN 'macOS' WHEN 'windows' THEN 'Windows' ELSE d.platform END AS os, d.id AS device_id,
  CASE WHEN d.revoked_at IS NOT NULL THEN 'REVOKED'
       WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = d.id AND s.revoked_at IS NULL AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')) THEN 'ACTIVE'
       ELSE 'INACTIVE' END AS status,
  d.registered_at, d.last_seen_at, d.revoked_at,
  (SELECT ua.email FROM account_audit a LEFT JOIN users ua ON ua.id = a.actor_user_id
     WHERE a.resource_type = 'DEVICE' AND a.resource_id = d.id AND a.action = 'DEVICE_REVOKED' ORDER BY a.created_at DESC LIMIT 1) AS revoked_by,
  (SELECT a.reason FROM account_audit a WHERE a.resource_type = 'DEVICE' AND a.resource_id = d.id AND a.action = 'DEVICE_REVOKED' ORDER BY a.created_at DESC LIMIT 1) AS revoke_reason
FROM devices d JOIN employee_profiles p ON p.id = d.employee_id JOIN users u ON u.id = p.user_id
ORDER BY p.full_name, d.registered_at;

SELECT '2. Accounts with revoked devices (candidates for the reset; nothing is changed by this query)' AS section;
SELECT p.employee_code AS code, p.full_name AS employee, u.email, u.status AS account_status,
  sum(d.revoked_at IS NOT NULL) AS revoked_devices, sum(d.revoked_at IS NULL) AS authorized_devices
FROM devices d JOIN employee_profiles p ON p.id = d.employee_id JOIN users u ON u.id = p.user_id
GROUP BY p.id HAVING sum(d.revoked_at IS NOT NULL) > 0 ORDER BY p.full_name;

SELECT '3. Live device-bound sessions per account (more than 1 = repeat sign-ins; migration 0031 unbinds all but the newest)' AS section;
SELECT u.email, count(*) AS live_bound_sessions
FROM sessions s JOIN users u ON u.id = s.user_id
WHERE s.device_id IS NOT NULL AND s.revoked_at IS NULL AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
GROUP BY s.user_id ORDER BY live_bound_sessions DESC;

SELECT '4. One installation registered to several employees (shared computer)' AS section;
SELECT count(DISTINCT employee_id) AS employees, group_concat(id, ', ') AS device_ids
FROM devices GROUP BY device_identifier HAVING count(DISTINCT employee_id) > 1;

SELECT '5. Suspicious records (empty names, unknown platform, last seen before registration)' AS section;
SELECT id AS device_id, device_name, platform, registered_at, last_seen_at FROM devices
WHERE trim(device_name) = '' OR platform NOT IN ('macos', 'windows') OR (last_seen_at IS NOT NULL AND last_seen_at < registered_at);
SQL
```

Sections: (1) every device with status, last seen, revoked at/by/reason; (2) **accounts with revoked
devices** — the list to choose from; (3) accounts with more than one live device-bound session (0031
keeps the newest bound, unbinds the rest, signs nobody out); (4) installations registered to several
employees (would now be refused for the second employee); (5) malformed records.

Validated against a scratch database migrated to 0030 with sample data (revoked + active device for one
employee, a shared installation, duplicate bound sessions): all five sections return the expected rows.

## 3. Report to fill in (from section 1 and 2 of the output)

| Employee | Device | OS | Device ID | Current status | Last seen |
|---|---|---|---|---|---|
| _pending production output_ | | | | | |

Accounts with revoked devices: _pending production output_.

## 4. What "reset" will mean, once you confirm employee IDs

After migration 0031 is deployed (by you), every employee can register **new** installations again (the
one-device index is gone). For a previously revoked **installation** to come back, for each confirmed
employee only:

1. An admin opens **Devices** (or the employee's page) and clicks **Approve re-registration** on each of
   that employee's revoked devices. Audited with the admin as actor (`DEVICE_REREGISTRATION_APPROVED`).
2. The employee signs in on that computer with their password and registers it again (`DEVICE_REREGISTERED`).

This preserves the device rows and all audit history, restores no revoked token, activates no device
automatically, and touches no other account. Doing it through the dashboard (not SQL) keeps the actor in
the audit log. If you prefer that I perform step 1, confirm the exact employee codes and I will list the
exact device IDs to approve before doing anything.

**Needed from you:** the inventory output, then the employee IDs to reset.
