# steam-tools

The parts of shipping an Electron game on Steam that are the same in every project:

- `steam-upload`: package the desktop builds, send them to SteamPipe, refuse to send a broken set.
- `steam-artwork`: cut the store page's eight capsules out of one piece of key art.
- `launch-linux.sh`: the Linux depot's entry point, which picks the sandbox mode Chromium can
  actually use on the player's machine.

No dependencies, runtime or dev. Node ≥ 18 and `/bin/sh`.

```bash
npm i -D github:curzel-it/steam-tools
```

## The Linux launcher

Electron's `chrome-sandbox` helper needs the setuid bit and root ownership. A Steam depot cannot
carry that bit, so Chromium aborts on startup:

```
FATAL:setuid_sandbox_host.cc The SUID sandbox helper binary was found, but is not
configured correctly. Rather than run without sandboxing I'm aborting now.
```

Steam shows that stderr to nobody, so the player only sees Running flip to Stopped. It does not
reproduce from a hand-unpacked tarball, where the bit survives, and it cannot be fixed from
JavaScript: Chromium sets up the sandbox before the main script runs, so
`appendSwitch("no-sandbox")` is too late
([electron#20063](https://github.com/electron/electron/issues/20063)). The flag has to be on argv,
which is why this is a shell script.

`launch-linux.sh` takes the first rung that works:

| What the machine has | Launches with | Who lands here |
|---|---|---|
| `chrome-sandbox` setuid and root-owned | nothing, so the full sandbox | a tarball unpacked by hand, never a Steam install |
| unprivileged user namespaces | `--disable-setuid-sandbox` | a normal Linux Steam install |
| neither | `--no-sandbox` | Flatpak Steam (Bazzite, Nobara, most Fedora software centres), Ubuntu 24.04's AppArmor restriction, hardened kernels |

Rung 2 keeps `sandbox: true` renderers confined, which is why the launcher does not always pass
`--no-sandbox`. It probes with a real `unshare` rather than reading sysctls, since the runtime the
game is inside can deny the syscall anyway. Anything unproven drops to rung 3, which still launches.

### Shipping it

Point `extraFiles` into `node_modules` so the launcher updates with the dependency:

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

Then set the Linux launch option in Steamworks (Installation → General Installation) to
`launch-linux.sh`, not the binary.

The script finds the binary beside it: the one extensionless plain file that is not the script or a
Chromium helper. Naming the script after the product works too, with `the-game` launching
`the-game-bin`. `STEAM_TOOLS_EXE` names the binary directly, and an ambiguous directory is an error
listing what it found.

### Debugging

`STEAM_TOOLS_SANDBOX=1` forces the full sandbox, `0` forces `--no-sandbox`. A player can set it in
Steam's Launch Options as `STEAM_TOOLS_SANDBOX=0 %command%`. To see which rung a machine takes:

```bash
sh -x ~/.local/share/Steam/steamapps/common/Your\ Game/launch-linux.sh
```

Check the exit code in `~/.steam/steam/logs/gameprocess_log.txt` first. `133` is Chromium aborting,
so the sandbox is involved. `255` means the game never started: restart the Steam client, since a
session older than the installed build holds stale launch state.

## The upload

```bash
npx steam-upload                    # upload, promote nothing
npx steam-upload --print            # print the build.vdf, connect to nothing
npx steam-upload --live smoketest   # upload and set it live on a branch
npx steam-upload --root path/to/project
```

Call it directly, not through `npm run x -- --flag`: npm's PowerShell shim drops arguments after
`--`, and losing `--print` means uploading for real. It runs on any of the three hosts, probing for
whichever steamcmd is installed.

### Configuration

`steam.config.json` at the project root, or a `"steam"` key in `package.json`:

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
| `depots` | required per platform you upload; missing ones are not in the build |
| `package` | optional and unused, printed as a reminder: a depot created after the app is not added to its package automatically, and a depot outside the package uploads fine and reaches nobody |
| `name` | build-list label. Defaults to `build.productName`, then the npm package name |
| `macArch` | which `dist/mac-*` folder is yours. Default `arm64` |
| `dist`, `temp` | output folders. Default `build.directories.output` (or `dist`) and `temp` |

Ids are not secrets, since an AppID is in the store URL and a depot id is visible to anyone who owns
the game. Commit them and a fresh clone can upload. The credentials stay out:

```bash
STEAM_USERNAME=you            # required, in .env
STEAM_PASSWORD=...            # optional, see below
STEAMWORKS_BUILDER=...        # path to the SDK's tools/ContentBuilder. Default: ~/dev/steamworks-sdk/tools/ContentBuilder
STEAM_APP_ID=... STEAM_DEPOT_WIN=... STEAM_DEPOT_MAC=... STEAM_DEPOT_LINUX=...
```

Run `steamcmd +login <user>` once by hand to answer the Steam Guard prompt. It caches a sentinel, so
later runs need only the username. The env vars override the config file, which is what a second
store page or a branch app wants.

The build description is `<name> <version> (<git sha>)`. The sha matters more than the version, which
can sit unchanged across many builds.

### What it refuses to do

- **Upload platform folders from different builds.** The packages are compared file by file inside
  their `app.asar` first. Rebuilding one platform over an existing `dist/` (normal, since a Mac
  package needs a Mac) leaves the others stale, steamcmd reports success on every depot, Steam
  dedupes the unchanged content away, and the fix never reaches those players. The comparison is per
  file because a Linux-only `extraFiles` launcher sits inside the Windows and macOS asars and outside
  the Linux one, so a correct build never matches byte for byte. Exclusions are read from
  `package.json`, so a second `extraFiles` entry cannot quietly disarm the check.

- **Upload a macOS package for the wrong architecture.** A leftover `dist/mac` from an older x64
  build sorts ahead of `dist/mac-arm64` and would run under Rosetta on the Mac that pushed it.

- **Accept an id that is not one.** A `STEAM_APP_ID` that does not look like a Steam id stops the run
  instead of falling back to the real app.

- **Promote anything by default.** Builds land unpromoted; `--live` takes a branch, and Steam rejects
  SetLive on the default branch.

It signs nothing. Windows and Linux do not need it; the macOS `.app` does, on a Mac, before this
runs. Verify the copy Steam installed, not `dist/`:

```bash
codesign --verify --deep --strict ~/Library/Application\ Support/Steam/steamapps/common/Your\ Game/Your\ Game.app
```

## The artwork

Steamworks wants the same key art at eight sizes in five shapes. `steam-artwork` cuts all eight out
of one image.

```bash
npx steam-artwork                                   # write them all
npx steam-artwork --print                           # plan only, write nothing
npx steam-artwork --only library_hero,small_capsule
npx steam-artwork --source art/keyart.png --out steam
npx steam-artwork --list                            # the sizes, and the two done by hand
```

| Asset | Size | Where it shows |
|---|---|---|
| `header_capsule` | 920×430 | top of the store page, and the library grid |
| `small_capsule` | 462×174 | every list — search, top sellers, new releases |
| `main_capsule` | 1232×706 | the featured carousel on the front page |
| `vertical_capsule` | 748×896 | seasonal sale pages |
| `page_background` | 1438×810 | behind the store page; Steam tints and fades it |
| `library_capsule` | 600×900 | the player's library and collections |
| `library_header` | 920×430 | the library's recent games row |
| `library_hero` | 3840×1240 | top of the library detail page |

Filenames carry their dimensions (`header_capsule_920x430.png`), because there are two 920×430
fields in Steamworks and four assets whose names all start with "capsule".

**Two of the nine assets Steamworks asks for are not in that table, and the tool says so every run.**
Screenshots have to be actual gameplay, which rules out a marketing plate however much it looks like
the game; and the library logo is drawn on transparency, so there is nothing in a background to cut
out. Seven files in a folder look exactly like nine to whoever comes back to this in a month.

### What Steam asks of each one

**The tool gets the geometry right and can get nothing else right for you.** Most of what Steamworks
says about these assets is about their *content*, and a capsule that is the correct number of pixels
and breaks one of the rules below still gets rejected, or ships looking wrong. Condensed from the
Steamworks upload page, keeping the parts that change what you make rather than the encouragement.

Across the marketing capsules — header, small, main, vertical — Steam wants the same artwork and
logo you would put on physical packaging, and **no quotes, review scores or awards anywhere in the
image**.

- **Header capsule** — your branding, logo clear and legible. Also stands in for the library header
  if you never upload one.
- **Small capsule** — the only one with a hard content requirement: it must carry a logo that stays
  legible at every size it is drawn at, which in practice means **the logo very nearly fills it**.
  It is what every list on Steam shows, so it is read at a glance or not at all.
- **Main capsule** and **vertical capsule** — front page and seasonal sale pages. Marketing art.
- **Page background** — **keep it neutral.** Steam lays its own template over whatever you upload,
  tinting it blue and fading the edges, so it should not fight the page content: avoid high contrast
  and avoid text. Skip it and Steam picks one of your screenshots at random.
- **Library capsule** — artwork, logo, and the game's title, ideally the same title treatment as the
  packaging. **No text beyond the title.** The art should show something that matters about the
  game, and the logo has to stay legible over it. Steam derives the 300×450 from this.
- **Library header** — same look as the library capsule, logo legible.
- **Library hero** — **no text and no logo in it at all.** The logo is a separate upload that sits on
  its own layer and parallaxes over this one as the page scrolls, so anything drawn into the hero
  fights it. The image has to fill the whole 3840×1240, but only the centre **860×380 safe zone**
  survives every client window width — if a face or a ship has to be recognisable, it belongs
  entirely inside it. Steam derives the 1920×620 from this. (`steam-artwork` prints where that safe
  zone lands back in your source, in source pixels.)

And the two it does not make:

- **Screenshots** — five or more, widescreen 16:9, at least 1920×1080. **Gameplay only**: no concept
  art, no cutscene frames, no image carrying awards or marketing copy, and no menus unless a menu is
  genuinely a distinctive part of the game. Show the player's perspective and the genre; visible UI
  helps read both quickly. If the game has mature content, upload and flag at least four all-ages
  screenshots, because those are the ones Steam is allowed to show off your store page. Localised
  versions are matched by filename suffix — `foo_japanese.jpg`.
- **Library logo** — 1280 wide and/or 720 tall, PNG on a transparent background, in whatever aspect
  suits the mark. Steamworks has a preview tool for placing it over the hero: bottom-left,
  top-centre, middle-centre or bottom-centre. Upload neither this nor a hero and the library page
  falls back to a store screenshot with the app name typeset over the bottom-left corner.

### Configuration

An `artwork` block in `steam.config.json` (or in `package.json`'s `"steam"` key). Only `source` is
required; the defaults centre every rectangle and take as much of the picture as its shape allows.

```json
{
  "artwork": {
    "source": "art/keyart.png",
    "out": "steam",
    "focus": { "x": 0.5, "y": 0.5 },
    "assets": {
      "library_hero":    { "focus": { "y": 0.62 } },
      "small_capsule":   { "zoom": 1.8 },
      "page_background": { "fit": "native" }
    }
  }
}
```

| Key | Meaning |
|---|---|
| `focus` | 0..1 in the source, the point each rectangle centres on. Clamped so it stays inside |
| `zoom` | ≥ 1, tightens the rectangle. What a capsule read at a glance usually wants |
| `fit` | `cover` (default) takes as much of the picture as the shape allows; `native` takes the target size 1:1 where the source is big enough, for a capsule with no resampling in it |
| `crop` | an explicit rectangle in source pixels, **grown** to the target's shape rather than squashed into it |
| `skip` | leave this one out |
| `source` | a different plate for this one asset |

Anything under `assets` that is not an asset name, and any key inside one that is not an option
above, **stops the run**. A misspelling there is the worst kind of quiet failure: every capsule is
still produced, framed exactly as if nothing had been asked for.

### What it prints, and why

```
library_hero_3840x1240.png   crop 1920x620 at 0,230   2.000x nearest   UPSCALED
   safe zone covers source 745,445 to 1175,635 — keep what matters inside it
```

Every asset reports its crop, its scale and its resampling filter, whether or not anything is odd
about it. **The filter is chosen from the numbers, not configured.** An exact whole-number
enlargement is nearest neighbour, because a game render scaled 2× by anything that interpolates
comes back as mush; shrinking is a box filter, because dropping rows throws away the thin bright
lines that are the whole subject of a vector render; what is left over is bilinear.

`library_hero` is 3840 wide and almost no source is, so an enlargement is called out in capitals
rather than left to be noticed on the store page. It also prints where Steam's 860×380 safe zone —
all of the hero that survives at every client width — lands back in the source, so what will never
be cropped away can be checked in the plate.

The decoder takes any non-interlaced PNG: every colour type, every bit depth, palettes and `tRNS`
included. What it cannot read, it refuses by name rather than guessing at.

## Tests

```bash
npm test
```

## License

MIT.
