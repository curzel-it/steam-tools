// launch-linux.sh, RUN RATHER THAN READ.
//
// The bug this launcher exists to prevent is a build that starts and dies with no window and no
// error, and the thing that hid it for two rounds in the project it came from was a green test
// suite: the policy was checked as a pure decision table while the code that delivered it could
// never run. A grep for "--no-sandbox" in a shell script would be that test again. So the real file
// is copied into a temp directory beside a stub that prints its argv, and every rung is taken for
// real.
//
// What cannot be checked here: rung 1, which needs a chrome-sandbox owned by root with the setuid
// bit — unavailable without privileges, and a Steam depot cannot produce one either, which is the
// whole reason the other two rungs exist. Its NEGATIVE is checked, since that is the case a depot
// really delivers: a chrome-sandbox present and merely executable must not be mistaken for a
// working one.
//
// ONE STUB, SYMLINKED EVERYWHERE, because macOS charges about 450ms to evaluate a newly created
// executable the first time it runs and nothing after that. It answers to two names — the game,
// and the `unshare` the launcher probes with — so the probe's verdict is a variable rather than a
// second file.

import { execFileSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, group, same, ROOT } from "./harness.mjs";

const LAUNCHER = join(ROOT, "launch-linux.sh");
const SCRIPT = readFileSync(LAUNCHER, "utf8").replace(/\r\n/g, "\n");

group("the launcher ships in a runnable state", () => {
  // THE EXEC BIT HAS TO BE IN GIT. SteamPipe preserves it and electron-builder copies it, but
  // nothing in between would put it back — a project that ships this file without one has a depot
  // whose launch option cannot be run at all.
  ok((statSync(LAUNCHER).mode & 0o111) !== 0, "the launcher is tracked executable");
  ok(SCRIPT.startsWith("#!/bin/sh\n"), "and asks for a shell that exists on every distro");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  ok((pkg.files || []).includes("launch-linux.sh"),
    "and npm packs it, so a consumer can point extraFiles straight into node_modules");
});

if (process.platform === "win32") {
  console.log("the launcher decides (skipped — no /bin/sh)");
} else {
  group("the launcher finds the binary it wraps", () => {
    const root = mkdtempSync(join(tmpdir(), "steam-tools-"));
    try {
      const stub = join(root, "stub.sh");
      writeFileSync(stub, "#!/bin/sh\n"
        + 'case "${0##*/}" in unshare) exit "${STUB_UNSHARE:-1}" ;; esac\n'
        + `printf '%s\\n' "$@"\n`);
      chmodSync(stub, 0o755);

      // AN ELECTRON-BUILDER --dir OUTPUT, as far as this script can tell one: the game binary, the
      // two Chromium helpers that are also extension-less and also executable, Chromium's LICENSE,
      // and a pile of files with dots in their names.
      const install = (name, { launcher = "launch-linux.sh", binaries = ["the-game"] } = {}) => {
        const dir = join(root, name);
        mkdirSync(dir);
        writeFileSync(join(dir, launcher), SCRIPT);
        for (const bin of binaries) symlinkSync(stub, join(dir, bin));
        for (const helper of ["chrome-sandbox", "chrome_crashpad_handler"]) {
          writeFileSync(join(dir, helper), "");
          chmodSync(join(dir, helper), 0o755);
        }
        writeFileSync(join(dir, "LICENSE"), "");
        for (const noise of ["libEGL.so", "resources.pak", "v8_context_snapshot.bin"]) {
          writeFileSync(join(dir, noise), "");
        }
        mkdirSync(join(dir, "resources"));
        return dir;
      };

      const probe = join(root, "probe");
      mkdirSync(probe);
      symlinkSync(stub, join(probe, "unshare"));

      const BASE = { ...process.env, PATH: `${probe}:${process.env.PATH}` };
      delete BASE.STEAM_TOOLS_SANDBOX;
      delete BASE.STEAM_TOOLS_EXE;
      delete BASE.STUB_UNSHARE;

      const launch = (dir, { env = {}, args = [], launcher = "launch-linux.sh" } = {}) => {
        const out = execFileSync("/bin/sh", [join(dir, launcher), ...args], {
          encoding: "utf8",
          env: { ...BASE, ...env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        return out.split("\n").filter(Boolean);
      };
      const fails = (dir, opts) => {
        try {
          launch(dir, opts);
        } catch (e) {
          return { status: e.status, stderr: String(e.stderr) };
        }
        return { status: 0, stderr: "" };
      };

      const NOTHING = { STUB_UNSHARE: "1" };
      const NAMESPACES = { STUB_UNSHARE: "0" };

      // THE POINT OF THE SEARCH: this file is shipped unmodified by projects whose executables are
      // named differently, so it may not name one.
      ok(same(launch(install("a"), { env: NOTHING }), ["--no-sandbox"]),
        "one executable with no dot in its name, among the helpers and the .so files, is the game");

      // THE OTHER SHAPE IN THE WILD: the launcher takes the product's name and the binary is
      // suffixed, so the script must not find itself.
      const named = install("b", { launcher: "the-game", binaries: ["the-game-bin"] });
      ok(same(launch(named, { env: NOTHING, launcher: "the-game" }), ["--no-sandbox"]),
        "a launcher shipped under the product's own name does not launch itself");

      // AMBIGUITY IS AN ERROR, NOT A GUESS. Launching the wrong one is a window that never opens.
      const two = fails(install("c", { binaries: ["the-game", "other-thing"] }), { env: NOTHING });
      ok(two.status === 1, "two candidates stop the launch");
      ok(two.stderr.includes("the-game") && two.stderr.includes("other-thing"),
        "and both are named, so the fix is one STEAM_TOOLS_EXE away");

      const none = fails(install("d", { binaries: [] }), { env: NOTHING });
      ok(none.status === 1 && none.stderr.includes("no game binary"),
        "and nothing to launch is said out loud rather than exec'd into a shell error");

      // THE EXEC BIT IS THE TIEBREAK, NOT THE FILTER. SteamPipe keeps it, but a binary that
      // somehow arrived without one should be repaired rather than reported missing — the failure
      // it produces is the same silent one.
      const stripped = install("e", { binaries: [] });
      copyFileSync(stub, join(stripped, "the-game"));
      chmodSync(join(stripped, "the-game"), 0o644);
      ok(same(launch(stripped, { env: NOTHING }), ["--no-sandbox"]),
        "a binary that lost its execute bit is found, restored and launched");

      // AND THE OVERRIDE FOR A LAYOUT NOBODY ANTICIPATED.
      ok(same(launch(install("f", { binaries: ["the-game", "other-thing"] }),
        { env: { ...NOTHING, STEAM_TOOLS_EXE: "other-thing" } }), ["--no-sandbox"]),
        "STEAM_TOOLS_EXE picks one out of a directory the search would refuse");
      const wrong = fails(install("g"), { env: { ...NOTHING, STEAM_TOOLS_EXE: "not-here" } });
      ok(wrong.status === 1 && wrong.stderr.includes("not-here"),
        "and naming something that is not there fails loudly instead of falling back");

      group("the launcher decides which sandbox it can have", () => {
        const GAME = install("h");

        // RUNG 3 — Flatpak Steam, Ubuntu 24.04's AppArmor restriction, a hardened kernel. Nothing
        // will sandbox, so the choice is --no-sandbox or a build that shows the player nothing.
        ok(same(launch(GAME, { env: NOTHING }), ["--no-sandbox"]),
          "with no namespaces and no setuid helper it gives up the sandbox rather than the window");

        // RUNG 2 — where a normal Linux Steam install lands. Only the setuid helper is turned off,
        // and the renderer stays confined.
        ok(same(launch(GAME, { env: NAMESPACES }), ["--disable-setuid-sandbox"]),
          "where namespaces work it turns off only the helper");

        // RUNG 1'S NEGATIVE, and the case a depot really delivers: chrome-sandbox is right there
        // and executable, and it is still not a sandbox. Taking it would abort before the window.
        ok(!same(launch(GAME, { env: NOTHING }), []),
          "a chrome-sandbox present but not setuid root is not mistaken for a working one");

        // THE OVERRIDE, BOTH WAYS. It is what a player with a dead launch puts in Steam's Launch
        // Options tonight.
        ok(same(launch(GAME, { env: { ...NOTHING, STEAM_TOOLS_SANDBOX: "1" } }), []),
          "STEAM_TOOLS_SANDBOX=1 asks for the full sandbox and gets no flag at all");
        ok(same(launch(GAME, { env: { ...NAMESPACES, STEAM_TOOLS_SANDBOX: "0" } }), ["--no-sandbox"]),
          "STEAM_TOOLS_SANDBOX=0 gives it up on a machine that could have had it");
        ok(same(launch(GAME, { env: { ...NAMESPACES, STEAM_TOOLS_SANDBOX: "yes" } }),
          ["--disable-setuid-sandbox"]), "and a value it does not recognise decides nothing");

        // %command% ARGUMENTS SURVIVE, in order and unsplit. Steam appends them.
        ok(same(launch(GAME, { env: NAMESPACES, args: ["--remote-debugging-port=9222", "a b"] }),
          ["--disable-setuid-sandbox", "--remote-debugging-port=9222", "a b"]),
          "and what Steam appends arrives after the flag, in order, still one argument");

        // NO PROBE AT ALL is the same answer as a probe that says no — 127 and 1 are both "cannot
        // prove it". Worth taking for real: an `unshare` this machine has never heard of must not
        // take `set -e` down with it, which would be a launcher that exits before the game.
        const dirname = ["/usr/bin/dirname", "/bin/dirname"].find((p) => existsSync(p));
        if (dirname) {
          const bare = join(root, "bare");
          mkdirSync(bare);
          symlinkSync(dirname, join(bare, "dirname"));
          ok(same(launch(GAME, { env: { PATH: bare } }), ["--no-sandbox"]),
            "a machine with no unshare on it launches anyway");
        }
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
