// Where the rectangle goes, and what happens to the pixels inside it.
//
// `frame` is checked far harder than the resamplers, and on purpose: a capsule resampled a little
// too softly is a capsule, while a capsule framed from the wrong part of the picture is a mistake
// nobody catches until it is on a store page. It is pure arithmetic, so there is no excuse.

import { crop, filterFor, frame, resample } from "../src/image.mjs";
import { ok, group, same } from "./harness.mjs";

// A test image whose every pixel says where it came from, so a crop or a scale that moved is
// visible as a number rather than as a difference in a blob.
const grid = (w, h) => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      data[o] = x;
      data[o + 1] = y;
      data[o + 2] = 0;
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
};
const at = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const rect = (r) => [r.x, r.y, r.w, r.h];
const failed = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };

group("cover takes the largest rectangle of the right shape", () => {
  // The eight real ones, out of a 1920x1080 plate. These are the numbers the tool prints, and they
  // are here so a change to the arithmetic has to be argued for rather than noticed later.
  const from = (w, h) => rect(frame(1920, 1080, w, h));
  ok(same(from(920, 430), [0, 92, 1920, 897]), "header capsule is width-limited");
  ok(same(from(462, 174), [0, 179, 1920, 723]), "so is the small capsule, and harder");
  ok(same(from(1232, 706), [18, 0, 1884, 1080]), "the main capsule is height-limited");
  ok(same(from(748, 896), [510, 0, 901, 1080]), "and the vertical capsule badly so");
  ok(same(from(600, 900), [600, 0, 720, 1080]), "the library capsule takes a 720-wide slice");
  ok(same(from(1438, 810), [2, 0, 1917, 1080]), "the page background is nearly the whole frame");
  // THE ONE THE FILTER CHOICE TURNS ON. 1920x620 into 3840x1240 is exactly 2x on both axes; a
  // rectangle one pixel off in either direction loses the nearest-neighbour path silently.
  ok(same(from(3840, 1240), [0, 230, 1920, 620]), "and the library hero is exactly half of its target");

  ok(same(rect(frame(1000, 1000, 500, 500)), [0, 0, 1000, 1000]), "a matching shape takes everything");
  ok(same(rect(frame(1000, 100, 10, 10)), [450, 0, 100, 100]), "an extreme source still centres");
});

group("focus places it, and cannot push it out of the picture", () => {
  const f = (focus) => rect(frame(1000, 1000, 100, 50, { focus }));
  ok(same(f(undefined), [0, 250, 1000, 500]), "centred by default");
  ok(same(f({ y: 0 }), [0, 0, 1000, 500]), "top edge clamps at 0 rather than going negative");
  ok(same(f({ y: 1 }), [0, 500, 1000, 500]), "bottom edge clamps to what is left");
  ok(same(f({ y: 0.75 }), [0, 500, 1000, 500]), "and a focus that would hang over the edge is pulled in");
  ok(same(rect(frame(1000, 1000, 50, 100, { focus: { x: 0.75 } })), [500, 0, 500, 1000]),
    "x works the same way");
  ok(same(rect(frame(1000, 1000, 50, 100, { focus: { x: -5, y: 9 } })), [0, 0, 500, 1000]),
    "a focus outside 0..1 is clamped, not honoured");
  ok(same(rect(frame(1000, 1000, 100, 50, { focus: { x: 0.5, y: 0.3 } })), [0, 50, 1000, 500]),
    "and an ordinary one lands where it says");
});

group("zoom, fit and an explicit crop", () => {
  ok(same(rect(frame(1000, 1000, 100, 50, { zoom: 2 })), [250, 375, 500, 250]),
    "zoom 2 halves the rectangle and keeps it centred");
  ok(same(rect(frame(1000, 1000, 100, 50, { zoom: 1 })), [0, 250, 1000, 500]), "zoom 1 changes nothing");
  // Zoom has to bite on the rectangle that fits, not on the one before it was cut down to fit.
  // A tall target out of a square source is where the two answers come apart.
  ok(same(rect(frame(1000, 1000, 50, 100, { zoom: 2 })), [375, 250, 250, 500]),
    "and it tightens the rectangle that fits, not the oversized one it started from");
  ok(failed(() => frame(1000, 1000, 100, 50, { zoom: 0.5 })).includes("below 1"),
    "and zooming out is refused — there are no pixels out there");

  ok(same(rect(frame(1000, 1000, 400, 300, { fit: "native" })), [300, 350, 400, 300]),
    "native takes the target size exactly, for a capsule with no resampling in it");
  ok(same(rect(frame(1000, 1000, 4000, 3000, { fit: "native" })), [0, 125, 1000, 750]),
    "and falls back to cover when the source is too small to give it");
  ok(failed(() => frame(1000, 1000, 100, 50, { fit: "contain" })).includes('"cover" or "native"'),
    "a fit that is not one of the two is a typo and stops the run");

  // An aspect ratio typed by hand is a wish. Honouring it literally would stretch the art, so the
  // rectangle grows on the short axis instead — and the growth is centred on what was asked for.
  ok(same(rect(frame(1000, 1000, 100, 50, { crop: { x: 100, y: 100, w: 200, h: 200 } })), [0, 100, 400, 200]),
    "an explicit crop is grown to the target shape, not squashed into it");
  ok(same(rect(frame(1000, 1000, 50, 100, { crop: { x: 100, y: 100, w: 400, h: 200 } })), [100, 0, 400, 800]),
    "and grown on whichever axis is short");
  ok(same(rect(frame(1000, 1000, 100, 50, { crop: { x: 0, y: 0, w: 1000, h: 1000 } })), [0, 250, 1000, 500]),
    "a crop that cannot grow shrinks on the other axis rather than running off the image");
  ok(failed(() => frame(1000, 1000, 100, 50, { crop: { x: 900, y: 0, w: 200, h: 100 } })).includes("does not fit"),
    "a crop that starts inside and ends outside is refused with the numbers");
  ok(failed(() => frame(1000, 1000, 100, 50, { crop: { x: 0, y: 0, w: "wide", h: 100 } })).includes("numeric w"),
    "and one with a string in it names the field");
});

group("the filter is picked from the numbers", () => {
  ok(filterFor(100, 100, 100, 100) === "none", "same size resamples nothing at all");
  ok(filterFor(1920, 620, 3840, 1240) === "nearest", "the library hero's exact 2x is nearest neighbour");
  ok(filterFor(100, 100, 300, 300) === "nearest", "as is any whole-number enlargement");
  ok(filterFor(100, 100, 200, 300) === "bilinear", "a whole number on one axis only is not one");
  ok(filterFor(100, 100, 250, 250) === "bilinear", "and neither is 2.5x");
  ok(filterFor(1884, 1080, 1232, 706) === "area", "shrinking is a box filter");
  ok(filterFor(100, 100, 200, 50) === "bilinear", "up on one axis and down on the other is not shrinking");
});

group("crop copies the rectangle and nothing else", () => {
  const cut = crop(grid(20, 20), 3, 5, 4, 6);
  ok(cut.width === 4 && cut.height === 6, "the size is what was asked for");
  ok(same(at(cut, 0, 0), [3, 5, 0, 255]), "its top-left is the source pixel it started at");
  ok(same(at(cut, 3, 5), [6, 10, 0, 255]), "and its bottom-right is the last one inside");
});

group("nearest neighbour reproduces pixels rather than blending them", () => {
  const up = resample(grid(4, 3), 8, 6);
  ok(up.width === 8 && up.height === 6, "2x on both axes");
  // Every source pixel becomes a 2x2 block of exactly itself. An interpolating resampler puts a
  // half-step between them here, which is the whole reason this path exists.
  let blocks = true;
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 8; x++) {
      if (!same(at(up, x, y), [x >> 1, y >> 1, 0, 255])) blocks = false;
    }
  }
  ok(blocks, "and every source pixel comes out as a 2x2 block of itself, unmixed");

  const same1 = resample(grid(5, 5), 5, 5);
  ok(same(Array.from(same1.data), Array.from(grid(5, 5).data)), "a 1:1 resample is a copy");
});

group("the box filter averages, and respects alpha", () => {
  const flat = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(0) };
  for (let i = 0; i < flat.data.length; i += 4) {
    flat.data[i] = 60; flat.data[i + 1] = 120; flat.data[i + 2] = 180; flat.data[i + 3] = 255;
  }
  const small = resample(flat, 3, 3);
  ok(same(at(small, 1, 1), [60, 120, 180, 255]), "a flat field shrinks to the same colour");

  // One opaque white pixel and one fully clear black one, averaged. The alpha halves. The colour
  // must stay white, because the black pixel is not there to contribute any: a plain mean returns
  // 128, and so does dividing the colour sum by anything other than the alpha sum.
  const mix = { width: 2, height: 1, data: new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]) };
  ok(same(at(resample(mix, 1, 1), 0, 0), [255, 255, 255, 128]),
    "and a clear pixel contributes its alpha but none of its colour");

  // A ratio that is not a whole number, so the middle source pixel is split between both outputs.
  // 3 -> 2 at 1.5 each: (0*1 + 120*0.5)/1.5 = 40, and (120*0.5 + 240*1)/1.5 = 200. A box filter
  // that only counted whole covered pixels gives 60 and 240.
  const ramp = { width: 3, height: 1, data: new Uint8Array([0, 0, 0, 255, 120, 120, 120, 255, 240, 240, 240, 255]) };
  const split = resample(ramp, 2, 1);
  ok(same(at(split, 0, 0), [40, 40, 40, 255]) && same(at(split, 1, 0), [200, 200, 200, 255]),
    "a source pixel straddling two output pixels is shared between them by area");

  // The last cell of a fractional ratio is where an un-normalised filter goes wrong, and alpha is
  // the channel it shows up in — the colour sums divide the error back out.
  const clearish = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(100) };
  ok(at(resample(clearish, 3, 5), 2, 4)[3] === 100, "and alpha survives a fractional ratio unscaled");
});

group("bilinear is only for what neither of the others fits", () => {
  const up = resample(grid(4, 4), 10, 10);
  ok(up.width === 10 && up.height === 10, "it produces the size asked for");
  ok(up.data[3] === 255, "keeps a fully opaque source opaque");
  // Monotonic along a row: the red channel encodes x, so it must never go backwards.
  let rising = true;
  for (let x = 1; x < 10; x++) if (at(up, x, 5)[0] < at(up, x - 1, 5)[0]) rising = false;
  ok(rising, "and a ramp comes out still rising, which a transposed sample would not");
});
