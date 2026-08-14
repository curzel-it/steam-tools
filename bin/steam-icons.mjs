#!/usr/bin/env node
// Make the two icons Steamworks asks for out of one PNG: a Mac .icns, and a .zip of Linux PNGs.
//
// EVERY SIZE SAYS WHAT HAPPENED TO IT, the way the artwork tool does — which one of them it is, the
// resampling filter it got, and which file it went into. An enlargement is called out in capitals,
// because macOS asks for 1024x1024 and most icon sources are 512 or smaller, and a Dock icon made by
// enlarging is not something anyone notices in a folder listing.
//
// Usage:
//   npx steam-icons                              # write both
//   npx steam-icons --print                      # plan only, write nothing
//   npx steam-icons --only linux                 # or mac
//   npx steam-icons --source art/icon.png --out steam
//   npx steam-icons --square crop                # for a source that is not square
//   npx steam-icons --squircle on                # or off, over what the source says
//   npx steam-icons --root path/to/project
//
// Spell the flags on a direct call rather than through `npm run x -- --flag`: npm's PowerShell shim
// drops the arguments, and losing --print means writing the files for real.
//
// Config — an "icon" block in steam.config.json, or in package.json's "steam" key:
//
//   "icon": {
//     "source": "art/icon.png",
//     "out": "steam",
//     "square": "pad",
//     "squircle": "auto",
//     "focus": { "x": 0.5, "y": 0.5 },
//     "linuxSizes": [16, 24, 32, 48, 64, 96, 128, 256]
//   }
//
//   square      what to do with a source that is not square. "pad" (default) centres it on a
//               transparent square and keeps all of it; "crop" takes the largest square in it
//   squircle    round the corners the way macOS does. "auto" (default) rounds a source that has no
//               transparency of its own, since that one is a rectangle; "on" and "off" decide it
//   focus       0..1 in the source, the point "crop" centres on. Nothing to do in "pad"
//   linuxSizes  the PNGs in the zip. The default is Steam's list plus the rest of hicolor's

import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ICNS_ENTRIES } from "../src/icns.mjs";
import { FILE_FOR, loadIcons, planIcons, readIcon, renderIcons } from "../src/icons.mjs";

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? "" : (args[i + 1] || "");
};

const DRY_RUN = args.includes("--print") || args.includes("--dry") || args.includes("--dry-run");
const ROOT = resolve(valueOf("--root") || process.cwd());
const ONLY = valueOf("--only").split(",").map((s) => s.trim()).filter(Boolean);

const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));
const lpad = (s, n) => " ".repeat(Math.max(0, n - s.length)) + s;

function main() {
  const cfg = loadIcons(ROOT, {
    source: valueOf("--source"),
    out: valueOf("--out"),
    square: valueOf("--square"),
    squircle: valueOf("--squircle"),
    only: ONLY,
  });

  const here = (p) => relative(ROOT, p).split("\\").join("/") || p;
  const src = readIcon(cfg.source);
  const plan = planIcons(src, cfg);

  console.log(`\n  ${cfg.name} — Steam icons`);
  console.log(`  out: ${here(cfg.out)}${DRY_RUN ? "  (nothing written — this is --print)" : ""}\n`);
  console.log(`    from ${here(cfg.source)}  (${src.width}x${src.height})`);

  // What was done to make it square, and why, whichever way it went. A source that arrived square
  // says so too: "it was already square" and "I took the middle of it" are the same output folder.
  if (plan.how === "already") {
    console.log("      already square, so every size is the whole picture");
  } else if (plan.how === "pad") {
    console.log(`      not square — centred on a transparent ${plan.side}x${plan.side}, which keeps all of it.` +
      `\n      "square": "crop" takes the middle ${Math.min(src.width, src.height)} square instead`);
  } else {
    const { x, y, w, h } = plan.rect;
    console.log(`      not square — cropped to ${w}x${h} at ${x},${y}, which is ` +
      `${src.width > src.height ? "everything but the sides" : "everything but the top and bottom"}.` +
      `\n      "square": "pad" keeps all of it on a transparent ${Math.max(src.width, src.height)} square instead`);
  }
  if (plan.idleFocus) {
    console.log("      focus is set and nothing was cropped, so it did nothing");
  }
  // Which way the squircle went and what decided it, on every run. "auto" is the default, so most
  // runs are being told something they did not ask for — and a corner that was rounded or left
  // alone is not visible in a folder full of PNGs until it is in a Dock.
  const why = cfg.squircle !== "auto" ? `forced with "squircle": "${cfg.squircle}"`
    : plan.opaque ? "auto, and there is no transparency in the source"
      : "auto, and the source has a silhouette of its own";
  console.log(`      squircle ${plan.rounded ? "on " : "off"} — ${why}`);
  if (plan.opaque && !plan.rounded) {
    console.log(`      so a Dock, a launcher and a task switcher will each draw it as the` +
      `\n      rectangle it is`);
  }

  console.log("");
  const width = Math.max(...plan.sizes.map((s) => s.filter.length));
  for (const s of plan.sizes) {
    console.log(`      ${lpad(`${s.size}x${s.size}`, 9)}  ${pad(s.filter, width)}  ` +
      `${s.into.map((t) => FILE_FOR[t]).join(", ")}${s.upscaled ? "  UPSCALED" : ""}`);
  }

  const files = renderIcons(src, cfg, plan);
  const smallest = cfg.linuxSizes[0];
  const largest = cfg.linuxSizes[cfg.linuxSizes.length - 1];
  const last = ICNS_ENTRIES[ICNS_ENTRIES.length - 1];

  console.log("");
  for (const [name, data] of files) {
    const what = name === FILE_FOR.mac
      ? `${ICNS_ENTRIES.length} entries, ${ICNS_ENTRIES[0].what} to ${last.what}`
      : `${cfg.linuxSizes.length} files, ${smallest}x${smallest} to ${largest}x${largest}`;
    console.log(`    ${pad(name, 16)} ${lpad(`${Math.round(data.length / 1024)} KB`, 7)}  ${what}`);
  }

  // Both containers are built before either is written, for the same reason the capsules are: a run
  // that wrote the icns and then failed on the zip leaves a folder that looks finished. --print
  // stops here rather than earlier, so the sizes above it are the real ones and a dry run is a
  // rehearsal of the whole job rather than of its arithmetic.
  if (!DRY_RUN) {
    mkdirSync(cfg.out, { recursive: true });
    for (const [name, data] of files) writeFileSync(join(cfg.out, name), data);
  }

  console.log("\n  The fields are in Steamworks under Installation → General Installation. There is");
  console.log("  no Windows one: that icon is compiled into the .exe, from build/icon.ico.\n");
}

main();
