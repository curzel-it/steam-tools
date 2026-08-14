// WHERE THE NUMBERS COME FROM. A Steam upload needs four ids and one credential, and they do not
// belong in the same place: an AppID is in the store URL and a depot id is visible to anyone who
// owns the game, so those are committed and a fresh clone can upload without being told them. The
// password is not, and never passes through here if steamcmd's own Steam Guard sentinel is cached.
//
// The config is `steam.config.json` at the project root, or a `"steam"` key in package.json for a
// project that would rather not grow a file. The environment — and a .env beside it — overrides
// every id, which is what a second store page or a branch app wants.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function die(msg) {
  console.error(`\n  steam: ${msg}\n`);
  process.exit(1);
}

// .env, READ LENIENTLY. A project's .env belongs to that project and holds keys this tool has no
// opinion about, so it is read rather than validated. The real environment wins, so a one-off
// `STEAM_APP_ID=… npx steam-upload` works.
export function loadEnv(root) {
  const env = {};
  const path = join(root, ".env");
  if (existsSync(path)) {
    for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
  }
  return { ...env, ...process.env };
}

export function readPackage(root) {
  const path = join(root, "package.json");
  if (!existsSync(path)) die(`no package.json in ${root} — run this from the project root.`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    die(`package.json is not valid JSON: ${e.message}`);
  }
}

const TEMPLATE = `    {
      "appId": "480",
      "name": "Your Game",
      "depots": { "win": "481", "mac": "482", "linux": "483" }
    }`;

// An id from the environment if there is one, otherwise the one the project was created with.
// UPLOADING TO THE WRONG APPID IS THE ONE MISTAKE HERE WITH A PUBLIC BLAST RADIUS, so an override
// that is not a real-looking id stops the run rather than being forgiven back to the default.
function requireId(env, key, fallback, what) {
  const override = (env[key] || "").trim();
  const val = override || fallback || "";
  if (!/^\d+$/.test(val) || /^0+$/.test(val)) {
    if (override) {
      die(`${key} is set to "${override}", which is not a Steam id.\n` +
        `    Remove it from .env to use the configured one${fallback ? ` (${fallback})` : ""}, or fix it.`);
    }
    die(`no ${what}.\n    Add it to steam.config.json, or set ${key} in .env:\n\n${TEMPLATE}\n`);
  }
  return val;
}

export const PLATFORMS = ["win", "mac", "linux"];
export const DEPOT_ENV = { win: "STEAM_DEPOT_WIN", mac: "STEAM_DEPOT_MAC", linux: "STEAM_DEPOT_LINUX" };

export function loadConfig(root, env) {
  const pkg = readPackage(root);
  const path = join(root, "steam.config.json");
  let raw = pkg.steam;
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      die(`steam.config.json is not valid JSON: ${e.message}`);
    }
  }
  if (!raw && !env.STEAM_APP_ID) {
    die("no steam.config.json and no \"steam\" key in package.json.\n" +
      `    Write one at ${path}:\n\n${TEMPLATE}\n\n` +
      "    Ids are not secrets — commit them. STEAM_USERNAME goes in .env.");
  }
  const cfg = raw || {};

  return {
    root,
    appId: requireId(env, "STEAM_APP_ID", cfg.appId, "AppID"),
    // The store package these depots are sold in. This tool never uses it, and records it because
    // it is the one id an upload can be silently broken by: a depot added to the app but not to
    // the package uploads perfectly and reaches nobody.
    package: cfg.package || "",
    // What the build is called in the Steamworks build list. electron-builder already knows.
    name: cfg.name || pkg.build?.productName || pkg.name || "build",
    version: pkg.version || die("no version in package.json"),
    depots: cfg.depots || {},
    // The macOS package this project ships. NAMED RATHER THAN SEARCHED FOR, because a leftover
    // `mac` folder from an older x64 build sorts ahead of the real one and would put an Intel
    // package in the depot — which runs under Rosetta on the Apple Silicon Mac that uploaded it,
    // without a word.
    macArch: cfg.macArch || "arm64",
    dist: join(root, cfg.dist || pkg.build?.directories?.output || "dist"),
    temp: join(root, cfg.temp || "temp"),
    extraFiles: movedOutOfAsar(pkg),
  };
}

export function depotFor(cfg, env, platform) {
  return requireId(env, DEPOT_ENV[platform], cfg.depots[platform], `depot id for ${platform}`);
}

// build.<platform>.extraFiles in package.json — the files electron-builder lifts OUT of the asar
// and ships loose in the depot. THIS IS WHY THE SAME-BUILD CHECK IS PER-FILE RATHER THAN A HASH OF
// THE WHOLE ARCHIVE: a launcher that is an extraFile on Linux and only there sits inside the
// Windows and macOS asars and outside the Linux one, so the archives of a single, correct build
// never match byte for byte. Read from package.json rather than named here, so that adding a
// second extraFile is not also a silent way to disarm the check.
function movedOutOfAsar(pkg) {
  const moved = new Set();
  for (const target of Object.values(pkg.build || {})) {
    for (const file of target?.extraFiles || []) {
      const from = typeof file === "string" ? file : file.from;
      if (from) moved.add(from.split("\\").join("/"));
    }
  }
  return moved;
}
