#!/usr/bin/env node
// Cut the Steam store artwork out of one image: eight capsules, five shapes, one plate.
//
// WHAT IT WILL NOT DO IS PART OF THE OUTPUT. Two of the nine assets in Steamworks cannot come out
// of a background — screenshots have to be gameplay, and a logo has to be drawn on transparency —
// so they are printed at the end rather than left to be noticed later. Seven files in a folder look
// exactly like nine files in a folder to whoever comes back to this in a month.
//
// EVERY LINE SAYS WHAT HAPPENED TO IT. The crop, the scale factor and the resampling filter, for
// each asset, whether or not anything is unusual about it — and an enlargement is called out in
// capitals, because Steam's library hero is 3840 wide and almost no source is.
//
// Usage:
//   npx steam-artwork                                  # write them all
//   npx steam-artwork --print                          # plan only, write nothing
//   npx steam-artwork --only library_hero,small_capsule
//   npx steam-artwork --source art/keyart.png --out steam
//   npx steam-artwork --list                           # the sizes, and the two done by hand
//   npx steam-artwork --root path/to/project
//
// Spell the flags on a direct call rather than through `npm run x -- --flag`: npm's PowerShell shim
// drops the arguments, and losing --print means writing the files for real.
//
// Config — an "artwork" block in steam.config.json, or in package.json's "steam" key:
//
//   "artwork": {
//     "source": "art/keyart.png",
//     "out": "steam",
//     "focus": { "x": 0.5, "y": 0.5 },
//     "assets": {
//       "library_hero":    { "focus": { "y": 0.62 } },
//       "small_capsule":   { "zoom": 1.8 },
//       "page_background": { "fit": "native" }
//     }
//   }
//
//   focus  0..1 in the source, the point each rectangle centres on, clamped to stay inside
//   zoom   >= 1, tightens the rectangle — what a capsule read at a glance usually wants
//   fit    "cover" (default) takes as much of the picture as the shape allows; "native" takes the
//          target size 1:1 where the source is big enough, for a capsule with no resampling in it
//   crop   an explicit rectangle in source pixels, grown to the target's shape rather than squashed
//   skip   leave this one out
//   source a different plate for this one asset

import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ASSETS, BY_HAND, loadArtwork, planFor, readSource, renderFor } from "../src/artwork.mjs";
import { die } from "../src/config.mjs";

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? "" : (args[i + 1] || "");
};

const DRY_RUN = args.includes("--print") || args.includes("--dry") || args.includes("--dry-run");
const ROOT = resolve(valueOf("--root") || process.cwd());
const ONLY = valueOf("--only").split(",").map((s) => s.trim()).filter(Boolean);

const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));

function list() {
  console.log("\n  What Steam asks for, and what this writes:\n");
  const width = Math.max(...ASSETS.map((a) => a.key.length));
  for (const a of ASSETS) {
    console.log(`    ${pad(a.key, width)}  ${pad(`${a.w}x${a.h}`, 9)}  ${a.what}`);
  }
  byHand();
}

function byHand() {
  console.log("\n  Not cut from a background — these two are made by hand:\n");
  for (const [what, why] of BY_HAND) console.log(`    ${what}\n     ${why}\n`);
  // The sizes are only half of what Steamworks asks. The rest is about content — a logo that has to
  // fill the small capsule, a hero that must carry no text at all — and none of it is anything a
  // crop can satisfy, so it is written down where there is room for the argument.
  console.log("  What Steam asks of each asset beyond its size is in steam-tools' README,\n" +
    "  under \"What Steam asks of each one\". A capsule can be the right number of pixels\n" +
    "  and still be rejected.\n");
}

function main() {
  if (args.includes("--list")) return list();

  const { name, out, assets } = loadArtwork(ROOT, {
    source: valueOf("--source"),
    out: valueOf("--out"),
    only: ONLY,
  });
  if (!assets.length) die("every asset is skipped — there is nothing to write.");

  const here = (p) => relative(ROOT, p).split("\\").join("/") || p;
  console.log(`\n  ${name} — Steam store artwork`);
  console.log(`  out: ${here(out)}${DRY_RUN ? "  (nothing written — this is --print)" : ""}\n`);

  const width = Math.max(...assets.map((a) => a.file.length));
  const written = [];
  let last = "";

  for (const asset of assets) {
    const src = readSource(asset.source);
    if (asset.source !== last) {
      console.log(`    from ${here(asset.source)}  (${src.width}x${src.height})`);
      last = asset.source;
    }
    const plan = planFor(asset, src);
    const { x, y, w, h } = plan.rect;
    console.log(`      ${pad(asset.file, width)}  crop ${pad(`${w}x${h}`, 9)} at ${pad(`${x},${y}`, 9)}` +
      `  ${plan.scale.toFixed(3)}x ${pad(plan.filter, 8)}${plan.upscaled ? "  UPSCALED" : ""}`);
    if (plan.safe) {
      console.log(`         safe zone covers source ${plan.safe.x},${plan.safe.y}` +
        ` to ${plan.safe.x + plan.safe.w},${plan.safe.y + plan.safe.h} — keep what matters inside it`);
    }
    if (DRY_RUN) continue;
    written.push([join(out, asset.file), renderFor(asset, src, plan)]);
  }

  // Everything is planned and rendered before anything lands on disk. A run that half-wrote a set
  // would leave a folder where some capsules are the new art and some are last week's, and there is
  // nothing in the files themselves to tell them apart.
  if (!DRY_RUN) {
    mkdirSync(out, { recursive: true });
    for (const [path, png] of written) writeFileSync(path, png);
    console.log(`\n  ${written.length} file${written.length === 1 ? "" : "s"} in ${here(out)}`);
  }

  byHand();
}

main();
