// The whole framework: a counter, an assertion, a named block, and one way to find a file in the
// repo. No dependencies, because this repo has none and a test runner would be the first.
//
// `failures` and `checks` are exported as `let` on purpose: an ES module named export is a live
// binding, so the runner's totals see every subject's counting without an accumulator passed around.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export let failures = 0;
export let checks = 0;

export function ok(cond, label) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}

export function group(name, fn) {
  console.log(name);
  fn();
}

export const same = (got, want) => Array.isArray(got) && got.length === want.length
  && got.every((a, i) => a === want[i]);
