// CUTTING A RECTANGLE OUT AND MAKING IT THE SIZE STEAM ASKED FOR. Four operations on the RGBA
// buffers `src/png.mjs` hands back, and one piece of pure arithmetic that decides where the
// rectangle goes.
//
// THE FILTER IS CHOSEN, NOT CONFIGURED, AND THE CHOICE IS REPORTED. An exact integer enlargement is
// nearest neighbour: a pixel-art plate scaled 2x by anything that interpolates comes back as mush,
// and every store capsule cut from a game render is pixel art whether or not it was drawn that way.
// Everything shrinking gets a box filter, because dropping rows — which is what nearest would do —
// throws away the thin bright lines that are the entire subject of a vector render. What is left
// over is bilinear, and `filterFor` is exported so the caller can print which one happened.
//
// Averaging is weighted by alpha throughout. Nothing here needs it today — a store capsule is
// opaque — but a source with transparency in it would otherwise pull the colour of fully clear
// pixels into its edges, and that bug is invisible until it is on a store page.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function crop(img, x, y, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * img.width + x) * 4;
    out.set(img.data.subarray(from, from + w * 4), row * w * 4);
  }
  return { width: w, height: h, data: out };
}

// Grow the canvas without touching a pixel of what is on it. An icon source that is not square has
// to become one, and this is the half of that choice that cannot lose anything: the mark ends up
// smaller inside its square, where cropping ends up with part of the mark outside it.
export function pad(img, w, h) {
  if (w < img.width || h < img.height) {
    throw new Error(`pad to ${w}x${h} is smaller than the ${img.width}x${img.height} going into it`);
  }
  const out = new Uint8Array(w * h * 4);
  const x = Math.floor((w - img.width) / 2);
  const y = Math.floor((h - img.height) / 2);
  for (let row = 0; row < img.height; row++) {
    const from = row * img.width * 4;
    out.set(img.data.subarray(from, from + img.width * 4), ((y + row) * w + x) * 4);
  }
  return { width: w, height: h, data: out };
}

export function filterFor(sw, sh, dw, dh) {
  if (dw === sw && dh === sh) return "none";
  if (dw % sw === 0 && dh % sh === 0 && dw / sw === dh / sh) return "nearest";
  if (dw <= sw && dh <= sh) return "area";
  return "bilinear";
}

export function resample(img, dw, dh) {
  const how = filterFor(img.width, img.height, dw, dh);
  if (how === "none") return { width: dw, height: dh, data: img.data.slice() };
  if (how === "nearest") return nearest(img, dw, dh);
  if (how === "area") return area(img, dw, dh);
  return bilinear(img, dw, dh);
}

function nearest(img, dw, dh) {
  const { width: sw, height: sh, data } = img;
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      const s = (sy * sw + sx) * 4;
      const d = (y * dw + x) * 4;
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
      out[d + 3] = data[s + 3];
    }
  }
  return { width: dw, height: dh, data: out };
}

// Which source cells each output cell covers, and by how much. Fractional at both ends, so a ratio
// that is not a whole number does not quietly favour one side of every output pixel. THE WEIGHTS
// ARE NORMALISED TO SUM TO ONE, which is what lets the two passes below compose without carrying a
// divisor along with them — and the last output cell of a non-integer ratio is exactly where an
// un-normalised version comes out dim.
function spans(srcN, dstN) {
  const step = srcN / dstN;
  const all = [];
  for (let i = 0; i < dstN; i++) {
    const lo = i * step, hi = lo + step;
    const parts = [];
    let total = 0;
    for (let s = Math.floor(lo); s < Math.min(srcN, Math.ceil(hi)); s++) {
      const w = Math.min(hi, s + 1) - Math.max(lo, s);
      if (w > 0) { parts.push([s, w]); total += w; }
    }
    if (!parts.length) { parts.push([Math.min(srcN - 1, Math.floor(lo)), 1]); total = 1; }
    for (const part of parts) part[1] /= total;
    all.push(parts);
  }
  return all;
}

// Separable box filter, through a premultiplied float intermediate so the two passes compose.
function area(img, dw, dh) {
  const { width: sw, height: sh, data } = img;
  const cols = spans(sw, dw);
  const rows = spans(sh, dh);
  const mid = new Float64Array(dw * sh * 4);

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (const [sx, w] of cols[x]) {
        const s = (y * sw + sx) * 4;
        const a = data[s + 3] * w;
        ar += data[s] * a;
        ag += data[s + 1] * a;
        ab += data[s + 2] * a;
        aa += a;
      }
      const m = (y * dw + x) * 4;
      mid[m] = ar; mid[m + 1] = ag; mid[m + 2] = ab; mid[m + 3] = aa;
    }
  }

  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (const [sy, w] of rows[y]) {
        const m = (sy * dw + x) * 4;
        ar += mid[m] * w;
        ag += mid[m + 1] * w;
        ab += mid[m + 2] * w;
        aa += mid[m + 3] * w;
      }
      write(out, (y * dw + x) * 4, ar, ag, ab, aa);
    }
  }
  return { width: dw, height: dh, data: out };
}

function bilinear(img, dw, dh) {
  const { width: sw, height: sh, data } = img;
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const fy = clamp(((y + 0.5) * sh) / dh - 0.5, 0, sh - 1);
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = clamp(((x + 0.5) * sw) / dw - 0.5, 0, sw - 1);
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
      const tl = (y0 * sw + x0) * 4, tr = (y0 * sw + x1) * 4;
      const bl = (y1 * sw + x0) * 4, br = (y1 * sw + x1) * 4;
      const a0 = data[tl + 3] * (1 - wx) * (1 - wy), a1 = data[tr + 3] * wx * (1 - wy);
      const a2 = data[bl + 3] * (1 - wx) * wy, a3 = data[br + 3] * wx * wy;
      write(out, (y * dw + x) * 4,
        data[tl] * a0 + data[tr] * a1 + data[bl] * a2 + data[br] * a3,
        data[tl + 1] * a0 + data[tr + 1] * a1 + data[bl + 1] * a2 + data[br + 1] * a3,
        data[tl + 2] * a0 + data[tr + 2] * a1 + data[bl + 2] * a2 + data[br + 2] * a3,
        a0 + a1 + a2 + a3);
    }
  }
  return { width: dw, height: dh, data: out };
}

// Undo the premultiply. Dividing the colour sums by the alpha sum rather than by the weight sum is
// the whole point: it is the alpha-weighted mean of the colour, so a clear pixel contributes none
// of its colour instead of a quarter of it.
function write(out, o, ar, ag, ab, aa) {
  const a = clamp(Math.round(aa), 0, 255);
  out[o + 3] = a;
  if (aa <= 0) return;
  out[o] = clamp(Math.round(ar / aa), 0, 255);
  out[o + 1] = clamp(Math.round(ag / aa), 0, 255);
  out[o + 2] = clamp(Math.round(ab / aa), 0, 255);
}

// WHERE THE RECTANGLE GOES. Pure arithmetic, no pixels, so the framing can be checked exhaustively
// without decoding anything — which matters, because a capsule that is the right size and shows the
// wrong half of the picture is the failure this whole tool exists to prevent.
//
//   fit    "cover" takes the largest rectangle of the target's shape that fits the source.
//          "native" takes exactly the target size when the source is big enough, which costs some
//          of the frame and buys a capsule with no resampling in it at all.
//   zoom   >= 1, tightens the rectangle. What a small capsule wants, since it is read at a glance.
//   focus  0..1 in source space, the point the rectangle is centred on, clamped so it stays inside.
//   crop   an explicit rectangle in source pixels. Treated as a region of interest and GROWN to the
//          target's shape rather than squashed into it: an aspect ratio typed by hand is a wish,
//          and honouring it literally would stretch the art.
export function frame(sw, sh, dw, dh, opts = {}) {
  const want = dw / dh;
  let w, h, cx, cy;

  if (opts.crop) {
    const r = opts.crop;
    for (const k of ["x", "y", "w", "h"]) {
      if (!Number.isFinite(r[k])) throw new Error(`crop needs a numeric ${k}`);
    }
    if (r.w < 1 || r.h < 1 || r.x < 0 || r.y < 0 || r.x + r.w > sw || r.y + r.h > sh) {
      throw new Error(`crop ${r.w}x${r.h} at ${r.x},${r.y} does not fit inside ${sw}x${sh}`);
    }
    w = r.w; h = r.h;
    if (w / h < want) w = Math.round(h * want); else h = Math.round(w / want);
    cx = r.x + r.w / 2;
    cy = r.y + r.h / 2;
  } else {
    if (opts.zoom !== undefined && !(opts.zoom >= 1)) {
      throw new Error(`zoom is ${opts.zoom} — below 1 would need pixels the source does not have`);
    }
    if (opts.fit && opts.fit !== "cover" && opts.fit !== "native") {
      throw new Error(`fit is "${opts.fit}" — it is "cover" or "native"`);
    }
    if (opts.fit === "native" && dw <= sw && dh <= sh) {
      w = dw; h = dh;
    } else {
      w = sw; h = Math.floor((sw * dh) / dw);
      if (h > sh) { h = sh; w = Math.floor((sh * dw) / dh); }
    }
    const zoom = opts.zoom || 1;
    w = Math.max(1, Math.round(w / zoom));
    h = Math.max(1, Math.round(h / zoom));
    cx = clamp(opts.focus?.x ?? 0.5, 0, 1) * sw;
    cy = clamp(opts.focus?.y ?? 0.5, 0, 1) * sh;
  }

  // A rectangle grown to the target shape can end up bigger than the image it came out of, and
  // there is nothing outside the image to fill it with. Shrink on the axis that overflowed and
  // re-derive the other one, so the shape survives and the size gives way.
  if (w > sw) { w = sw; h = Math.floor(w / want); }
  if (h > sh) { h = sh; w = Math.floor(h * want); }

  return {
    x: clamp(Math.round(cx - w / 2), 0, sw - w),
    y: clamp(Math.round(cy - h / 2), 0, sh - h),
    w,
    h,
  };
}
