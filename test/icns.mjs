// The Mac container, walked back out of the bytes by a reader written from the format rather than
// from the writer. That distinction is the same one the PNG tests make: a walker that reused the
// encoder's idea of where an entry ends would agree with it about a length field that is eight bytes
// short, and the result is not a crash — it is a Dock showing a generic icon.
//
// `walkIcns` is exported because test/icons.mjs opens the file the CLI actually wrote with it.

import { ICNS_ENTRIES, ICNS_SIZES, encodeIcns } from "../src/icns.mjs";
import { ok, group } from "./harness.mjs";

export const walkIcns = (buf) => {
  if (buf.toString("latin1", 0, 4) !== "icns") throw new Error("no icns magic at the front");
  const total = buf.readUInt32BE(4);
  if (total !== buf.length) throw new Error(`the header says ${total} bytes and the file is ${buf.length}`);
  const out = [];
  let pos = 8;
  while (pos < buf.length) {
    const type = buf.toString("latin1", pos, pos + 4);
    const len = buf.readUInt32BE(pos + 4);
    if (len < 8 || pos + len > buf.length) throw new Error(`${type} claims ${len} bytes at ${pos}`);
    out.push({ type, data: buf.subarray(pos + 8, pos + len) });
    pos += len;
  }
  return out;
};

const failed = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };
const parts = [{ type: "ic07", data: Buffer.from("PAYLOAD!") }, { type: "ic10", data: Buffer.from("xy") }];

group("the icns is a header and a list of lengths that include themselves", () => {
  const buf = encodeIcns(parts);
  // 8 header + (8+8) + (8+2). Written out rather than derived, so a length field that stopped
  // counting its own header fails here instead of being walked consistently wrongly.
  ok(buf.length === 34, `the whole file is 34 bytes (got ${buf.length})`);
  ok(buf.readUInt32BE(4) === 34, "and the header's length counts the header");
  ok(buf.readUInt32BE(12) === 16, "an entry's length counts its own 8 bytes too");

  const walked = walkIcns(buf);
  ok(walked.length === 2, "both entries are found by walking the lengths");
  ok(walked[0].type === "ic07" && walked[0].data.toString() === "PAYLOAD!", "the first one is intact");
  ok(walked[1].type === "ic10" && walked[1].data.toString() === "xy", "and so is the last, which pins the offsets");
});

group("the entry table is the set macOS actually asks for", () => {
  // Every OSType is four characters, or it is not an OSType, and the whole list must be distinct:
  // two entries of the same type is a file where one of them is dead weight nothing reads.
  ok(ICNS_ENTRIES.every((e) => e.type.length === 4), "every type is a 4-character OSType");
  ok(new Set(ICNS_ENTRIES.map((e) => e.type)).size === ICNS_ENTRIES.length, "and no type appears twice");

  // The @2x pairs are the reason there are ten entries for seven sizes. 16 and its 32, 32 and its
  // 64, and so on: a Retina Mac asks for the doubled type by name.
  const at = (size) => ICNS_ENTRIES.filter((e) => e.size === size).map((e) => e.type);
  ok(at(32).length === 2, "32 is both 16x16@2x and 32x32");
  ok(at(256).length === 2 && at(512).length === 2, "so are 256 and 512");
  ok(at(1024).length === 1 && at(16).length === 1, "while the ends of the range are one each");
  ok(ICNS_SIZES.length === 7 && ICNS_SIZES[0] === 16 && ICNS_SIZES[6] === 1024,
    "which leaves seven distinct sizes to render, 16 to 1024");
});

group("what it refuses", () => {
  ok(failed(() => encodeIcns([])).includes("no icons in it"), "an empty icns is not written");
  ok(failed(() => encodeIcns([{ type: "ic7", data: Buffer.from("x") }])).includes("3 characters"),
    "a type that is not four characters names its length");
  ok(failed(() => encodeIcns([{ type: "ic07", data: Buffer.alloc(0) }])).includes("no data"),
    "and an entry with nothing in it is caught here rather than by macOS");
});
