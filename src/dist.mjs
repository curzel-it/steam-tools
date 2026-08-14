// WHAT IS ACTUALLY ON DISK TO UPLOAD. electron-builder's `--dir` output: fixed names for Windows
// and Linux, an arch-suffixed folder for macOS.
//
// WHATEVER IS THERE IS WHAT GOES, and that is not laziness — a macOS package cannot be built
// anywhere but macOS, so on a Windows or Linux box a complete set is not an option and demanding
// one would mean never being able to upload at all. A Steam build may carry a subset of its
// depots; the ones left out simply keep whatever was last pushed to them.
//
// It is loud about which ones are missing, for the obvious reason: a build that silently shipped
// two platforms when you believed it shipped three is a broken release for everyone on the third.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { die } from "./config.mjs";

const holdsApp = (dir) => statSync(dir).isDirectory() && readdirSync(dir).some((f) => f.endsWith(".app"));

export function findDistDirs(cfg) {
  const { dist } = cfg;
  const found = {};

  const win = join(dist, "win-unpacked");
  if (existsSync(win)) found.win = win;
  const linux = join(dist, "linux-unpacked");
  if (existsSync(linux)) found.linux = linux;

  const mac = join(dist, `mac-${cfg.macArch}`);
  if (existsSync(mac) && holdsApp(mac)) {
    found.mac = mac;
  } else if (cfg.macArch === "x64" && existsSync(join(dist, "mac")) && holdsApp(join(dist, "mac"))) {
    // electron-builder writes the default arch to a bare `mac`, so a project that ships x64 has
    // no suffix to look for.
    found.mac = join(dist, "mac");
  } else if (existsSync(dist)) {
    // A mac package that is not the one this project ships is worth stopping for rather than
    // skipping past: "mac was not in this build" reads as "no Mac to hand", not as "there is one
    // and it is the wrong architecture".
    const stray = readdirSync(dist)
      .filter((n) => n.startsWith("mac") && n !== `mac-${cfg.macArch}` && holdsApp(join(dist, n)));
    if (stray.length) {
      die(`${relative(cfg.root, join(dist, stray[0]))} is a macOS package for the wrong architecture.\n` +
        `    The mac depot is ${cfg.macArch} and wants mac-${cfg.macArch}.\n` +
        `    Delete it and repackage on a Mac, or set "macArch" in steam.config.json.`);
    }
  }

  if (!Object.keys(found).length) {
    die(`no packaged output under ${relative(cfg.root, dist) || dist} — nothing to upload.\n` +
      "    Package the app first (electron-builder --dir).");
  }
  // ContentRoot is the dist folder, so the depots name their folders relative to it. Forward
  // slashes: the vdf is read by steamcmd, not by the shell, and it wants them on every platform.
  const rel = (p) => relative(dist, p).split("\\").join("/");
  return Object.fromEntries(Object.entries(found).map(([k, v]) => [k, rel(v)]));
}
