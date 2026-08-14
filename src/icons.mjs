// THE TWO ICONS STEAMWORKS ASKS FOR, OUT OF ONE PICTURE. Installation → General Installation has a
// Mac icon field that takes an .icns and a Linux one that takes "16x16, 24x24, 32x32, 64x64, 96x96
// and so on, in PNG format, in a .zip file". Both are the same image at a list of sizes, and both
// lists are Steam's and Apple's rather than any one game's — which is what makes them belong here
// beside the capsule dimensions rather than in a project's config.
//
// There is no Windows field, and that is not an omission: the Windows icon is compiled into the
// .exe, where electron-builder puts it from `build/icon.ico`.
//
// EVERY SIZE IS RENDERED ONCE AND SHARED. 256 is `ic08`, and it is also `ic13`, and it is also the
// largest Linux icon in the default set. Encoding it three times is three chances for one of them to
// come out different from the others for a reason nobody would think to look for.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { die, rawConfig } from "./config.mjs";
import { crop, filterFor, frame, pad, resample } from "./image.mjs";
import { ICNS_ENTRIES, ICNS_SIZES, encodeIcns } from "./icns.mjs";
import { decodePng, encodePng } from "./png.mjs";
import { encodeZip } from "./zip.mjs";

export const MAC_FILE = "mac_icon.icns";
export const LINUX_FILE = "linux_icons.zip";

// The five sizes Steamworks names, and the rest of the freedesktop hicolor set its "and so on"
// leaves open. 48 is the one worth having that Steam does not list: it is what most launchers and
// task switchers ask for first, and a theme with no 48 gets one scaled from whatever is nearest.
export const LINUX_SIZES = [16, 24, 32, 48, 64, 96, 128, 256];

export const TARGETS = ["mac", "linux"];
export const FILE_FOR = { mac: MAC_FILE, linux: LINUX_FILE };

const ICON_OPTS = ["source", "out", "square", "focus", "linuxSizes"];
const SQUARE = ["pad", "crop"];

export function loadIcons(root, over = {}) {
  const { pkg, raw, path } = rawConfig(root);
  const icon = raw?.icon || {};

  for (const key of Object.keys(icon)) {
    // Same argument as the artwork block: a misspelled option here produces a full set of icons,
    // made exactly as they would have been if nothing had been asked for.
    if (!ICON_OPTS.includes(key)) {
      die(`icon has "${key}", which is not an option.\n    They are: ${ICON_OPTS.join(", ")}`);
    }
  }

  const source = over.source || icon.source;
  if (!source) {
    die("no icon source.\n" +
      `    Add an "icon" block to ${path}, or pass --source:\n\n` +
      '      "icon": { "source": "art/icon.png", "out": "steam" }\n\n' +
      "    One square PNG on transparency, 1024x1024 or bigger — every size is made from it.");
  }

  const square = over.square || icon.square || "pad";
  if (!SQUARE.includes(square)) {
    die(`square is "${square}" — it is ${SQUARE.map((s) => `"${s}"`).join(" or ")}.`);
  }

  const sizes = icon.linuxSizes || LINUX_SIZES;
  if (!Array.isArray(sizes) || !sizes.length) {
    die(`icon.linuxSizes is ${JSON.stringify(sizes)} — it is a list of pixel sizes, like ${JSON.stringify(LINUX_SIZES)}.`);
  }
  for (const n of sizes) {
    if (!Number.isInteger(n) || n < 1 || n > 4096) {
      die(`icon.linuxSizes has ${JSON.stringify(n)}, and a Linux icon size is a whole number of pixels from 1 to 4096.`);
    }
  }

  const only = over.only?.length ? over.only : null;
  for (const target of only || []) {
    if (!TARGETS.includes(target)) die(`--only ${target} is not one of the targets.\n    They are: ${TARGETS.join(", ")}`);
  }

  return {
    name: raw?.name || pkg.build?.productName || pkg.name || "this game",
    out: resolve(root, over.out || icon.out || "steam"),
    source: sourceAt(root, source),
    square,
    focus: icon.focus,
    targets: TARGETS.filter((t) => !only || only.includes(t)),
    linuxSizes: [...new Set(sizes)].sort((a, b) => a - b),
  };
}

function sourceAt(root, source) {
  const path = resolve(root, source);
  if (!existsSync(path)) {
    die(`no icon source at ${path}.\n    That is "${source}" resolved against the project root.`);
  }
  return path;
}

export function readIcon(path) {
  try {
    return decodePng(readFileSync(path));
  } catch (e) {
    die(`${path} could not be read as a PNG.\n    ${e.message}`);
  }
}

export function planIcons(src, cfg) {
  const wanted = new Set();
  if (cfg.targets.includes("mac")) for (const size of ICNS_SIZES) wanted.add(size);
  if (cfg.targets.includes("linux")) for (const size of cfg.linuxSizes) wanted.add(size);

  // A square source is left exactly alone whichever mode is configured, so `square` only ever
  // describes what happened to a source that was not one.
  const how = src.width === src.height ? "already" : cfg.square;
  const side = how === "crop" ? Math.min(src.width, src.height) : Math.max(src.width, src.height);
  let rect = null;
  if (how === "crop") {
    try {
      rect = frame(src.width, src.height, side, side, { focus: cfg.focus });
    } catch (e) {
      die(`icon: ${e.message}`);
    }
  }

  return {
    how,
    side,
    rect,
    // A focus that steered nothing is almost always a focus that was meant to: it is typed while
    // looking at a crop that is coming out wrong, and in "pad" there is no crop for it to move.
    idleFocus: Boolean(cfg.focus) && how !== "crop",
    opaque: everyPixelOpaque(src),
    sizes: [...wanted].sort((a, b) => a - b).map((size) => ({
      size,
      filter: filterFor(side, side, size, size),
      upscaled: size > side,
      into: TARGETS.filter((t) => cfg.targets.includes(t)
        && (t === "mac" ? ICNS_SIZES.includes(size) : cfg.linuxSizes.includes(size))),
    })),
  };
}

// An icon is drawn on transparency, and one that is not comes out as a rectangle with a picture in
// it wherever the platform draws it against something — a Dock, a launcher, a task switcher. This
// cannot be fixed by guessing at which colour was meant to be the background, so it is reported.
function everyPixelOpaque(img) {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) return false;
  return true;
}

export function renderIcons(src, cfg, plan) {
  const master = plan.how === "crop" ? crop(src, plan.rect.x, plan.rect.y, plan.rect.w, plan.rect.h)
    : plan.how === "pad" ? pad(src, plan.side, plan.side)
      : src;

  const png = new Map();
  for (const { size } of plan.sizes) png.set(size, encodePng(resample(master, size, size)));

  const files = [];
  if (cfg.targets.includes("mac")) {
    files.push([MAC_FILE, encodeIcns(ICNS_ENTRIES.map((e) => ({ type: e.type, data: png.get(e.size) })))]);
  }
  if (cfg.targets.includes("linux")) {
    // Flat, with no folder above them. A zip that unpacks into a directory is a different shape from
    // a zip that unpacks into files, and only one of them is what the field asked for.
    files.push([LINUX_FILE, encodeZip(cfg.linuxSizes.map((n) => ({ name: `icon_${n}x${n}.png`, data: png.get(n) })))]);
  }
  return files;
}
