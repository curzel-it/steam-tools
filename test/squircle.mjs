// The corner mask, checked against the area of a superellipse rather than against a picture of one.
//
// A shape test that samples a few pixels and calls them plausible is a test that passes for a
// circle, for a rounded rectangle with the wrong radius, and for the right curve drawn one pixel
// out. The area is a closed form — 4a²·Γ(1+1/n)²/Γ(1+2/n) — so the fraction of the square each
// exponent covers is a number this file can carry without computing it the way src/ does, and it
// moves if the exponent, the coverage arithmetic or the antialiasing is wrong anywhere.

import { SQUIRCLE_EXPONENT, squircle } from "../src/squircle.mjs";
import { ok, group, same } from "./harness.mjs";

// Opaque white, so alpha is the mask and nothing else.
const solid = (n, alpha = 255) => {
  const data = new Uint8Array(n * n * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = 255;
    data[i + 3] = alpha;
  }
  return { width: n, height: n, data };
};

const alphaAt = (img, x, y) => img.data[(y * img.width + x) * 4 + 3];
const coverage = (img) => {
  let sum = 0;
  for (let i = 3; i < img.data.length; i += 4) sum += img.data[i];
  return sum / (255 * img.width * img.height);
};
const failed = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };

group("the shape is a superellipse, and the area says which one", () => {
  ok(SQUIRCLE_EXPONENT === 5, "the exponent is 5, which is the one that tracks Apple's corner");

  // n = 5: Γ(1.2)² / Γ(1.4) = 0.918169² / 0.887264 = 0.950167. The squircle keeps 95% of the
  // square, and nothing about a mask drawn by eye lands on that.
  const five = coverage(squircle(solid(256)));
  ok(Math.abs(five - 0.950167) < 0.0005, `n=5 covers 0.9502 of the square (got ${five.toFixed(6)})`);

  // The same machinery at n = 2 is an ellipse, and an ellipse in a square is π/4. Two exponents,
  // two published constants, and the second one rules out a formula that happens to fit the first.
  const two = coverage(squircle(solid(256), 2));
  ok(Math.abs(two - Math.PI / 4) < 0.0005, `n=2 is a circle at π/4 (got ${two.toFixed(6)})`);

  // And the ends of the range, which pin the direction: n = 1 is a diamond at half the square.
  const one = coverage(squircle(solid(256), 1));
  ok(Math.abs(one - 0.5) < 0.0005, `n=1 is a diamond at 0.5 (got ${one.toFixed(6)})`);
});

group("what it does to the pixels", () => {
  const cut = squircle(solid(64));
  ok(alphaAt(cut, 0, 0) === 0 && alphaAt(cut, 63, 63) === 0, "the corners are gone");
  ok(alphaAt(cut, 32, 32) === 255, "the middle is untouched");
  ok(alphaAt(cut, 32, 0) === 255 && alphaAt(cut, 0, 32) === 255,
    "and the middle of every edge still reaches it, which a circle would not");

  // Symmetry about both axes, every pixel, exactly. A mask that is half a pixel out on one axis —
  // the centre-of-pixel-versus-edge-of-pixel slip — comes out lopsided and nothing else notices.
  let axes = 0, diagonal = 0;
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const a = alphaAt(cut, x, y);
      axes = Math.max(axes, Math.abs(alphaAt(cut, 63 - x, y) - a), Math.abs(alphaAt(cut, x, 63 - y) - a));
      diagonal = Math.max(diagonal, Math.abs(alphaAt(cut, y, x) - a));
    }
  }
  ok(axes === 0, `it is symmetric about both axes to the byte (worst ${axes})`);
  // The diagonal is not, and cannot be: coverage is exact across a row and sampled down it, so the
  // two axes are computed by different arithmetic. It is worth knowing how far apart they are, and
  // worth failing if that ever becomes a shape rather than a rounding difference.
  ok(diagonal <= 12, `and about the diagonal to within the sub-row sampling (worst ${diagonal} of 255)`);

  const soft = [];
  for (let i = 3; i < cut.data.length; i += 4) if (cut.data[i] > 0 && cut.data[i] < 255) soft.push(cut.data[i]);
  ok(soft.length > 40, `the edge is antialiased rather than thresholded (${soft.length} partial pixels)`);

  // Alpha is multiplied, not replaced. A source with its own transparency has to keep it, or the
  // "force it on" case turns a mark drawn on nothing into a solid tile.
  const half = squircle(solid(64, 128));
  ok(alphaAt(half, 32, 32) === 128, "a half-transparent middle stays half-transparent");
  ok(alphaAt(half, 0, 0) === 0, "and the corner is still removed");

  // The pixels along the curve are where multiplying and replacing come apart: everything inside is
  // untouched either way and everything outside is 0 either way, so a mask that overwrote the alpha
  // it found would look right on both and turn a mark drawn on nothing into a solid tile.
  let scaled = true;
  for (let i = 3; i < cut.data.length; i += 4) {
    if (Math.abs(half.data[i] - Math.round((cut.data[i] * 128) / 255)) > 1) scaled = false;
  }
  ok(scaled, "and every partial pixel is that same pixel at full alpha, halved — multiplied, not replaced");

  // Clear pixels are cleared in colour too, so the corners of a masked photograph do not travel
  // through every size as noise deflate has to carry.
  ok(same(Array.from(cut.data.subarray(0, 4)), [0, 0, 0, 0]), "a removed pixel keeps no colour either");
  ok(same(Array.from(cut.data.subarray((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 4)), [255, 255, 255, 255]),
    "while a kept one keeps all of it");

  ok(failed(() => squircle({ width: 4, height: 2, data: new Uint8Array(32) })).includes("wants a square"),
    "and a canvas that is not square is refused rather than stretched into one");
});

group("it is the same shape at every size", () => {
  // The corner has to scale with the icon. A radius in pixels rather than in fractions of the side
  // is the usual way this goes wrong, and it is invisible until the 16 and the 512 are side by side.
  for (const n of [15, 16, 17, 128]) {
    const c = coverage(squircle(solid(n)));
    ok(Math.abs(c - 0.950167) < 0.006, `${n}x${n} covers 0.95 of itself (got ${c.toFixed(4)})`);
  }
});
