// A ZIP WRITER FOR ONE ZIP: the flat bag of PNGs Steamworks wants the Linux icons in. The format is
// each file's bytes behind a local header, then a central directory repeating those headers, then a
// record saying where the directory starts. An unzipper reads the directory and seeks — which is why
// the offsets in it are the part worth being careful about, and why the tests parse a written zip
// through the directory rather than from the front.
//
// STORED, NOT DEFLATED. Every entry here is a PNG, which is already a deflate stream; compressing it
// again buys nothing and costs the one thing this format gives away for free, which is that the
// bytes of each file are in the archive verbatim where anything can check them.
//
// The CRC is the same CRC-32 the PNG chunks use — same polynomial, same table, and that table is
// pinned to a published constant in test/png.mjs rather than to itself.

import { crc32 } from "./png.mjs";

// A zip carries a modification time per entry, and the only thing this tool could honestly put
// there is "now" — which makes two runs over one unchanged source produce two different files, so a
// rebuild reads as a change to git, to a checksum, and to whoever is deciding whether to re-upload.
// 1980-01-01 00:00 is the earliest a DOS timestamp can express, and nothing downstream cares.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

// Version 2.0, made on Unix. The Unix half is what makes the external attributes below mean
// anything: without it an extractor ignores them and invents its own permissions.
const MADE_BY = (3 << 8) | 20;
const NEEDED = 20;
// A regular file, 0644, in the high half of the external attributes where Unix keeps its mode. The
// shift lands in bit 31, so it is brought back to unsigned before anything writes it as one.
const RW_R_R = (0o100644 << 16) >>> 0;

export function encodeZip(files) {
  if (!files.length) throw new Error("a zip with no files in it is not worth writing");

  let total = 22;
  for (const { name, data } of files) total += 30 + 46 + 2 * Buffer.byteLength(name) + data.length;
  // Both limits are Zip64's territory, and Zip64 is a second set of headers this does not write. An
  // icon set reaches neither, so this is here to be a refusal rather than a silently wrong archive
  // if something else ever calls it.
  if (files.length > 0xffff) throw new Error(`${files.length} files needs Zip64, and this writes plain zip`);
  if (total > 0xffffffff) throw new Error(`${total} bytes needs Zip64, and this writes plain zip`);

  const local = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of files) {
    const label = Buffer.from(name, "utf8");
    // Bit 11 says the name is UTF-8. Every name this repo generates is ASCII, where the flag is
    // meaningless either way, but a caller passing an accented filename without it gets mojibake on
    // one extractor and the right name on the next.
    const flags = label.length === name.length ? 0 : 0x0800;
    const sum = crc32(data);

    const head = Buffer.alloc(30);
    head.writeUInt32LE(LOCAL, 0);
    head.writeUInt16LE(NEEDED, 4);
    head.writeUInt16LE(flags, 6);
    head.writeUInt16LE(0, 8);
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(sum, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(label.length, 26);
    head.writeUInt16LE(0, 28);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(CENTRAL, 0);
    dir.writeUInt16LE(MADE_BY, 4);
    dir.writeUInt16LE(NEEDED, 6);
    dir.writeUInt16LE(flags, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(sum, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(label.length, 28);
    dir.writeUInt32LE(0, 30);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(RW_R_R, 38);
    // Where the local header is, counted from the start of the file. This is the field an unzipper
    // actually seeks to, so it is written from the running offset rather than recomputed later.
    dir.writeUInt32LE(offset, 42);

    local.push(head, label, Buffer.from(data));
    central.push(dir, label);
    offset += 30 + label.length + data.length;
  }

  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...local, ...central, end], total);
}
