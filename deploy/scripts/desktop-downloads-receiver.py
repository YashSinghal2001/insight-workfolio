#!/usr/bin/python3 -I
"""Desktop release receiver: the ONLY program a publisher SSH key can run (forced command, installed root-owned
at /usr/local/lib/workfolio/desktop-downloads-receiver by install-desktop-publisher.sh).

It can write only inside its downloads directory, and only this:
  upload   <file> <size> <sha256>   bytes on stdin -> .incoming/ -> verified -> linked to <file>.
                                    Never replaces an existing file (same bytes = no-op, different = refused).
  activate <commit> <file> <sha256> [<file> <sha256>]
                                    re-hash every installer, then point desktop-releases.json at all of them in
                                    ONE atomic write (a release is both platforms or neither). Release notes
                                    (plain text) are read from stdin. The entry replaced is kept under
                                    "previous". Refuses anything older than what is published.
  status                            print desktop-releases.json.
  history                           print the audit log (desktop-release-history.jsonl, append-only: every
                                    upload, activation and rollback with its time, checksum and commit).
  rollback <windows|macos> [version]
                                    local use only (root: sudo -u <publisher> <receiver> rollback windows),
                                    not reachable over SSH. Without a version: swap current and previous. With
                                    one: restore that version from the audit log (its installer must still be
                                    on disk with the recorded checksum).

Two channels, each with its own SSH key, system user and directory (options fixed by the operator in the
forced command, never taken from the SSH client):
  production (default)  /srv/workfolio-downloads       insight-workfolio_X.Y.Z_<kind>
  --test                /srv/workfolio-downloads/test  insight-workfolio-test_X.Y.Z_r<run>-<attempt>_<kind>
The dashboard reads only the production manifest, and a TEST name can never enter it: each channel accepts
only its own names.

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
MAX_NOTES = 4000
# Installers: what the dashboard offers. kind -> (platform, label shown to employees).
INSTALLERS = {
    "windows-x86_64-setup.exe": ("windows", "64-bit (x64)"),
    "macos-universal.dmg": ("macos", "Universal (Apple Silicon and Intel)"),
    "macos-aarch64.dmg": ("macos", "Apple Silicon"),
}
# In-app updater packages and their minisign signatures: stored and served, never listed in the manifest.
# (The Windows updater package is the NSIS installer itself.) Private signing keys never come here.
EXTRAS = {
    "windows-x86_64-setup.exe.sig": "windows",
    "darwin-universal.app.tar.gz": "macos",
    "darwin-universal.app.tar.gz.sig": "macos",
    "darwin-aarch64.app.tar.gz": "macos",
    "darwin-aarch64.app.tar.gz.sig": "macos",
}
# All patterns are ASCII-only and anchored with \Z: `$` would also accept a trailing newline, `\d` non-ASCII digits.
VERSION = r"((?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3}))"
KINDS = "|".join(re.escape(k) for k in sorted([*INSTALLERS, *EXTRAS], key=len, reverse=True))
SHA_RE = re.compile(r"[0-9a-f]{64}\Z")
COMMIT_RE = re.compile(r"[0-9a-f]{40}\Z")
SIZE_RE = re.compile(r"[1-9][0-9]{0,11}\Z")
VERSION_RE = re.compile(r"[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}\Z")
MANIFEST = "desktop-releases.json"
HISTORY = "desktop-release-history.jsonl"
SSH_COMMANDS = {"upload", "activate", "status", "history"}


class Refused(Exception):
    pass


class Channel:
    def __init__(self, d, test):
        self.d, self.test = d, test
        self.href = "/desktop-downloads/test/" if test else "/desktop-downloads/"
        # A TEST name carries the CI run that built it: the version alone does not change between test builds.
        prefix, build = ("insight-workfolio-test", r"_r([0-9]{1,15})-([0-9]{1,3})") if test else ("insight-workfolio", "()()")
        self.name_re = re.compile(rf"{prefix}_{VERSION}{build}_({KINDS})\Z", re.ASCII)

    def path(self, name):
        return os.path.join(self.d, name)

    def parse(self, name):
        """{platform, version, order, installer, arch}; order = (major, minor, patch, run, attempt)."""
        m = self.name_re.match(name)
        if not m:
            raise Refused(f"invalid {'TEST ' if self.test else ''}file name: {name!r}")
        version, run, attempt, kind = m.groups()
        order = (*map(int, version.split(".")), int(run or 0), int(attempt or 0))
        if kind in INSTALLERS:
            platform, arch = INSTALLERS[kind]
            return {"platform": platform, "version": version, "order": order, "installer": True, "arch": arch}
        return {"platform": EXTRAS[kind], "version": version, "order": order, "installer": False, "arch": None}

    def order_of(self, entry):
        """Order of a manifest entry; an entry seeded by hand (a foreign file name) counts by its version."""
        try:
            return self.parse(entry.get("file", ""))["order"]
        except Refused:
            v = entry.get("version")
            if not (isinstance(v, str) and VERSION_RE.match(v)):
                raise Refused(f"manifest holds an invalid version {v!r}; fix it by hand")
            return (*map(int, v.split(".")), 0, 0)


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


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def record(ch, **event):
    """Append one audit line. O_APPEND + a single short write: concurrent writers cannot interleave."""
    line = json.dumps({"at": now().isoformat(timespec="seconds"), **event}, sort_keys=True) + "\n"
    fd = os.open(ch.path(HISTORY), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, line.encode())
        os.fsync(fd)
    finally:
        os.close(fd)


def read_history(ch):
    try:
        with open(ch.path(HISTORY)) as f:
            return [json.loads(line) for line in f if line.strip()]
    except FileNotFoundError:
        return []


def check_newer(ch, parsed, sha=None):
    """Refuse anything older than the published installer, or (sha given) the published one with other bytes."""
    cur = read_manifest(ch).get(parsed["platform"])
    if not isinstance(cur, dict):
        return
    what = f"{parsed['platform']} {parsed['version']}"
    published = ch.order_of(cur)
    if sha is not None and published == parsed["order"] and cur.get("sha256") != sha:
        raise Refused(f"{what} is already published with different bytes")
    if published > parsed["order"]:
        raise Refused(f"{what} is lower than the published {cur.get('version')}")


def upload(ch, name, size, sha):
    parsed = ch.parse(name)
    if not SIZE_RE.match(size) or int(size) > MAX_SIZE:
        raise Refused(f"invalid size: {size!r}")
    if not SHA_RE.match(sha):
        raise Refused("invalid sha256")
    check_newer(ch, parsed, sha if parsed["installer"] else None)
    size = int(size)
    final = ch.path(name)
    incoming = ch.path(".incoming")
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
            raise Refused(f"{name} already exists with different content; published files are never overwritten")
        record(ch, action="upload", file=name, sizeBytes=size, sha256=sha)
        print(f"uploaded {name} ({size} bytes, sha256 {sha})")
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def read_manifest(ch):
    try:
        with open(ch.path(MANIFEST)) as f:
            m = json.load(f)
    except FileNotFoundError:
        return {}
    if not isinstance(m, dict):
        raise Refused("existing manifest is not a JSON object; fix it by hand")
    return m


def write_manifest(ch, m):
    tmp = ch.path(f".{MANIFEST}.tmp")
    with open(tmp, "w") as f:
        os.fchmod(f.fileno(), 0o644)
        json.dump(m, f, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, ch.path(MANIFEST))  # readers see the old or the new manifest, never a partial one


def locked(ch):
    fd = os.open(ch.path(".publish.lock"), os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


def read_notes():
    """Release notes from stdin (CI pipes them); nothing when run by hand at a terminal."""
    if sys.stdin.isatty():
        return ""
    raw = sys.stdin.buffer.read(4 * MAX_NOTES + 1)
    try:
        notes = raw.decode("utf-8").replace("\r\n", "\n").strip()
    except UnicodeDecodeError:
        raise Refused("release notes are not UTF-8")
    if len(notes) > MAX_NOTES or any(ord(c) < 32 and c not in "\n\t" for c in notes):
        raise Refused(f"release notes must be plain text of at most {MAX_NOTES} characters")
    return notes


def stripped(entry):
    return {k: v for k, v in entry.items() if k != "previous"}


def activate(ch, commit, *pairs):
    if not COMMIT_RE.match(commit):
        raise Refused("invalid commit (40 hex characters)")
    if not pairs or len(pairs) % 2:
        raise Refused("activate needs <file> <sha256> pairs")
    notes = read_notes()
    lock = locked(ch)
    try:
        m = read_manifest(ch)
        changed, seen = {}, set()
        for name, sha in zip(pairs[::2], pairs[1::2]):
            parsed = ch.parse(name)
            platform = parsed["platform"]
            if not parsed["installer"]:
                raise Refused(f"{name} is not an installer")
            if platform in seen:
                raise Refused(f"two {platform} installers in one release")
            seen.add(platform)
            if not SHA_RE.match(sha):
                raise Refused("invalid sha256")
            if not regular_file(ch.path(name)):
                raise Refused(f"{name} is not uploaded")
            if sha256_of(ch.path(name)) != sha:
                raise Refused(f"{name} on disk does not match sha256 {sha}")
            check_newer(ch, parsed, sha)
            cur = m.get(platform)
            if isinstance(cur, dict) and cur.get("file") == name:
                print(f"{platform} {parsed['version']} is already published; unchanged")
                continue
            entry = {
                "version": parsed["version"],
                "releasedAt": now().date().isoformat(),
                "file": name,
                "href": ch.href + name,
                "arch": parsed["arch"],
                "sizeBytes": os.path.getsize(ch.path(name)),
                "sha256": sha,
                "commit": commit,
            }
            if notes:
                entry["notes"] = notes
            if isinstance(cur, dict):
                entry["previous"] = stripped(cur)
            changed[platform] = entry
        if not changed:
            return
        # Every installer verified: one rename publishes them all.
        write_manifest(ch, {**m, **changed})
        for platform, entry in changed.items():
            record(ch, action="activate", platform=platform, entry=stripped(entry), replaced=(entry.get("previous") or {}).get("version"))
        print(json.dumps(changed, indent=2))
    finally:
        os.close(lock)


def rollback(ch, platform, version=None):
    if platform not in ("windows", "macos"):
        raise Refused("platform must be windows or macos")
    lock = locked(ch)
    try:
        m = read_manifest(ch)
        cur = m.get(platform)
        if not isinstance(cur, dict):
            raise Refused(f"no {platform} release is published")
        if version is None:
            target = cur.get("previous")
            if not isinstance(target, dict):
                raise Refused(f"no previous {platform} release recorded")
        else:
            found = [e["entry"] for e in read_history(ch) if e.get("action") == "activate" and e.get("platform") == platform and e["entry"].get("version") == version]
            if not found:
                raise Refused(f"no {platform} {version} in the release history")
            target = found[-1]
        href = target.get("href")
        if href is not None:  # an entry without href is a file bundled with the dashboard, not ours to check
            name = href.rsplit("/", 1)[1]
            if href != ch.href + name or not regular_file(ch.path(name)):
                raise Refused(f"installer {href} is missing on disk")
            # Seeded entries (never published through here) carry no checksum we recorded: accept as before.
            if version is not None and sha256_of(ch.path(name)) != target.get("sha256"):
                raise Refused(f"{name} on disk no longer matches its recorded sha256")
        m[platform] = {**stripped(target), "previous": stripped(cur)}
        write_manifest(ch, m)
        record(ch, action="rollback", platform=platform, entry=stripped(target), replaced=cur.get("version"))
        print(f"{platform}: {cur.get('version')} -> {target.get('version')}")
    finally:
        os.close(lock)


def main(argv):
    d, test = None, False
    while argv and argv[0] in ("--dir", "--test"):
        if argv[0] == "--test":
            test, argv = True, argv[1:]
        elif len(argv) >= 2:
            d, argv = argv[1], argv[2:]
        else:
            raise Refused("--dir needs a path")
    ch = Channel(d or ("/srv/workfolio-downloads/test" if test else "/srv/workfolio-downloads"), test)
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
    arity = {"upload": (3,), "activate": (3, 5), "status": (0,), "history": (0,), "rollback": (1, 2)}
    if cmd not in arity or len(rest) not in arity[cmd]:
        raise Refused("usage: upload <file> <size> <sha256> | activate <commit> <file> <sha256> [<file> <sha256>] | status | history | rollback <platform> [version]")
    if cmd == "status":
        print(json.dumps(read_manifest(ch), indent=2))
    elif cmd == "history":
        for event in read_history(ch):
            print(json.dumps(event, sort_keys=True))
    else:
        {"upload": upload, "activate": activate, "rollback": rollback}[cmd](ch, *rest)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Refused as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        sys.exit(2)
