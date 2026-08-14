#!/usr/bin/env node
// The runner. Each subject runs its own groups when it is imported, so this list is both the order
// they report in and the whole map of what is covered. Exit code is the failure count.

import { checks, failures } from "./harness.mjs";

const SUBJECTS = ["launcher", "upload", "cli", "png", "image", "artwork"];

for (const name of SUBJECTS) await import(`./${name}.mjs`);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) console.error(`${failures} FAILED`);
process.exit(failures);
