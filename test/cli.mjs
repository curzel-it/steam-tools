// The whole thing, end to end, against a project that exists only for the length of this file.
// Spawned rather than imported because half of what is being checked is a refusal, and a refusal
// here is an exit code — the point of the guards is that they stop an upload, not that they log.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, group, ROOT } from "./harness.mjs";

const CLI = join(ROOT, "bin", "steam-upload.mjs");
const roots = [];

const fakeAsar = (hash) => {
  const json = Buffer.from(JSON.stringify({ files: { "main.js": { size: 10, integrity: { hash } } } }), "utf8");
  const head = Buffer.alloc(16);
  head.writeUInt32LE(json.length, 12);
  return Buffer.concat([head, json]);
};

// A packaged project: two platforms, each with an app.asar whose contents are given per platform
// so a stale folder can be spelled out.
const project = ({ hashes = { win: "aaa", linux: "aaa" }, config = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "steam-tools-cli-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "the-game", version: "1.2.3", build: { productName: "The Game" },
  }));
  if (config) {
    writeFileSync(join(root, "steam.config.json"), JSON.stringify({
      appId: "480", package: "1234", depots: { win: "481", mac: "482", linux: "483" },
    }));
  }
  for (const [platform, hash] of Object.entries(hashes)) {
    const dir = join(root, "dist", `${platform}-unpacked`, "resources");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "app.asar"), fakeAsar(hash));
  }
  return root;
};

const run = (root, args = [], env = {}) => {
  const child = { ...process.env, STEAM_USERNAME: "someone", ...env };
  for (const [k, v] of Object.entries(env)) if (v === null) delete child[k];
  const out = spawnSync(process.execPath, [CLI, "--root", root, ...args], {
    encoding: "utf8", env: child,
  });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
};

try {
  group("a dry run says exactly what would go up", () => {
    const root = project();
    const { status, stdout } = run(root, ["--print"]);
    ok(status === 0, "it exits clean without steamcmd installed — that is what a dry run is for");
    ok(stdout.includes("The Game 1.2.3 -> Steam app 480"), "the product, the version and the app");
    ok(stdout.includes('"481"') && stdout.includes('"483"'), "a depot block for each platform present");
    ok(stdout.includes("NOT in this build: mac"),
      "and the platform with no folder is named rather than quietly left out");
    ok(!existsSync(join(root, "temp")),
      "nothing is written — a dry run that left a build.vdf behind would be a lie");

    const live = run(root, ["--print", "--live", "smoketest"]).stdout;
    ok(live.includes('"SetLive" "smoketest"'), "and --live puts the branch in the script");
    ok(!run(root, ["--print"]).stdout.includes("SetLive"), "while the default promotes nothing");
  });

  group("what stops an upload", () => {
    // THE ONE THAT MATTERS. steamcmd would report success on every depot and Steam would dedupe
    // the unchanged content away, so this is the only place the mistake is visible.
    const stale = run(project({ hashes: { win: "aaa", linux: "bbb" } }), ["--print"]);
    ok(stale.status === 1, "platform folders from different builds do not go up");
    ok(stale.stderr.includes("different builds") && stale.stderr.includes("main.js"),
      "and the file that disagrees is named");

    const one = run(project({ hashes: { win: "aaa" } }), ["--print"]);
    ok(one.status === 0, "while a single-platform build has nothing to disagree with and is fine");

    const nameless = run(project(), ["--print"], { STEAM_USERNAME: null });
    ok(nameless.status === 1 && nameless.stderr.includes("STEAM_USERNAME"),
      "a missing login is caught before anything is packed up");

    const unconfigured = run(project({ config: false }), ["--print"]);
    ok(unconfigured.status === 1 && unconfigured.stderr.includes("steam.config.json"),
      "and a project that has never been configured is told what to write");

    const wrongId = run(project(), ["--print"], { STEAM_APP_ID: "not-a-number" });
    ok(wrongId.status === 1 && wrongId.stderr.includes("not a Steam id"),
      "an override that is not an id stops the run rather than falling back to the real app");
  });
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
