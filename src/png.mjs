// A PNG CODEC, BECAUSE THIS REPO HAS NO DEPENDENCIES AND IS NOT GETTING ONE FOR THIS. Cropping a
// store capsule out of a key art plate needs pixels, and every library that hands you pixels is a
// library. Node ships the only hard part — zlib — so what is left is chunk framing, five row
// filters and a CRC, and all of that is spelled out in the spec.
//
// It decodes what a screenshot or an export actually is (any colour type, any bit depth, no
// interlace) and encodes exactly one thing: 8-bit RGBA. There is no reason for a store capsule to
// be anything else, and a codec with one output has one thing that can be wrong with it.
//
// EVERYTHING IT CANNOT DO, IT SAYS. A decoder that guesses at a chunk it does not understand
// produces an image that looks plausible and is wrong, and "the capsule came out strange" is not a
// bug report anyone can act on.

import { deflateSync, inflateSync } from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Colour type -> samples per pixel, and which bit depths the spec allows with it. The depth table
// is not decoration: a 16-bit palette image is not a thing, and a file claiming to be one is
// corrupt rather than exotic.
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const TYPE_NAME = { 0: "greyscale", 2: "truecolour", 3: "indexed", 4: "greyscale+alpha", 6: "truecolour+alpha" };

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) {
    throw new Error("not a PNG — the 8-byte signature is missing");
  }

  let head = null, palette = null, trns = null;
  const idat = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    if (pos + 12 + len > buf.length) throw new Error(`PNG is truncated inside its ${type} chunk`);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;

    if (type === "IHDR") {
      head = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colour: body[9],
        compression: body[10],
        filter: body[11],
        interlace: body[12],
      };
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
  }

  if (!head) throw new Error("PNG has no IHDR chunk");
  if (!head.width || !head.height) throw new Error(`PNG says it is ${head.width}x${head.height}`);
  if (head.interlace) {
    throw new Error("PNG is Adam7 interlaced, which this decoder does not undo — re-save it without interlacing");
  }
  if (head.compression !== 0 || head.filter !== 0) {
    throw new Error(`PNG uses compression ${head.compression} / filter method ${head.filter}, and the spec has only 0`);
  }
  const channels = CHANNELS[head.colour];
  if (!channels) throw new Error(`PNG colour type ${head.colour} is not one the spec defines`);
  if (!DEPTHS[head.colour].includes(head.depth)) {
    throw new Error(`PNG is ${head.depth}-bit ${TYPE_NAME[head.colour]}, which the spec does not allow`);
  }
  if (head.colour === 3 && !palette) throw new Error("PNG is indexed and carries no PLTE chunk");
  if (!idat.length) throw new Error("PNG has no IDAT chunk — there is no image in it");

  const raw = inflateSync(Buffer.concat(idat));
  const lines = unfilter(raw, head, channels);
  return { width: head.width, height: head.height, data: toRgba(lines, head, channels, palette, trns) };
}

// Undo the per-row filters, in place, into one contiguous buffer of unfiltered rows. Every filter
// but None refers to the row above, so this cannot be done a row at a time and thrown away.
function unfilter(raw, head, channels) {
  const { width, height, depth } = head;
  const rowBytes = Math.ceil((width * channels * depth) / 8);
  const bpp = Math.max(1, Math.ceil((channels * depth) / 8));
  const need = (rowBytes + 1) * height;
  if (raw.length < need) {
    throw new Error(`PNG pixel data is ${raw.length} bytes and ${head.width}x${head.height} needs ${need} — the file is truncated`);
  }

  const out = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (rowBytes + 1)];
    const src = y * (rowBytes + 1) + 1;
    const dst = y * rowBytes;
    const up = dst - rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = y ? out[up + i] : 0;
      const c = y && i >= bpp ? out[up + i - bpp] : 0;
      let v;
      if (type === 0) v = x;
      else if (type === 1) v = x + a;
      else if (type === 2) v = x + b;
      else if (type === 3) v = x + ((a + b) >> 1);
      else if (type === 4) v = x + paeth(a, b, c);
      else throw new Error(`PNG row ${y} claims filter type ${type}, and there are only 0-4`);
      out[dst + i] = v & 0xff;
    }
  }
  return { bytes: out, rowBytes };
}

// Samples out to 8-bit RGBA. Sub-byte depths are unpacked bit by bit and 16-bit takes the high
// byte: a capsule is viewed in a browser at 8 bits either way, and keeping the low byte would mean
// carrying a second pixel format through everything downstream to lose it at the end anyway.
function toRgba({ bytes, rowBytes }, head, channels, palette, trns) {
  const { width, height, depth, colour } = head;
  const out = new Uint8Array(width * height * 4);

  // 8-bit RGBA is already the answer, and it is what a browser, a canvas and every screenshot tool
  // produce — worth not walking per channel through a closure two million times to find that out.
  if (colour === 6 && depth === 8) {
    for (let y = 0; y < height; y++) bytes.copy(out, y * width * 4, y * rowBytes, y * rowBytes + width * 4);
    return out;
  }

  const max = (1 << depth) - 1;
  const scale = depth < 8 ? 255 / max : 1;
  const sample = (row, i) => {
    if (depth === 16) return bytes[row + i * 2];
    if (depth === 8) return bytes[row + i];
    const bit = i * depth;
    return (bytes[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & max;
  };
  // tRNS means something different for each colour type: an index list, one grey level, or one
  // colour. All three are "this exact value is see-through", none of them is an alpha channel. The
  // greyscale and truecolour forms store 16 bits per sample whatever the image depth is, so they
  // are brought down to what `sample` will actually return before anything is compared to them.
  const asSample = (v) => (depth === 16 ? v >> 8 : v & max);
  const clearGrey = colour === 0 && trns?.length >= 2 ? asSample(trns.readUInt16BE(0)) : null;
  const clearRgb = colour === 2 && trns?.length >= 6
    ? [asSample(trns.readUInt16BE(0)), asSample(trns.readUInt16BE(2)), asSample(trns.readUInt16BE(4))]
    : null;

  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colour === 3) {
        const idx = sample(row, x);
        if ((idx + 1) * 3 > palette.length) {
          throw new Error(`PNG pixel ${x},${y} indexes palette entry ${idx} and the palette has ${Math.floor(palette.length / 3)}`);
        }
        out[o] = palette[idx * 3];
        out[o + 1] = palette[idx * 3 + 1];
        out[o + 2] = palette[idx * 3 + 2];
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
        continue;
      }
      const base = x * channels;
      if (colour === 0 || colour === 4) {
        const g = sample(row, base);
        out[o] = out[o + 1] = out[o + 2] = Math.round(g * scale);
        out[o + 3] = colour === 4 ? sample(row, base + 1) : g === clearGrey ? 0 : 255;
      } else {
        const r = sample(row, base), g = sample(row, base + 1), b = sample(row, base + 2);
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = colour === 6 ? sample(row, base + 3)
          : clearRgb && r === clearRgb[0] && g === clearRgb[1] && b === clearRgb[2] ? 0 : 255;
      }
    }
  }
  return out;
}

function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "latin1");
  Buffer.from(body).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

export function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    SIG,
    chunk("IHDR", ihdr),
    // Default level, not 9. The library hero is a 19 MB buffer and the last few percent of ratio
    // costs seconds of somebody's afternoon on a file that gets uploaded once.
    chunk("IDAT", deflateSync(filterRows(width, height, data))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Pick a filter per row by the standard heuristic: the one whose output has the smallest sum of
// absolute signed values, which is a decent proxy for how well it will deflate. All five candidate
// rows are produced in one pass over the source, so each pixel is read once and the winner is
// copied rather than recomputed.
function filterRows(width, height, data) {
  const stride = width * 4;
  const out = Buffer.alloc((stride + 1) * height);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  const sum = new Float64Array(5);
  const mag = (v) => (v < 128 ? v : 256 - v);

  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const above = row - stride;
    sum.fill(0);
    for (let i = 0; i < stride; i++) {
      const x = data[row + i];
      const a = i >= 4 ? data[row + i - 4] : 0;
      const b = y ? data[above + i] : 0;
      const c = y && i >= 4 ? data[above + i - 4] : 0;
      const v0 = x;
      const v1 = (x - a) & 0xff;
      const v2 = (x - b) & 0xff;
      const v3 = (x - ((a + b) >> 1)) & 0xff;
      const v4 = (x - paeth(a, b, c)) & 0xff;
      cand[0][i] = v0; sum[0] += mag(v0);
      cand[1][i] = v1; sum[1] += mag(v1);
      cand[2][i] = v2; sum[2] += mag(v2);
      cand[3][i] = v3; sum[3] += mag(v3);
      cand[4][i] = v4; sum[4] += mag(v4);
    }
    let best = 0;
    for (let f = 1; f < 5; f++) if (sum[f] < sum[best]) best = f;
    out[y * (stride + 1)] = best;
    cand[best].copy(out, y * (stride + 1) + 1);
  }
  return out;
}
