// The artwork CLI end to end, against a project that exists only for the length of this file.
// Spawned rather than imported for the same reason the upload tests are: the guards here are exit
// codes, and a refusal that logs and carries on is not a refusal.
//
// The dimensions are read out of each file's IHDR rather than decoded. Steam rejects a capsule that
// is one pixel off, so "did it come out the size it printed" is the check that matters, and it is
// twenty-four bytes.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSETS } from "../src/artwork.mjs";
import { encodePng } from "../src/png.mjs";
import { ok, group, ROOT } from "./harness.mjs";

const CLI = join(ROOT, "bin", "steam-artwork.mjs");
const roots = [];

// A plate with a horizontal ramp in red and a vertical one in green, so a crop that moved shows up
// as a different corner colour rather than as a picture that looks broadly similar.
const plate = (w, h) => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      data[o] = Math.round((x / (w - 1)) * 255);
      data[o + 1] = Math.round((y / (h - 1)) * 255);
      data[o + 2] = 40;
      data[o + 3] = 255;
    }
  }
  return encodePng({ width: w, height: h, data });
};

const project = ({ artwork = { source: "art/keyart.png" }, size = [480, 270], source = "art/keyart.png" } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "steam-tools-art-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "the-game", version: "1.2.3", build: { productName: "The Game" },
  }));
  writeFileSync(join(root, "steam.config.json"), JSON.stringify({ appId: "480", artwork }));
  if (source) {
    mkdirSync(join(root, "art"), { recursive: true });
    writeFileSync(join(root, source), plate(size[0], size[1]));
  }
  return root;
};

// The columns are padded for reading, so the runs of spaces are collapsed before anything is
// matched against them. A check that fails when a column gets wider is a check nobody keeps.
const run = (root, args = []) => {
  const out = spawnSync(process.execPath, [CLI, "--root", root, ...args], { encoding: "utf8" });
  return { status: out.status, stdout: (out.stdout || "").replace(/ +/g, " "), stderr: out.stderr };
};

// width and height straight out of the IHDR, which starts at byte 16.
const sizeOf = (path) => {
  const head = Buffer.alloc(24);
  const fd = openSync(path, "r");
  readSync(fd, head, 0, 24, 0);
  return `${head.readUInt32BE(16)}x${head.readUInt32BE(20)}`;
};

try {
  group("it writes every asset at exactly the size Steam asks for", () => {
    const root = project();
    const { status, stdout } = run(root);
    ok(status === 0, "a configured project runs clean");

    const dir = join(root, "steam");
    const files = existsSync(dir) ? readdirSync(dir).sort() : [];
    ok(files.length === ASSETS.length, `all ${ASSETS.length} assets are written (got ${files.length})`);

    const wrong = ASSETS.filter((a) => {
      const path = join(dir, `${a.key}_${a.w}x${a.h}.png`);
      return !existsSync(path) || sizeOf(path) !== `${a.w}x${a.h}`;
    });
    ok(!wrong.length, `each one is its own size (${wrong.map((a) => a.key).join(", ") || "all correct"})`);

    ok(stdout.includes("UPSCALED"),
      "the 3840-wide hero out of a 480-wide plate is called an enlargement rather than left to be discovered");
    ok(stdout.includes("safe zone covers source"), "and the hero's safe zone is mapped back into the plate");
    ok(stdout.includes("Screenshots") && stdout.includes("Library Logo"),
      "the two assets it cannot cut are named, because seven files look like a finished set");
  });

  group("the filter follows the numbers, all the way through the CLI", () => {
    // 480x270 -> a 480x155 crop -> 3840x1240 is not a whole number, so it is not nearest. A source
    // exactly half the hero is, and that is the case the real plate hits.
    ok(run(project()).stdout.includes("bilinear"), "an awkward ratio interpolates");
    const exact = run(project({ size: [1920, 1080] }), ["--only", "library_hero"]);
    ok(exact.stdout.includes("2.000x nearest"),
      "and a source exactly half the hero enlarges by pixel replication, which is what pixel art needs");
    ok(exact.stdout.includes("crop 1920x620"), "off the exact rectangle that makes it 2x");
    // 860x380 of a target enlarged 2x is 430x190 of the plate, centred on the crop at 0,230.
    // Printing Steam's numbers instead of the plate's would send you looking in the wrong place.
    ok(exact.stdout.includes("safe zone covers source 745,445 to 1175,635"),
      "and the safe zone is reported in source pixels, divided by the scale, not in Steam's");

    // The same thing zoomed and moved, so the crop starts somewhere other than 0,0 on both axes.
    // The focus is half global and half per-asset on purpose: x comes from the asset, y from the
    // block above it, and either half going missing lands the crop somewhere else.
    //   x = 0.75*1920 - 480 = 960   y = 0.75*1080 - 155 = 655
    const zoomed = run(project({
      size: [1920, 1080],
      artwork: {
        source: "art/keyart.png",
        focus: { x: 0.25, y: 0.75 },
        assets: { library_hero: { zoom: 2, focus: { x: 0.75 } } },
      },
    }), ["--only", "library_hero", "--print"]);
    ok(zoomed.stdout.includes("crop 960x310 at 960,655") && zoomed.stdout.includes("4.000x nearest"),
      "zoom tightens the crop, a per-asset focus overrides the global one axis at a time, and 4x is still nearest");
    // 860x380 of a target enlarged 4x is 215x95 of the plate, centred on that crop.
    ok(zoomed.stdout.includes("safe zone covers source 1333,763 to 1548,858"),
      "and the safe zone moves with the crop rather than being measured from the corner of the plate");
  });

  group("--print, --only and --list", () => {
    const root = project();
    const dry = run(root, ["--print"]);
    ok(dry.status === 0 && !existsSync(join(root, "steam")),
      "--print writes nothing — a dry run that left files behind would be a lie");
    ok(dry.stdout.includes("nothing written"), "and says so rather than looking like a normal run");

    const one = project();
    run(one, ["--only", "small_capsule,header_capsule"]);
    ok(readdirSync(join(one, "steam")).length === 2, "--only writes just the ones named");

    const listed = run(root, ["--list"]);
    ok(listed.status === 0 && ASSETS.every((a) => listed.stdout.includes(`${a.w}x${a.h}`)),
      "--list prints every size without needing a source at all");

    const where = project({ artwork: { source: "art/keyart.png", out: "elsewhere" } });
    run(where);
    ok(existsSync(join(where, "elsewhere")), "and out moves the folder");
  });

  group("what stops it", () => {
    const nothing = run(project({ artwork: {} }));
    ok(nothing.status === 1 && nothing.stderr.includes("no artwork source"),
      "a project with no source is told what to write, not handed an empty folder");

    const gone = run(project({ artwork: { source: "art/missing.png" } }));
    ok(gone.status === 1 && gone.stderr.includes("missing.png"),
      "a source that is not there names the path it looked at");

    // THE ONE THAT MATTERS MOST HERE. A misspelled key produces every capsule, framed as though
    // nothing had been asked for — there is no error and no missing file to notice.
    const typo = run(project({ artwork: { source: "art/keyart.png", assets: { library_heroe: { zoom: 2 } } } }));
    ok(typo.status === 1 && typo.stderr.includes("library_heroe") && typo.stderr.includes("library_hero"),
      "an asset key that is not one is refused, and the real names are listed");

    const badOpt = run(project({ artwork: { source: "art/keyart.png", assets: { library_hero: { focous: {} } } } }));
    ok(badOpt.status === 1 && badOpt.stderr.includes("focous"), "and so is a misspelled option inside one");

    const badOnly = run(project(), ["--only", "nope"]);
    ok(badOnly.status === 1 && badOnly.stderr.includes("nope"), "--only checks its names too");

    const badZoom = run(project({ artwork: { source: "art/keyart.png", assets: { library_hero: { zoom: 0.5 } } } }));
    ok(badZoom.status === 1 && badZoom.stderr.includes("library_hero"),
      "a refusal from the geometry names the asset it came from");

    const notPng = project();
    writeFileSync(join(notPng, "art", "keyart.png"), "this is a text file wearing a png's name");
    ok(run(notPng).stderr.includes("signature"), "and a source that is not a PNG says what it actually is");
  });
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
