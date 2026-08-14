// The zip, read the way an unzipper reads one: find the end record, seek to the central directory,
// and reach each file through the offset written there. Reading it forwards instead would pass over
// a central directory pointing at the wrong place, which is exactly the bug that produces an archive
// that some tools open and Steamworks rejects.
//
// `walkZip` is exported because test/icons.mjs opens the file the CLI actually wrote with it.

import { encodeZip } from "../src/zip.mjs";
import { ok, group } from "./harness.mjs";

export const walkZip = (buf) => {
  // Nothing here writes an archive comment, so the end record is the last 22 bytes exactly.
  const end = buf.length - 22;
  if (buf.readUInt32LE(end) !== 0x06054b50) throw new Error("no end-of-central-directory record at the end");
  const count = buf.readUInt16LE(end + 10);
  const out = [];
  let pos = buf.readUInt32LE(end + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error(`central directory entry ${i} has no signature`);
    const nameLen = buf.readUInt16LE(pos + 28);
    const entry = {
      name: buf.toString("utf8", pos + 46, pos + 46 + nameLen),
      method: buf.readUInt16LE(pos + 10),
      crc: buf.readUInt32LE(pos + 16),
      csize: buf.readUInt32LE(pos + 20),
      usize: buf.readUInt32LE(pos + 24),
      offset: buf.readUInt32LE(pos + 42),
      mode: buf.readUInt32LE(pos + 38) >>> 16,
    };
    if (buf.readUInt32LE(entry.offset) !== 0x04034b50) {
      throw new Error(`${entry.name} is not where the central directory says it is`);
    }
    entry.stamp = [buf.readUInt16LE(pos + 12), buf.readUInt16LE(pos + 14)];
    // The local header repeats the timestamp, and it is the copy most extractors write to disk.
    entry.localStamp = [buf.readUInt16LE(entry.offset + 10), buf.readUInt16LE(entry.offset + 12)];
    const at = entry.offset + 30 + buf.readUInt16LE(entry.offset + 26) + buf.readUInt16LE(entry.offset + 28);
    entry.data = buf.subarray(at, at + entry.csize);
    out.push(entry);
    pos += 46 + nameLen + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
  }
  if (pos !== buf.readUInt32LE(end + 16) + buf.readUInt32LE(end + 12)) {
    throw new Error("the central directory is not the size the end record says");
  }
  return out;
};

const failed = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };

group("a zip is read through its central directory", () => {
  const files = [
    // "123456789" is the CRC-32 standard check value, so the sum below is pinned to a published
    // constant rather than to this repo's own table.
    { name: "first.png", data: Buffer.from("123456789") },
    { name: "second.png", data: Buffer.from("a longer entry, so the second offset is not guessable") },
  ];
  const buf = encodeZip(files);
  const walked = walkZip(buf);

  ok(walked.length === 2, "both entries are in the directory");
  ok(walked[0].name === "first.png" && walked[1].name === "second.png", "with the names they were given");
  ok(walked[0].crc === 0xcbf43926, "the CRC of '123456789' is the standard check value 0xCBF43926");
  ok(walked[0].data.toString() === "123456789", "the first file's bytes are reachable through its offset");
  ok(walked[1].data.toString() === files[1].data.toString(),
    "and so are the second's, which is the one a wrong offset moves");

  ok(walked.every((e) => e.method === 0), "stored, so a PNG is not deflated twice");
  ok(walked.every((e) => e.csize === e.usize), "and the two sizes agree, which is what stored means");
  ok(walked.every((e) => e.mode === 0o100644), "each entry carries a sane Unix mode rather than none");

  // Byte for byte the same file twice, and the timestamps are checked directly rather than through
  // that: two encodes a millisecond apart agree about the clock too, so "it matched itself" is not
  // evidence there is no clock in it. A stamp of "now" makes a rebuild of unchanged art look like a
  // change to git and to whoever is deciding whether to re-upload.
  ok(encodeZip(files).equals(buf), "the same input twice is the same bytes");
  ok(walked.every((e) => e.stamp[0] === 0 && e.stamp[1] === 0x0021),
    "every entry is stamped 1980-01-01 00:00, which is the DOS epoch and not a clock");
  ok(walked.every((e) => e.localStamp[0] === 0 && e.localStamp[1] === 0x0021),
    "and the local header, which is the copy that lands on disk, says the same");
});

group("what it refuses", () => {
  ok(failed(() => encodeZip([])).includes("no files"), "an empty zip is not written");

  // Both limits are Zip64's, and neither is reachable with icons — so they are provoked rather than
  // built. The count check runs before anything is allocated, and the size check reads `.length` off
  // whatever it is handed, which is what lets a five-gigabyte entry be described instead of made.
  const many = new Array(0x10000).fill({ name: "a.png", data: Buffer.alloc(0) });
  ok(failed(() => encodeZip(many)).includes("Zip64"), "65536 files is refused rather than truncated to 65535");
  ok(failed(() => encodeZip([{ name: "big.png", data: { length: 5e9 } }])).includes("Zip64"),
    "and so is an archive too big for a 32-bit offset");
});
