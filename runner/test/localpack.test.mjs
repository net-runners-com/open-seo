import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLocalFinderResults } from "../lib/localpack.mjs";

const fixtureHtml = readFileSync(
  new URL("./fixtures/local-finder.html", import.meta.url),
  "utf8",
);

test("returns the 1-based position of the entry whose website matches", () => {
  const out = parseLocalFinderResults(fixtureHtml, "acme.example");
  assert.equal(out.localPackPosition, 2);
});

test("no website match yields null but still lists entries", () => {
  const out = parseLocalFinderResults(fixtureHtml, "nomatch.example");
  assert.equal(out.localPackPosition, null);
  assert.equal(out.entries.length, 3);
  assert.deepEqual(out.entries[2], { name: "リンク無し税理士", website: null });
});
