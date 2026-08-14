// THE MAC ICON CONTAINER. Steamworks' Mac icon field takes an .icns and nothing else, and an .icns
// is a header followed by a flat list of [4-byte OSType, length, payload] — where the payload of
// every type used here is an ordinary PNG. That is the whole reason this file is short: the format
// that used to need RLE-packed bitmaps and separate 8-bit masks has taken PNG since 10.7, and
// nothing this repo ships runs on anything older.
//
// THE LENGTHS INCLUDE THEIR OWN HEADER, both the file's and each entry's. Writing the payload
// length instead produces a file that Preview still opens — it recovers by scanning — and that
// Finder, the Dock and `iconutil` read as truncated. The failure is a game with a generic icon in
// the Dock and no error anywhere.

const MAGIC = "icns";

// OSType -> the number of pixels macOS will draw that entry at. The @2x types are not extras: a
// Retina Mac asks for `ic11` where a non-Retina one asks for `icp4`, and an icns missing them is
// drawn by enlarging whatever else is in the file. `what` is the name the same image has in an
// .iconset folder, which is how anyone comparing this against `iconutil` will be reading it.
export const ICNS_ENTRIES = [
  { type: "icp4", size: 16, what: "16x16" },
  { type: "ic11", size: 32, what: "16x16@2x" },
  { type: "icp5", size: 32, what: "32x32" },
  { type: "ic12", size: 64, what: "32x32@2x" },
  { type: "ic07", size: 128, what: "128x128" },
  { type: "ic13", size: 256, what: "128x128@2x" },
  { type: "ic08", size: 256, what: "256x256" },
  { type: "ic14", size: 512, what: "256x256@2x" },
  { type: "ic09", size: 512, what: "512x512" },
  { type: "ic10", size: 1024, what: "512x512@2x" },
];

export const ICNS_SIZES = [...new Set(ICNS_ENTRIES.map((e) => e.size))].sort((a, b) => a - b);

export function encodeIcns(parts) {
  if (!parts.length) throw new Error("an icns with no icons in it is not something macOS will open");

  const body = [];
  let total = 8;
  for (const { type, data } of parts) {
    if (type.length !== 4) throw new Error(`icns type "${type}" is ${type.length} characters and every OSType is 4`);
    if (!data?.length) throw new Error(`icns type "${type}" has no data`);
    const head = Buffer.alloc(8);
    head.write(type, 0, "latin1");
    head.writeUInt32BE(data.length + 8, 4);
    body.push(head, Buffer.from(data));
    total += data.length + 8;
  }

  const head = Buffer.alloc(8);
  head.write(MAGIC, 0, "latin1");
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...body], total);
}
