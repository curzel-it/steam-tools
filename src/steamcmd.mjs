// steamcmd, wherever this box keeps it. The Steamworks SDK lays ContentBuilder out with one
// builder directory per host platform; a path pointing at ContentBuilder itself or straight at one
// of them are both things a person reasonably sets, so both are accepted.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { die } from "./config.mjs";

export function defaultBuilder() {
  return join(homedir(), "dev", "steamworks-sdk", "tools", "ContentBuilder");
}

export function findSteamcmd(env, { optional = false } = {}) {
  const base = env.STEAMWORKS_BUILDER || defaultBuilder();
  // THE HOST'S OWN BUILDER FIRST, because the SDK ships all three side by side and every one of
  // them exists on every box that unpacked it. Probing in a fixed order finds builder/steamcmd.exe
  // on a Mac — a Windows binary, picked because it happened to be listed first, and one that fails
  // at exec with a message about file formats rather than anything to do with Steam.
  const host = {
    win32: [join(base, "builder", "steamcmd.exe")],
    darwin: [
      join(base, "builder_osx", "steamcmd"),
      join(base, "builder_osx", "Steam.AppBundle", "Steam", "Contents", "MacOS", "steamcmd"),
    ],
    linux: [join(base, "builder_linux", "steamcmd.sh"), join(base, "builder_linux", "steamcmd")],
  }[process.platform] || [];

  const candidates = [
    ...host,
    // STEAMWORKS_BUILDER pointing straight at one builder dir is a thing people set, and it is
    // then the answer whatever the host is.
    join(base, "steamcmd.exe"),
    join(base, "steamcmd.sh"),
    join(base, "steamcmd"),
    join(base, "Steam.AppBundle", "Steam", "Contents", "MacOS", "steamcmd"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  // A dry run's whole job is to show what WOULD be sent without touching Steam, so the tool it
  // would have been sent with not being installed is not a reason to refuse to show it.
  if (optional) return "";
  die(`steamcmd not found under ${base}.\n` +
    "    Download the Steamworks SDK and set STEAMWORKS_BUILDER to its\n" +
    "    tools/ContentBuilder directory (or to the builder* dir for this platform).");
}

// The macOS builder ships its own dylibs beside the binary and will not start without being told
// where they are; the other two need nothing.
export function steamcmdEnv(steamcmd, env) {
  const childEnv = { ...env };
  if (steamcmd.includes("builder_osx")) {
    const dir = join(steamcmd, "..");
    childEnv.DYLD_LIBRARY_PATH = dir;
    childEnv.DYLD_FRAMEWORK_PATH = dir;
    childEnv.ULIMIT = "2048";
  }
  return childEnv;
}
