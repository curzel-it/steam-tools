// REFUSE TO UPLOAD PLATFORM FOLDERS THAT CAME FROM DIFFERENT BUILDS.
//
// One packaging run puts the same application into every platform's app.asar. They diverge when
// electron-builder is run for a subset over an existing dist/ — which is the normal way to work,
// because a Mac package can only be built on a Mac — leaving the other platforms' folders behind
// from an earlier run for the uploader to re-upload verbatim.
//
// That failure is invisible without this check, and invisible in the worst possible way: steamcmd
// reports success on every depot, and Steam dedupes the unchanged content away rather than shipping
// anything, so the build list shows three green depots and the fix never reaches the players on the
// stale one. It cost two rounds of debugging a Linux binary that did not contain the fix under test
// before this existed.
//
// PER FILE, NOT ONE HASH OF THE ARCHIVE. A launcher shipped as an extraFile on Linux and only there
// sits inside the Windows and macOS asars and outside the Linux one, so a correct build's archives
// never match byte for byte — a whole-archive hash would fail every upload such a project makes.
// The exclusions come from package.json (see movedOutOfAsar in config.mjs).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { die } from "./config.mjs";

// The app.asar inside a packaged platform folder. Windows and Linux keep it under resources/; the
// macOS one is inside the .app wrapper, whose name is productName and may therefore have a space
// in it — so it is found rather than spelled.
export function findAsar(dir) {
  const direct = join(dir, "resources", "app.asar");
  if (existsSync(direct)) return direct;
  if (!existsSync(dir)) return "";
  const app = readdirSync(dir).find((f) => f.endsWith(".app"));
  if (!app) return "";
  const inside = join(dir, app, "Contents", "Resources", "app.asar");
  return existsSync(inside) ? inside : "";
}

// One asar's contents, as path -> content hash. The archive carries a SHA256 per file in its own
// header (Electron's asar integrity feature, which electron-builder turns on), so the packed bytes
// never have to be read back to know whether two packages hold the same file.
export function asarContents(path) {
  const buf = readFileSync(path);
  const headerSize = buf.readUInt32LE(12);
  const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString("utf8").replace(/\0+$/, ""));
  const files = new Map();
  (function walk(node, prefix) {
    for (const [name, entry] of Object.entries(node.files || {})) {
      if (entry.files) walk(entry, `${prefix}${name}/`);
      // No integrity block means an older or differently-configured electron-builder; the size is
      // a weaker answer to the same question and better than skipping the file silently.
      else files.set(prefix + name, entry.integrity?.hash || `size:${entry.size}`);
    }
  })(header, "");
  return files;
}

// The disagreements between packages, as [path, hash per platform]. Separated from the reporting
// below so it can be checked without a process that exits.
export function compareBuilds(contents, exclude = new Set()) {
  const platforms = Object.keys(contents);
  if (platforms.length < 2) return [];
  const paths = new Set(platforms.flatMap((p) => [...contents[p].keys()]));
  const bad = [];
  for (const path of [...paths].sort()) {
    if (exclude.has(path)) continue;
    const seen = platforms.map((p) => contents[p].get(path) || "absent");
    if (new Set(seen).size > 1) bad.push([path, seen]);
  }
  return bad;
}

// Only the platforms actually going up are compared. A one-platform upload has nothing to disagree
// with and is a legitimate thing to push.
export function assertSameBuild(cfg, dirs) {
  const platforms = Object.keys(dirs);
  if (platforms.length < 2) return;

  const contents = {};
  for (const platform of platforms) {
    const asar = findAsar(join(cfg.dist, dirs[platform]));
    if (!asar) die(`no app.asar under ${dirs[platform]}.\n    Package the app first.`);
    contents[platform] = asarContents(asar);
  }

  const bad = compareBuilds(contents, cfg.extraFiles);
  if (!bad.length) return;

  // The first few are enough to identify which folder is the odd one out, and a package holds
  // hundreds of files — a stale one disagrees on most of them.
  const shown = bad.slice(0, 6)
    .map(([path, seen]) => `      ${path}\n${platforms
      .map((p, i) => `        ${p.padEnd(6)} ${seen[i].slice(0, 16)}`).join("\n")}`)
    .join("\n");
  die(`these platform folders are from different builds — ${bad.length} file` +
    `${bad.length === 1 ? "" : "s"} inside their app.asar disagree:\n${shown}` +
    `${bad.length > 6 ? `\n      … and ${bad.length - 6} more` : ""}\n` +
    "    Repackage them from the same build, or delete the stale folder and upload the\n" +
    "    rest — a partial build is fine, a mixed one is not.");
}
