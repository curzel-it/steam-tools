// THE STORE PAGE'S RECTANGLES. Steam wants the same key art at eight sizes in five shapes, and the
// sizes are Steam's — identical in every game, which is what makes them belong in this repo rather
// than in a project's config beside its depot ids. What differs per game is where in the picture
// each rectangle should sit, and that is the whole of what `artwork` in steam.config.json says.
//
// The filenames carry their dimensions. There are two 920x430 fields in Steamworks and four
// capsules whose names all start with "capsule", and a file called header.png is one drag away from
// being uploaded into the wrong one — where it will look fine and be wrong for as long as the page
// is up.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { die, rawConfig } from "./config.mjs";
import { crop, filterFor, frame, resample } from "./image.mjs";
import { decodePng, encodePng } from "./png.mjs";

export const ASSETS = [
  { key: "header_capsule", w: 920, h: 430, what: "top of the store page, and the library grid" },
  { key: "small_capsule", w: 462, h: 174, what: "every list on Steam — search, top sellers, new releases" },
  { key: "main_capsule", w: 1232, h: 706, what: "the featured carousel on the front page" },
  { key: "vertical_capsule", w: 748, h: 896, what: "seasonal sale pages" },
  { key: "page_background", w: 1438, h: 810, what: "behind the store page; Steam tints and fades it" },
  { key: "library_capsule", w: 600, h: 900, what: "the player's library and collections" },
  { key: "library_header", w: 920, h: 430, what: "the library's recent games row" },
  // The safe zone is not advice. Steam crops toward the centre of the hero as the client window
  // narrows, and 860x380 is all of it that survives at every width.
  { key: "library_hero", w: 3840, h: 1240, what: "top of the library detail page", safe: { w: 860, h: 380 } },
];

// The two in steam-resources.md this cannot make, listed rather than left out. An omission and a
// decision look the same from the output folder, and "it produced seven files" reads as complete.
export const BY_HAND = [
  ["Screenshots", "five or more, 16:9, at least 1920x1080 — and Steam requires actual gameplay, which\n" +
    "     explicitly rules out a marketing plate however much it looks like the game"],
  ["Library Logo", "1280 wide and/or 720 tall, on transparency. There is no logo inside a background\n" +
    "     to cut out; this one is drawn, not framed"],
];

const KEYS = ASSETS.map((a) => a.key);
const ASSET_OPTS = ["source", "focus", "zoom", "fit", "crop", "skip"];

export function loadArtwork(root, over = {}) {
  const { pkg, raw, path } = rawConfig(root);
  const art = raw?.artwork || {};

  const source = over.source || art.source;
  if (!source) {
    die("no artwork source.\n" +
      `    Add an "artwork" block to ${path}, or pass --source:\n\n` +
      '      "artwork": { "source": "art/keyart.png", "out": "steam" }\n\n' +
      "    One image, at least 1920x1080 — every capsule is cut out of it.");
  }

  for (const key of Object.keys(art.assets || {})) {
    if (!KEYS.includes(key)) {
      die(`artwork.assets has "${key}", which is not one of the assets.\n    They are: ${KEYS.join(", ")}`);
    }
    for (const opt of Object.keys(art.assets[key] || {})) {
      // A misspelled option is worse than a rejected one: the capsule is still produced, framed the
      // way it would have been if you had never typed anything.
      if (!ASSET_OPTS.includes(opt)) {
        die(`artwork.assets.${key} has "${opt}", which is not an option.\n    They are: ${ASSET_OPTS.join(", ")}`);
      }
    }
  }

  const only = over.only?.length ? over.only : null;
  for (const key of only || []) {
    if (!KEYS.includes(key)) die(`--only ${key} is not one of the assets.\n    They are: ${KEYS.join(", ")}`);
  }

  const assets = ASSETS
    .filter((a) => !art.assets?.[a.key]?.skip && (!only || only.includes(a.key)))
    .map((a) => {
      const per = art.assets?.[a.key] || {};
      return {
        ...a,
        file: `${a.key}_${a.w}x${a.h}.png`,
        source: sourceAt(root, over.source || per.source || source),
        opts: {
          fit: per.fit || art.fit,
          zoom: per.zoom ?? art.zoom,
          crop: per.crop,
          focus: { ...art.focus, ...per.focus },
        },
      };
    });

  return {
    name: raw?.name || pkg.build?.productName || pkg.name || "this game",
    out: resolve(root, over.out || art.out || "steam"),
    assets,
  };
}

function sourceAt(root, source) {
  const path = resolve(root, source);
  if (!existsSync(path)) {
    die(`no artwork source at ${path}.\n    That is "${source}" resolved against the project root.`);
  }
  return path;
}

// Decoded once per file even when eight assets share it: the plate is 8 MB of pixels and there is
// no reason to inflate it eight times.
const decoded = new Map();
export function readSource(path) {
  if (!decoded.has(path)) {
    try {
      decoded.set(path, decodePng(readFileSync(path)));
    } catch (e) {
      die(`${path} could not be read as a PNG.\n    ${e.message}`);
    }
  }
  return decoded.get(path);
}

export function planFor(asset, src) {
  let rect;
  try {
    rect = frame(src.width, src.height, asset.w, asset.h, asset.opts);
  } catch (e) {
    die(`${asset.key}: ${e.message}`);
  }
  const sx = asset.w / rect.w;
  const sy = asset.h / rect.h;
  return {
    rect,
    scale: sx,
    filter: filterFor(rect.w, rect.h, asset.w, asset.h),
    upscaled: sx > 1 || sy > 1,
    // Where Steam's safe zone lands back in the source, so what it will never crop away can be
    // looked at in the plate rather than guessed at from the finished file.
    safe: asset.safe && {
      x: Math.round(rect.x + rect.w / 2 - asset.safe.w / sx / 2),
      y: Math.round(rect.y + rect.h / 2 - asset.safe.h / sy / 2),
      w: Math.round(asset.safe.w / sx),
      h: Math.round(asset.safe.h / sy),
    },
  };
}

export function renderFor(asset, src, plan) {
  const { x, y, w, h } = plan.rect;
  return encodePng(resample(crop(src, x, y, w, h), asset.w, asset.h));
}
