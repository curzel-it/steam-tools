#!/usr/bin/env node
// Upload the packaged desktop builds to Steam: steamcmd + ContentBuilder, one depot per platform.
//
// IT RUNS ON ANY OF THE THREE. It probes for whichever steamcmd the box has, so a Windows or Linux
// machine can push the depots it can build without borrowing a Mac.
//
// CREDENTIALS ARE NOT THIS SCRIPT'S BUSINESS IF YOU DO NOT WANT THEM TO BE. Run
// `steamcmd +login <user>` by hand once and answer the Steam Guard prompt; steamcmd caches a
// sentinel and every run after that needs only the username. That is the recommended path and the
// reason STEAM_PASSWORD is optional rather than required.
//
// ONE BUILD OR NONE. The platform folders going up are compared file by file, inside their
// app.asar, before anything is uploaded, and a disagreement stops the run — see src/asar.mjs.
//
// Usage:
//   npx steam-upload                    # upload, promote nothing
//   npx steam-upload --print            # print the build.vdf, connect to nothing
//   npx steam-upload --live smoketest   # upload and set live on a branch
//   npx steam-upload --root path/to/project
//
// Spell the flags on a direct call rather than through `npm run x -- --flag`: npm's PowerShell
// shim drops the arguments, and losing --print means doing the upload for real. Measured, not
// guessed — the same line through bash arrives intact.
//
// Env (from .env at the project root, or the environment):
//   STEAM_USERNAME       steamcmd login (required — the only one with no default)
//   STEAM_PASSWORD       optional; omit once the Steam Guard sentinel is cached
//   STEAMWORKS_BUILDER   path to the SDK's tools/ContentBuilder (or a builder* dir)
//   STEAM_APP_ID, STEAM_DEPOT_WIN, STEAM_DEPOT_MAC, STEAM_DEPOT_LINUX
//                        override the ids in steam.config.json
//
// What this deliberately does NOT do: sign anything. The Windows and Linux depots do not need it.
// The macOS .app does — an unsigned, un-notarized bundle is the one real risk in a desktop build —
// and that has to happen on a Mac, before this runs.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PLATFORMS, depotFor, die, loadConfig, loadEnv } from "../src/config.mjs";
import { assertSameBuild } from "../src/asar.mjs";
import { findDistDirs } from "../src/dist.mjs";
import { findSteamcmd, steamcmdEnv } from "../src/steamcmd.mjs";
import { buildVdf } from "../src/vdf.mjs";

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? "" : (args[i + 1] || "");
};

// Three spellings, because the obvious one gets typed and none of them cost anything.
const DRY_RUN = args.includes("--print") || args.includes("--dry") || args.includes("--dry-run");
const LIVE = valueOf("--live");
const ROOT = resolve(valueOf("--root") || process.cwd());

// The build's description, as it will read in the Steamworks build list. THE COMMIT IS WORTH MORE
// THAN THE VERSION STRING THERE: a version can sit unchanged for a long time, and the thing you
// actually want to know six builds later is which tree it was.
function describe(cfg) {
  const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: cfg.root, encoding: "utf8" });
  const sha = git.status === 0 ? git.stdout.trim() : "";
  return sha ? `${cfg.name} ${cfg.version} (${sha})` : `${cfg.name} ${cfg.version}`;
}

function main() {
  const env = loadEnv(ROOT);
  const cfg = loadConfig(ROOT, env);

  const dirs = findDistDirs(cfg);
  assertSameBuild(cfg, dirs);

  // Only the platforms actually being uploaded need an id. Asking for the mac depot on a box that
  // cannot build a mac package would be a wall with nothing behind it.
  const depots = {};
  for (const platform of Object.keys(dirs)) depots[platform] = depotFor(cfg, env, platform);

  const username = (env.STEAM_USERNAME || "").trim();
  if (!username) {
    die("STEAM_USERNAME is not set.\n" +
      "    Put it in .env. Run `steamcmd +login <user>` by hand once first so Steam Guard\n" +
      "    caches its sentinel — then no password ever passes through this script.");
  }

  const desc = describe(cfg);
  const steamcmd = findSteamcmd(env, { optional: DRY_RUN });
  const buildVdfPath = join(cfg.temp, "build.vdf");

  const LABEL = { win: "windows", mac: "macOS  ", linux: "linux  " };
  console.log(`\n  ${cfg.name} ${cfg.version} -> Steam app ${cfg.appId}`);
  for (const platform of Object.keys(dirs)) {
    const where = relative(cfg.root, join(cfg.dist, dirs[platform])).split("\\").join("/");
    console.log(`    ${LABEL[platform]}: ${where}  (depot ${depots[platform]})`);
  }
  // Named rather than merely absent: a partial build is a legitimate thing to push, and a silently
  // partial one is how a platform ends up a version behind without anybody noticing.
  const skipped = PLATFORMS.filter((p) => !dirs[p]);
  if (skipped.length) {
    console.log(`\n    NOT in this build: ${skipped.join(", ")} — those depots keep what they have.`);
    if (skipped.includes("mac")) console.log("    (a macOS package can only be built, and signed, on a Mac)");
  }
  console.log(`\n    steamcmd: ${steamcmd || "not installed on this box (dry run)"}`);
  console.log(`    set live: ${LIVE || "no — promote it from the Steamworks UI"}`);

  const vdf = buildVdf({
    appId: cfg.appId,
    depots,
    desc,
    dirs,
    contentRoot: cfg.dist,
    buildOutput: cfg.temp,
    live: LIVE,
  });

  if (DRY_RUN) {
    console.log(`\n---- ${buildVdfPath} ----\n${vdf}`);
    console.log(`  would run: ${steamcmd} +login ${username} <password> +run_app_build ${buildVdfPath} +quit\n`);
    return;
  }

  mkdirSync(cfg.temp, { recursive: true });
  writeFileSync(buildVdfPath, vdf);

  const login = ["+login", username];
  if (env.STEAM_PASSWORD) login.push(env.STEAM_PASSWORD);

  const run = spawnSync(steamcmd, [...login, "+run_app_build", buildVdfPath, "+quit"], {
    stdio: "inherit",
    env: steamcmdEnv(steamcmd, process.env),
  });
  if (run.error) die(`could not run steamcmd: ${run.error.message}`);
  if (run.status !== 0) {
    die(`steamcmd exited ${run.status}.\n` +
      "    If it is a login failure, run `steamcmd +login <user>` by hand to refresh the\n" +
      "    Steam Guard sentinel, then try again.");
  }

  console.log(`\n  uploaded. The build is in Steamworks${LIVE ? ` and live on "${LIVE}"` : ", unpromoted — set it live from the UI"}.\n`);
  if (cfg.package) {
    console.log(`  Depots reach players only through package ${cfg.package}. A depot added to the app\n` +
      "  after it was created is NOT in the package automatically — check that first if a\n" +
      "  platform downloads nothing.\n");
  }
}

main();
