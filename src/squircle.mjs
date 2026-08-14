// THE CORNERS. An icon drawn as a full-bleed square is drawn as a full-bleed square: macOS rounds
// nothing on your behalf in the Dock, and neither does any Linux launcher. iOS is the exception —
// it masks the corners itself, which is why an iOS app icon is authored square and why using one
// straight is the common way to end up with the one hard rectangle in a row of rounded neighbours.
//
// THE SHAPE IS A SUPERELLIPSE, |x/a|^5 + |y/a|^5 = 1, not a rounded rectangle. Apple's corner is a
// continuous curve rather than a circular arc joined to a straight edge, and at n = 5 the
// superellipse tracks it closely: it cuts the diagonal back by 0.0915 of the side, which is the
// same bite a circular corner of radius 0.221 takes, against the 0.2237 in Apple's own grid. One
// formula, one constant, and nothing to keep in step with a radius.
//
// It multiplies the alpha it finds rather than replacing it, so a source that already has
// transparency keeps it and only loses what falls outside the curve.

export const SQUIRCLE_EXPONENT = 5;

// The boundary is a single x for each y, so it is solved once per sub-row and every pixel in that
// row is then covered by exact arithmetic instead of by counting samples. Eight sub-rows is enough
// that the master's own edge is smooth; everything smaller is a box-filter shrink of this, which
// carries the softness down with it.
const SUBROWS = 8;

export function squircle(img, exponent = SQUIRCLE_EXPONENT) {
  const { width: w, height: h, data } = img;
  if (w !== h) throw new Error(`the squircle wants a square and this is ${w}x${h}`);

  const a = w / 2;
  const inv = 1 / exponent;
  const out = new Uint8Array(data.length);
  out.set(data);

  for (let y = 0; y < h; y++) {
    const edges = new Float64Array(SUBROWS);
    let narrow = a, wide = 0;
    for (let s = 0; s < SUBROWS; s++) {
      const dy = Math.abs(y + (s + 0.5) / SUBROWS - a) / a;
      const xe = dy >= 1 ? 0 : a * Math.pow(1 - Math.pow(dy, exponent), inv);
      edges[s] = xe;
      if (xe < narrow) narrow = xe;
      if (xe > wide) wide = xe;
    }

    for (let x = 0; x < w; x++) {
      const u0 = x - a, u1 = x + 1 - a;
      if (u0 >= -narrow && u1 <= narrow) continue;
      const o = (y * w + x) * 4;
      if (u0 >= wide || u1 <= -wide) {
        // Outside the curve entirely. The colour goes with the alpha: nothing downstream reads the
        // colour of a clear pixel, and a corner full of the leftovers of the picture is several
        // kilobytes of noise for deflate to carry through every size.
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
        continue;
      }
      let cover = 0;
      for (let s = 0; s < SUBROWS; s++) {
        cover += Math.max(0, Math.min(u1, edges[s]) - Math.max(u0, -edges[s]));
      }
      out[o + 3] = Math.round((data[o + 3] * cover) / SUBROWS);
    }
  }

  return { width: w, height: h, data: out };
}
