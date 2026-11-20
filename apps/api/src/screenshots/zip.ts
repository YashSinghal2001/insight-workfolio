import { crc32 } from "node:zlib";

export interface ZipEntry {
  /** Flat ASCII file name (no directories). */
  name: string;
  data: Uint8Array;
  modified: Date;
}

/** MS-DOS date/time (local fields; we pass UTC so the archive does not depend on the server's zone). */
function dos(d: Date): [time: number, date: number] {
  return [(d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1), ((Math.max(1980, d.getUTCFullYear()) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()];
}

/**
 * Minimal STORE-only (uncompressed; WebP is already compressed) ZIP writer, streamed entry by entry.
 * ponytail: no ZIP64, so at most 65 535 entries and 4 GiB in total; callers cap far below (SCREENSHOT_EXPORT_LIMITS).
 */
export async function* zipStream(entries: AsyncIterable<ZipEntry>): AsyncGenerator<Uint8Array> {
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;
  for await (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const [time, date] = dos(e.modified);
    const size = e.data.length;
    if (offset + size + 30 + name.length > 0xffff_ffff || count === 0xffff) throw new Error("zip: archive too large (no ZIP64)");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // made by
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(size, 20);
    dir.writeUInt32LE(size, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42); // other fields (extra, comment, disk, attributes) stay 0
    central.push(dir, name);
    yield Buffer.concat([local, name]);
    yield e.data;
    offset += 30 + name.length + size;
    count++;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  yield Buffer.concat([cd, end]);
}
