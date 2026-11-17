#!/usr/bin/python3 -I
"""Desktop installer receiver: the ONLY program the `workfolio-publisher` SSH key can run (forced command,
installed root-owned at /usr/local/lib/workfolio/desktop-downloads-receiver by install-desktop-publisher.sh).

It can write only inside the downloads directory (/srv/workfolio-downloads), and only this:
  upload   <file> <size> <sha256>   installer bytes on stdin -> .incoming/ -> verified -> linked to <file>.
                                    Never replaces an existing file (same bytes = no-op, different = refused).
  activate <file> <sha256> <commit> re-hash <file>, then atomically point desktop-releases.json at it for its
                                    platform. The previous entry is kept under "previous" (rollback). Refuses a
                                    version equal to (with other bytes) or lower than the current one.
  status                            print desktop-releases.json.
  rollback <windows|macos>          local use only (root: sudo -u workfolio-publisher <receiver> rollback windows),
                                    swaps the current and previous entry. Not reachable over SSH.

Over SSH the command comes from SSH_ORIGINAL_COMMAND; argv only carries options fixed by the operator (--dir).
Installers are never deleted, so every earlier version stays downloadable for rollback.
"""
import datetime
import fcntl
import hashlib
import json
import os
import re
import shlex
import stat
import sys

MAX_SIZE = 512 * 1024 * 1024
# All patterns are ASCII-only and anchored with \Z: `$` would also accept a trailing newline, `\d` non-ASCII digits.
NAME_RE = re.compile(
    r"insight-workfolio_((?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3}))_"
    r"(windows-x86_64-setup\.exe|macos-universal\.dmg|macos-aarch64\.dmg)\Z", re.ASCII
)
KINDS = {
    "windows-x86_64-setup.exe": ("windows", "64-bit (x64)"),
    "macos-universal.dmg": ("macos", "Universal (Apple Silicon and Intel)"),
    "macos-aarch64.dmg": ("macos", "Apple Silicon"),
}
SHA_RE = re.compile(r"[0-9a-f]{64}\Z")
COMMIT_RE = re.compile(r"[0-9a-f]{40}\Z")
SIZE_RE = re.compile(r"[1-9][0-9]{0,11}\Z")
VERSION_RE = re.compile(r"[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}\Z")
# Same rule as the Caddy route: top-level names only, first char alphanumeric.
SERVED_RE = re.compile(r"/desktop-downloads/[A-Za-z0-9][A-Za-z0-9._-]*\.(exe|dmg)\Z")
MANIFEST = "desktop-releases.json"
SSH_COMMANDS = {"upload", "activate", "status"}


class Refused(Exception):
    pass


def parse_name(name):
    m = NAME_RE.match(name)
    if not m:
        raise Refused(f"invalid installer name: {name!r}")
    platform, arch = KINDS[m.group(2)]
    return platform, m.group(1), arch


def version_key(v):
    if not (isinstance(v, str) and VERSION_RE.match(v)):
        raise Refused(f"manifest holds an invalid version {v!r}; fix it by hand")
    return tuple(int(p) for p in v.split("."))


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def regular_file(path):
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return False
    return stat.S_ISREG(st.st_mode)


def check_newer(d, platform, version, sha):
    """Refuse a version lower than the published one, or the published version with other bytes."""
    cur = read_manifest(d).get(platform)
    if not (isinstance(cur, dict) and isinstance(cur.get("version"), str)):
        return
    if cur["version"] == version and cur.get("sha256") != sha:
        raise Refused(f"{platform} {version} is already published with different bytes")
    if version_key(cur["version"]) > version_key(version):
        raise Refused(f"{platform} {version} is lower than the published {cur['version']}")


def upload(d, name, size, sha):
    platform, version, _ = parse_name(name)
    if not SIZE_RE.match(size) or int(size) > MAX_SIZE:
        raise Refused(f"invalid size: {size!r}")
    if not SHA_RE.match(sha):
        raise Refused("invalid sha256")
    check_newer(d, platform, version, sha)
    size = int(size)
    final = os.path.join(d, name)
    incoming = os.path.join(d, ".incoming")
    os.makedirs(incoming, mode=0o700, exist_ok=True)
    tmp = os.path.join(incoming, f"{name}.{os.getpid()}")
    h, total = hashlib.sha256(), 0
    try:
        with open(tmp, "xb") as out:
            os.fchmod(out.fileno(), 0o644)
            stdin = sys.stdin.buffer
            while total <= size:
                chunk = stdin.read(min(1 << 20, size + 1 - total))
                if not chunk:
                    break
                total += len(chunk)
                h.update(chunk)
                out.write(chunk)
            out.flush()
            os.fsync(out.fileno())
        if total != size:
            raise Refused(f"size mismatch: received {total if total <= size else 'more than ' + str(size)} bytes, expected {size}")
        if h.hexdigest() != sha:
            raise Refused(f"sha256 mismatch: received {h.hexdigest()}")
        try:
            os.link(tmp, final)  # atomic, and fails instead of replacing an existing name
        except FileExistsError:
            if regular_file(final) and sha256_of(final) == sha:
                print(f"already present (identical): {name}")
                return
            raise Refused(f"{name} already exists with different content; installers are never overwritten")
        print(f"uploaded {name} ({size} bytes, sha256 {sha})")
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def read_manifest(d):
    try:
        with open(os.path.join(d, MANIFEST)) as f:
            m = json.load(f)
    except FileNotFoundError:
        return {}
    if not isinstance(m, dict):
        raise Refused("existing manifest is not a JSON object; fix it by hand")
    return m


def write_manifest(d, m):
    tmp = os.path.join(d, f".{MANIFEST}.tmp")
    with open(tmp, "w") as f:
        os.fchmod(f.fileno(), 0o644)
        json.dump(m, f, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, os.path.join(d, MANIFEST))  # readers see the old or the new manifest, never a partial one


def locked(d):
    fd = os.open(os.path.join(d, ".publish.lock"), os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


def activate(d, name, sha, commit):
    platform, version, arch = parse_name(name)
    if not SHA_RE.match(sha):
        raise Refused("invalid sha256")
    if not COMMIT_RE.match(commit):
        raise Refused("invalid commit (40 hex characters)")
    path = os.path.join(d, name)
    lock = locked(d)
    try:
        if not regular_file(path):
            raise Refused(f"{name} is not uploaded")
        if sha256_of(path) != sha:
            raise Refused(f"{name} on disk does not match sha256 {sha}")
        check_newer(d, platform, version, sha)
        m = read_manifest(d)
        cur = m.get(platform)
        if isinstance(cur, dict) and cur.get("version") == version:
            print(f"{platform} {version} is already the published version; nothing changed")
            return
        entry = {
            "version": version,
            "releasedAt": datetime.datetime.now(datetime.timezone.utc).date().isoformat(),
            "file": name,
            "href": f"/desktop-downloads/{name}",
            "arch": arch,
            "sizeBytes": os.path.getsize(path),
            "sha256": sha,
            "commit": commit,
        }
        if isinstance(cur, dict):
            entry["previous"] = {k: v for k, v in cur.items() if k != "previous"}
        m[platform] = entry
        write_manifest(d, m)
        print(json.dumps({platform: entry}, indent=2))
    finally:
        os.close(lock)


def rollback(d, platform):
    if platform not in ("windows", "macos"):
        raise Refused("platform must be windows or macos")
    lock = locked(d)
    try:
        m = read_manifest(d)
        cur = m.get(platform)
        prev = cur.get("previous") if isinstance(cur, dict) else None
        if not isinstance(prev, dict):
            raise Refused(f"no previous {platform} release recorded")
        href = prev.get("href")
        if href is not None and not (SERVED_RE.match(href) and regular_file(os.path.join(d, href.rsplit("/", 1)[1]))):
            raise Refused(f"previous installer {href} is missing on disk")
        m[platform] = {**prev, "previous": {k: v for k, v in cur.items() if k != "previous"}}
        write_manifest(d, m)
        print(f"{platform}: {cur.get('version')} -> {prev.get('version')}")
    finally:
        os.close(lock)


def main(argv):
    d = "/srv/workfolio-downloads"
    if len(argv) >= 2 and argv[0] == "--dir":
        d, argv = argv[1], argv[2:]
    ssh = os.environ.get("SSH_ORIGINAL_COMMAND")
    if ssh is not None:
        try:
            args = shlex.split(ssh)
        except ValueError:
            raise Refused("unparsable command")
        if not args or args[0] not in SSH_COMMANDS:
            raise Refused(f"command not allowed over SSH: {args[0] if args else '(none)'}")
    else:
        args = argv
    cmd, rest = (args[0], args[1:]) if args else ("", [])
    arity = {"upload": 3, "activate": 3, "status": 0, "rollback": 1}
    if cmd not in arity or len(rest) != arity[cmd]:
        raise Refused("usage: upload <file> <size> <sha256> | activate <file> <sha256> <commit> | status | rollback <platform>")
    if cmd == "status":
        print(json.dumps(read_manifest(d), indent=2))
    else:
        {"upload": upload, "activate": activate, "rollback": rollback}[cmd](d, *rest)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Refused as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        sys.exit(2)
