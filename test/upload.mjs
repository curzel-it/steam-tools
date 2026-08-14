// The upload's four decisions, taken without a network: where the ids come from, what is on disk,
// whether the packages agree, and what steamcmd is handed.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, group, same } from "./harness.mjs";
import { asarContents, compareBuilds, findAsar } from "../src/asar.mjs";
import { loadConfig, loadEnv } from "../src/config.mjs";
import { findDistDirs } from "../src/dist.mjs";
import { buildVdf } from "../src/vdf.mjs";

const dirs = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "steam-tools-"));
  dirs.push(dir);
  return dir;
};
const write = (path, body) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

// An asar as far as the reader in src/asar.mjs is concerned: the header JSON's length at offset 12
// and the JSON itself at 16. The three uint32s before it are the pickle framing electron's own
// writer emits and nothing here reads.
const fakeAsar = (files) => {
  const json = Buffer.from(JSON.stringify({ files }), "utf8");
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(json.length + 8, 4);
  head.writeUInt32LE(json.length + 4, 8);
  head.writeUInt32LE(json.length, 12);
  return Buffer.concat([head, json]);
};
const file = (hash) => ({ size: 10, integrity: { algorithm: "SHA256", hash } });

try {
  group("where the ids come from", () => {
    const root = temp();
    write(join(root, "package.json"), {
      name: "the-game", version: "1.2.3",
      build: {
        productName: "The Game",
        linux: { extraFiles: [{ from: "electron/launch-linux.sh", to: "launch-linux.sh" }] },
      },
    });
    write(join(root, "steam.config.json"), {
      appId: "480", package: "1234", depots: { win: "481", mac: "482", linux: "483" },
    });

    const cfg = loadConfig(root, loadEnv(root));
    ok(cfg.appId === "480" && cfg.depots.linux === "483", "steam.config.json, when there is one");
    ok(cfg.name === "The Game", "the build list gets productName, not the npm package name");
    ok(cfg.version === "1.2.3", "and the version is package.json's, which is where it already is");
    ok(cfg.macArch === "arm64", "the mac package defaults to Apple Silicon");
    ok(cfg.dist === join(root, "dist"), "and dist/ is where electron-builder leaves things");

    // THE EXCLUSION IS READ, NOT NAMED, so a second extraFile cannot silently disarm the
    // same-build check by making two packages legitimately differ somewhere nobody listed.
    ok(cfg.extraFiles.has("electron/launch-linux.sh"),
      "what electron-builder lifts out of the asar comes from package.json");

    // THE ENVIRONMENT WINS, which is what a second store page or a branch app wants.
    const env = { ...loadEnv(root), STEAM_APP_ID: "999", STEAM_DEPOT_LINUX: "998" };
    const over = loadConfig(root, env);
    ok(over.appId === "999", "and an override in the environment beats the file");

    // A PROJECT THAT WOULD RATHER NOT GROW A FILE. Same fields, under a "steam" key.
    const inline = temp();
    write(join(inline, "package.json"), {
      name: "other", version: "0.1.0",
      steam: { appId: "570", depots: { win: "571" } },
    });
    ok(loadConfig(inline, loadEnv(inline)).appId === "570", "package.json's \"steam\" key does too");
    ok(loadConfig(inline, loadEnv(inline)).name === "other",
      "and a project with no productName is called what npm calls it");
  });

  group("what is on disk to upload", () => {
    const root = temp();
    write(join(root, "package.json"), { name: "g", version: "1.0.0" });
    write(join(root, "steam.config.json"), { appId: "480", depots: { win: "481", linux: "483" } });
    const cfg = loadConfig(root, loadEnv(root));

    mkdirSync(join(root, "dist", "win-unpacked"), { recursive: true });
    mkdirSync(join(root, "dist", "linux-unpacked"), { recursive: true });
    const found = findDistDirs(cfg);
    ok(same(Object.keys(found).sort(), ["linux", "win"]),
      "a box that cannot build a Mac package uploads the two it can");
    ok(found.win === "win-unpacked",
      "named relative to the content root, in the slashes steamcmd wants");

    // A .app IS WHAT MAKES A mac-* FOLDER A MAC PACKAGE. An empty one is a leftover directory.
    mkdirSync(join(root, "dist", "mac-arm64"), { recursive: true });
    ok(!findDistDirs(cfg).mac, "an empty mac-arm64 is not a package");
    mkdirSync(join(root, "dist", "mac-arm64", "The Game.app"), { recursive: true });
    ok(findDistDirs(cfg).mac === "mac-arm64", "and one with a bundle in it is");
  });

  group("whether the packages agree", () => {
    const root = temp();
    // Windows and Linux keep the archive under resources/; the macOS one is inside the bundle,
    // whose name has a space in it and is therefore found rather than spelled.
    write(join(root, "win-unpacked", "resources", "app.asar"), fakeAsar({ "main.js": file("aaa") }));
    write(join(root, "mac-arm64", "The Game.app", "Contents", "Resources", "app.asar"),
      fakeAsar({ "main.js": file("aaa") }));
    ok(findAsar(join(root, "win-unpacked")).endsWith("app.asar"), "the archive is found on windows");
    ok(findAsar(join(root, "mac-arm64")).includes(".app"), "and inside the bundle on macOS");
    ok(!findAsar(join(root, "nowhere")), "and a folder that is not there is not an error");

    const nested = asarContents(join(root, "win-unpacked", "resources", "app.asar"));
    ok(nested.get("main.js") === "aaa", "a file's hash comes out of the header, unpacking nothing");

    write(join(root, "deep.asar"), fakeAsar({
      src: { files: { "a.js": file("h1"), "b.js": { size: 4 } } },
    }));
    const deep = asarContents(join(root, "deep.asar"));
    ok(deep.get("src/a.js") === "h1", "nested folders come out as paths");
    ok(deep.get("src/b.js") === "size:4",
      "and a file with no integrity block falls back to its size rather than vanishing");

    const win = new Map([["main.js", "aaa"], ["launcher.sh", "lll"]]);
    const mac = new Map([["main.js", "aaa"], ["launcher.sh", "lll"]]);
    ok(compareBuilds({ win, mac }).length === 0, "two packages of one build agree everywhere");
    ok(compareBuilds({ win }).length === 0, "and one platform has nothing to disagree with");

    const stale = new Map([["main.js", "bbb"], ["launcher.sh", "lll"]]);
    const bad = compareBuilds({ win, mac: stale });
    ok(bad.length === 1 && bad[0][0] === "main.js", "a stale folder is caught on the file that moved");
    ok(same(bad[0][1], ["aaa", "bbb"]), "with both hashes, so the odd one out is visible");

    // THE CASE THAT MADE THIS PER-FILE. A launcher that is an extraFile on Linux and only there is
    // absent from that asar and present in the others — a correct build, and one that a
    // whole-archive hash would reject on every upload forever.
    const linux = new Map([["main.js", "aaa"]]);
    ok(compareBuilds({ win, linux }).length === 1, "a file only one platform lifts out looks like a mismatch");
    ok(compareBuilds({ win, linux }, new Set(["launcher.sh"])).length === 0,
      "until the exclusion read from package.json says it is meant to be");
  });

  group("what steamcmd is handed", () => {
    const vdf = buildVdf({
      appId: "480",
      depots: { win: "481", linux: "483" },
      desc: "The Game 1.2.3 (abc1234)",
      dirs: { win: "win-unpacked", linux: "linux-unpacked" },
      contentRoot: "C:\\proj\\dist",
      buildOutput: "C:\\proj\\temp",
    });
    ok(vdf.includes('"AppID" "480"'), "the app it is going to");
    ok(vdf.includes('"481"') && vdf.includes('"483"'), "a depot block per platform in the build");
    ok(!vdf.includes('"482"'), "and none for a platform this build does not carry");
    ok(vdf.includes('"LocalPath" "win-unpacked/*"'), "each depot's folder, relative to the content root");
    ok(vdf.includes('"recursive" "1"'), "recursive, so a .app wrapper survives the trip");
    ok(vdf.includes('"ContentRoot" "C:/proj/dist"'),
      "and Windows paths arrive with the slashes steamcmd reads, not the ones the shell does");
    ok(!vdf.includes("SetLive"),
      "nothing is promoted by default — a build lands unpromoted and is looked at first");

    const live = buildVdf({
      appId: "480", depots: { win: "481" }, desc: "d", dirs: { win: "win-unpacked" },
      contentRoot: "/p/dist", buildOutput: "/p/temp", live: "smoketest",
    });
    ok(live.includes('"SetLive" "smoketest"'), "and a branch is set live only when one is asked for");
  });
} finally {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
