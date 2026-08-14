// The icon CLI end to end, against a project that exists only for the length of this file. Spawned
// rather than imported for the same reason the artwork tests are: the guards here are exit codes.
//
// The two containers are opened with the walkers from test/icns.mjs and test/zip.mjs, which are
// written from the two formats rather than from src/, and every payload inside them is decoded and
// measured. "The zip has eight files in it" is not the check that matters — Steamworks takes the
// upload either way, and the icon that comes out the far end is the wrong number of pixels.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ICNS_ENTRIES } from "../src/icns.mjs";
import { LINUX_SIZES } from "../src/icons.mjs";
import { crc32, decodePng, encodePng } from "../src/png.mjs";
import { ok, group, ROOT } from "./harness.mjs";
import { walkIcns } from "./icns.mjs";
import { walkZip } from "./zip.mjs";

const CLI = join(ROOT, "bin", "steam-icons.mjs");
const roots = [];

// An opaque ramp, so a crop that moved shows as a different corner colour, and so the "no
// transparency in this" note has something to fire on.
const plate = (w, h, clear) => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      data[o] = Math.round((x / (w - 1)) * 255);
      data[o + 1] = Math.round((y / (h - 1)) * 255);
      data[o + 2] = 40;
      // The clear edge is the far one on purpose. Put it at the origin and a scan that gave up
      // after the first pixel would still answer correctly, on this plate and on nothing else.
      data[o + 3] = clear && (x === w - 1 || y === h - 1) ? 0 : 255;
    }
  }
  return encodePng({ width: w, height: h, data });
};

const project = ({ icon = { source: "art/icon.png" }, size = [128, 128], source = "art/icon.png", clear = false } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "steam-tools-icon-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "the-game", version: "1.2.3", build: { productName: "The Game" },
  }));
  writeFileSync(join(root, "steam.config.json"), JSON.stringify({ appId: "480", icon }));
  if (source) {
    mkdirSync(join(root, "art"), { recursive: true });
    writeFileSync(join(root, source), plate(size[0], size[1], clear));
  }
  return root;
};

const run = (root, args = []) => {
  const out = spawnSync(process.execPath, [CLI, "--root", root, ...args], { encoding: "utf8" });
  return { status: out.status, stdout: (out.stdout || "").replace(/ +/g, " "), stderr: out.stderr };
};

const icns = (root) => walkIcns(readFileSync(join(root, "steam", "mac_icon.icns")));
const zip = (root) => walkZip(readFileSync(join(root, "steam", "linux_icons.zip")));
const alphaAt = (img, x, y) => img.data[(y * img.width + x) * 4 + 3];

try {
  group("the icns carries every size macOS asks for, at that size", () => {
    const root = project();
    const { status, stdout } = run(root);
    ok(status === 0, "a configured project runs clean");

    const entries = icns(root);
    ok(entries.length === ICNS_ENTRIES.length, `all ${ICNS_ENTRIES.length} entries are in it (got ${entries.length})`);
    ok(entries.every((e, i) => e.type === ICNS_ENTRIES[i].type), "each one has the OSType it is supposed to");

    // THE CHECK THIS FILE EXISTS FOR. An icns whose ic10 holds a 512 is a well-formed file that
    // macOS reads and draws blurred, and nothing about the folder it is in says so.
    const wrong = entries.filter((e, i) => {
      const img = decodePng(Buffer.from(e.data));
      return img.width !== ICNS_ENTRIES[i].size || img.height !== ICNS_ENTRIES[i].size;
    });
    ok(!wrong.length, `every payload is a PNG of its own size (${wrong.map((e) => e.type).join(", ") || "all correct"})`);

    ok(stdout.includes("UPSCALED"),
      "1024 out of a 128 source is called an enlargement rather than left to be discovered");
    ok(stdout.includes("already square"), "a square source says it was one");
    ok(stdout.includes("no transparent pixel"), "and an opaque source is told what that looks like in a Dock");
    // The other half of that note, and the half that makes it worth having: a source drawn the way
    // an icon is drawn must not be warned about, or the warning is a line nobody reads.
    ok(!run(project({ clear: true }), ["--print"]).stdout.includes("no transparent pixel"),
      "while a source with transparency in it is not warned about at all");
  });

  group("the zip is a flat bag of PNGs, each the size its name claims", () => {
    const root = project();
    run(root);
    const files = zip(root);

    ok(files.length === LINUX_SIZES.length, `one file per size (got ${files.length})`);
    ok(files.every((f, i) => f.name === `icon_${LINUX_SIZES[i]}x${LINUX_SIZES[i]}.png`),
      "named for the size they are, with no folder above them");
    ok(files.every((f) => !f.name.includes("/")), "and nothing that unpacks into a directory");

    const wrong = files.filter((f, i) => {
      const img = decodePng(Buffer.from(f.data));
      return img.width !== LINUX_SIZES[i] || img.height !== LINUX_SIZES[i];
    });
    ok(!wrong.length, `each one is its own size (${wrong.map((f) => f.name).join(", ") || "all correct"})`);
    // The CRC in the directory is what an unzipper checks the bytes against, so it is recomputed
    // here from the bytes that were actually stored rather than trusted.
    ok(files.every((f) => crc32(f.data) === f.crc), "and every CRC matches the bytes behind it");

    // 256 is ic08, it is ic13, and it is the largest Linux icon in the default set. They are one
    // render shared three ways in src/, which is not something bytes can prove — the encoder is
    // deterministic, so a re-encode would match too. What this does prove is that the same image
    // arrives in all three places, which is what a wrong lookup between the two containers breaks.
    const at256 = icns(root).filter((e) => ["ic08", "ic13"].includes(e.type)).map((e) => Buffer.from(e.data));
    const linux256 = Buffer.from(files.find((f) => f.name === "icon_256x256.png").data);
    ok(at256[0].equals(at256[1]) && at256[0].equals(linux256),
      "the 256 in the icns twice and the 256 in the zip are the same image, byte for byte");
  });

  group("a source that is not square", () => {
    // 200x100 padded is a 200x200 with the picture in a 100-tall band down the middle, so a 32x32
    // cut from it is transparent at the top and opaque across the middle.
    const padded = project({ size: [200, 100], icon: { source: "art/icon.png", linuxSizes: [32] } });
    const out = run(padded, ["--only", "linux"]);
    ok(out.stdout.includes("centred on a transparent 200x200"), "pads by default, and says to what");
    const img = decodePng(Buffer.from(zip(padded)[0].data));
    ok(alphaAt(img, 16, 0) === 0 && alphaAt(img, 16, 31) === 0, "the padding is actually transparent");
    ok(alphaAt(img, 16, 16) === 255, "and the picture is still in the middle of it");

    const cut = project({ size: [200, 100], icon: { source: "art/icon.png", square: "crop", linuxSizes: [32] } });
    const cropped = run(cut, ["--only", "linux"]);
    ok(cropped.stdout.includes("cropped to 100x100 at 50,0"), "crop takes the middle square and prints where");
    const tight = decodePng(Buffer.from(zip(cut)[0].data));
    let opaque = true;
    for (let i = 3; i < tight.data.length; i += 4) if (tight.data[i] !== 255) opaque = false;
    ok(opaque, "and nothing was padded into it");

    // --square is the same decision from the command line, which is where it gets made while
    // looking at the last one that came out wrong.
    const flag = run(project({ size: [200, 100] }), ["--square", "crop", "--print"]);
    ok(flag.stdout.includes("cropped to 100x100"), "--square overrides the config");
    ok(run(project(), ["--square", "middle"]).stderr.includes('"pad" or "crop"'),
      "and a square mode that is not one is refused with both of them");

    const idle = run(project({ icon: { source: "art/icon.png", focus: { x: 0.2 } } }), ["--print"]);
    ok(idle.stdout.includes("focus is set and nothing was cropped"),
      "a focus with no crop to steer is reported rather than silently ignored");
  });

  group("--print, --only and linuxSizes", () => {
    const root = project();
    const dry = run(root, ["--print"]);
    ok(dry.status === 0 && !existsSync(join(root, "steam")),
      "--print writes nothing — a dry run that left files behind would be a lie");
    ok(dry.stdout.includes("nothing written"), "and says so rather than looking like a normal run");

    const linux = project();
    run(linux, ["--only", "linux"]);
    ok(readdirSync(join(linux, "steam")).join() === "linux_icons.zip", "--only linux writes just the zip");

    const mac = project();
    run(mac, ["--only", "mac"]);
    ok(readdirSync(join(mac, "steam")).join() === "mac_icon.icns", "--only mac writes just the icns");

    const sizes = project({ icon: { source: "art/icon.png", linuxSizes: [512, 16, 16] } });
    run(sizes, ["--only", "linux"]);
    ok(zip(sizes).map((f) => f.name).join() === "icon_16x16.png,icon_512x512.png",
      "linuxSizes replaces the default list, sorted, with the duplicate dropped");

    const where = project({ icon: { source: "art/icon.png", out: "elsewhere", linuxSizes: [16] } });
    run(where, ["--only", "linux"]);
    ok(existsSync(join(where, "elsewhere")), "and out moves the folder");
  });

  group("what stops it", () => {
    const nothing = run(project({ icon: {} }));
    ok(nothing.status === 1 && nothing.stderr.includes("no icon source"),
      "a project with no source is told what to write, not handed an empty folder");

    const gone = run(project({ icon: { source: "art/missing.png" } }));
    ok(gone.status === 1 && gone.stderr.includes("missing.png"), "a source that is not there names the path");

    // The same argument as the artwork block's: a misspelling here produces a full set of icons,
    // made exactly as they would have been if nothing had been asked for.
    const typo = run(project({ icon: { source: "art/icon.png", linuxSize: [16] } }));
    ok(typo.status === 1 && typo.stderr.includes("linuxSize") && typo.stderr.includes("linuxSizes"),
      "an option that is not one is refused, and the real names are listed");

    const empty = run(project({ icon: { source: "art/icon.png", linuxSizes: [] } }));
    ok(empty.status === 1 && empty.stderr.includes("list of pixel sizes"), "an empty size list stops the run");

    const notSize = run(project({ icon: { source: "art/icon.png", linuxSizes: [16, "32"] } }));
    ok(notSize.status === 1 && notSize.stderr.includes('"32"'), "and a size that is a string names itself");

    const badOnly = run(project(), ["--only", "windows"]);
    ok(badOnly.status === 1 && badOnly.stderr.includes("windows"), "--only checks its names too");

    const notPng = project();
    writeFileSync(join(notPng, "art", "icon.png"), "this is a text file wearing a png's name");
    ok(run(notPng).stderr.includes("signature"), "and a source that is not a PNG says what it actually is");
  });
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
