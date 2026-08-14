# steam-tools

The two parts of shipping an Electron game on Steam that are the same in every project:

- **`steam-upload`** — package the desktop builds, send them to SteamPipe, refuse to send a broken
  set.
- **`launch-linux.sh`** — the Linux depot's entry point, which decides how much sandbox Chromium can
  actually have on the player's machine instead of assuming.

No dependencies, runtime or dev. Node ≥ 18 and `/bin/sh`.

```bash
npm i -D github:curzel-it/steam-tools
```

## The Linux launcher, and why a depot needs one

Electron ships a helper called `chrome-sandbox` that has to be owned by root with the setuid bit.
**A Steam depot cannot carry the setuid bit**, and the client that unpacks it is not root, so it
could not restore one anyway. Chromium then refuses to start:

```
FATAL:setuid_sandbox_host.cc The SUID sandbox helper binary was found, but is not
configured correctly. Rather than run without sandboxing I'm aborting now.
```

That goes to stderr, **which Steam shows nobody**. The player presses Play, the status flips Running
then Stopped, no window ever appears. It does not reproduce on your desktop — there `chrome-sandbox`
still has its bit from the tarball — which is what makes it a launch-day bug.

It also **cannot be fixed from JavaScript**. Chromium sets its sandbox up during early startup,
before the Electron main script is evaluated, so `app.commandLine.appendSwitch("no-sandbox")` is too
late and cannot even print that it fired ([electron#20063](https://github.com/electron/electron/issues/20063)).
The flag has to be on argv, which is why this is a shell script.

`launch-linux.sh` measures, three rungs, best first:

| What the machine has | It launches with | Who lands here |
|---|---|---|
| `chrome-sandbox` setuid **and** root-owned | nothing — the full sandbox | never a Steam install; a tarball unpacked by hand |
| unprivileged user namespaces | `--disable-setuid-sandbox` | a normal Linux Steam install |
| neither | `--no-sandbox` | Flatpak Steam (Bazzite, Nobara, most Fedora software centres), Ubuntu 24.04's AppArmor restriction, hardened kernels |

The bottom row is the one that matters: without it Chromium finds no usable sandbox and aborts. The
middle row is why the flag is not simply always `--no-sandbox` — where the namespace sandbox works,
a renderer configured with `sandbox: true` stays confined. **Rung 2 is asked, not assumed**: the
sysctls can say namespaces are allowed while the runtime the game is inside still denies the
syscall, so the probe is an actual `unshare`. Anything it cannot prove falls to rung 3, which is the
direction for a wrong answer to be wrong in — that one still plays.

### Shipping it

Point `extraFiles` straight into `node_modules`, so the launcher updates with the dependency:

```json
{
  "build": {
    "linux": {
      "target": [{ "target": "dir", "arch": ["x64"] }],
      "executableName": "the-game",
      "extraFiles": [
        { "from": "node_modules/@curzel-it/steam-tools/launch-linux.sh", "to": "launch-linux.sh" }
      ]
    }
  }
}
```

Then in Steamworks → *Installation* → *General Installation*, set the **Linux launch option to
`launch-linux.sh`, not the binary**. That field is the whole delivery mechanism; getting it wrong
reproduces the original bug exactly.

Some projects prefer the script to *be* the product name (`the-game` launching `the-game-bin`), so
the existing launch option keeps working. Both shapes are supported — the script finds the binary
beside it rather than naming one: every plain file with no dot in its name that is not the script
itself and not one of Chromium's own helpers. In an electron-builder `--dir` output that is exactly
one file. If a layout ever makes that untrue, `STEAM_TOOLS_EXE` names it outright, and an ambiguous
directory is an error listing what it saw rather than a guess.

### When a player's window never opens

`STEAM_TOOLS_SANDBOX` overrides the measurement — `1` forces the full sandbox, `0` forces
`--no-sandbox`. A player can put it in Steam's *Launch Options* as `STEAM_TOOLS_SANDBOX=0 %command%`,
which is the answer to give while a fix uploads.

To see which rung a machine took:

```bash
sh -x ~/.local/share/Steam/steamapps/common/Your\ Game/launch-linux.sh
```

And read the exit code from `~/.steam/steam/logs/gameprocess_log.txt` before anything else:

| Exit code | Meaning |
|---|---|
| `0` | the game ran and quit normally |
| `133` | Chromium aborted — the sandbox is implicated, this is your problem |
| `255` | the game never ran — Steam's own launch layer is. **Restart the Steam client first**: a client session older than the installed build can hold stale launch state, and that has been the entire fix after hours spent instrumenting the wrapper chain |

## The upload

```bash
npx steam-upload                    # upload, promote nothing
npx steam-upload --print            # print the build.vdf, connect to nothing
npx steam-upload --live smoketest   # upload and set it live on a branch
npx steam-upload --root path/to/project
```

Call it directly rather than through `npm run x -- --flag`: npm's PowerShell shim drops arguments
after `--`, and losing `--print` means doing the upload for real.

### Configuration

`steam.config.json` at the project root — or a `"steam"` key in `package.json` for a project that
would rather not grow a file:

```json
{
  "appId": "480",
  "package": "1234",
  "name": "Your Game",
  "depots": { "win": "481", "mac": "482", "linux": "483" },
  "macArch": "arm64"
}
```

| Field | Meaning |
|---|---|
| `appId` | required |
| `depots` | required for each platform you upload; missing ones are simply not in the build |
| `package` | optional. Never used — printed as a reminder, because **a depot created after the app is not added to its package automatically**, and a depot outside the package uploads perfectly and reaches nobody |
| `name` | build-list label. Defaults to `build.productName`, then the npm package name |
| `macArch` | which `dist/mac-*` folder is yours. Default `arm64` |
| `dist`, `temp` | output folders. Default `build.directories.output` (or `dist`) and `temp` |

**Ids are not secrets** — an AppID is in the store URL and a depot id is visible to anyone who owns
the game. Commit them, and a fresh clone can upload. The credential is the part that stays out:

```bash
STEAM_USERNAME=you            # required, in .env
STEAM_PASSWORD=...            # optional — omit it (see below)
STEAMWORKS_BUILDER=...        # path to the SDK's tools/ContentBuilder. Default: ~/dev/steamworks-sdk/tools/ContentBuilder
STEAM_APP_ID=... STEAM_DEPOT_WIN=... STEAM_DEPOT_MAC=... STEAM_DEPOT_LINUX=...
```

Run `steamcmd +login <user>` by hand once and answer the Steam Guard prompt. steamcmd caches a
sentinel, and every run after that needs only the username — no password ever passes through this
tool. The env vars override the config file, which is what a second store page or a branch app
wants.

The build description is `<name> <version> (<git sha>)`. **The commit is worth more than the version
string there**: a version can sit unchanged for a long time, and the thing you want to know six
builds later is which tree it was.

### What it refuses to do

- **Upload platform folders from different builds.** The packages going up are compared file by
  file inside their `app.asar` before anything is sent. This is the one worth knowing about: running
  electron-builder for a subset over an existing `dist/` — the normal way to work, since a Mac
  package can only be built on a Mac — leaves the other platforms' folders behind. steamcmd then
  reports success on every depot, Steam dedupes the unchanged content away, and the fix never
  reaches the players on the stale one. It is invisible without this check.

  The comparison is per file rather than one hash of the archive, because a launcher shipped as an
  `extraFiles` entry on Linux and only there sits *inside* the Windows and macOS asars and *outside*
  the Linux one — a correct build never matches byte for byte. The exclusions are read back out of
  `package.json`, so a second `extraFiles` entry cannot silently disarm the check.

- **Upload a macOS package for the wrong architecture.** A leftover `dist/mac` from an older x64
  build sorts ahead of `dist/mac-arm64` and would install and run under Rosetta on the Apple Silicon
  Mac that pushed it, without a word.

- **Accept an id that is not one.** An `STEAM_APP_ID` override that does not look like a Steam id
  stops the run rather than falling back to the real app. It is the one mistake here with a public
  blast radius.

- **Promote anything by default.** A build lands in Steamworks unpromoted; `--live` takes a branch,
  and Steam rejects `SetLive` on the default branch anyway, so shipping to everyone stays a
  deliberate click in the UI.

It runs on any of the three hosts — it probes for whichever steamcmd the box has, so a Windows or
Linux machine can push the depots it can build without borrowing a Mac.

**It does not sign anything.** Windows and Linux depots do not need it. The macOS `.app` does — an
unsigned, un-notarized bundle is the one real risk in a desktop build — and that has to happen on a
Mac, before this runs. Verify the copy *Steam installed*, not `dist/`:

```bash
codesign --verify --deep --strict ~/Library/Application\ Support/Steam/steamapps/common/Your\ Game/Your\ Game.app
```

## Tests

```bash
npm test
```

No framework, no network, no Steam. The launcher is copied into a temp directory beside a stub that
prints its argv and every branch is taken for real, because a grep for `--no-sandbox` in a shell
script is exactly the kind of green check that hid this bug in the first place. The refusals are
checked as exit codes, against a throwaway project.

What no check here can answer is whether the window actually opens on a Steam install. That needs a
Linux box; everything short of it is necessary and not sufficient.

## License

MIT.
