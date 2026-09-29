import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseOrganicResults } from "../lib/organic.mjs";

const fixtureHtml = readFileSync(
  new URL("./fixtures/serp-organic.html", import.meta.url),
  "utf8",
);

test("counts only organic blocks for position", () => {
  const out = parseOrganicResults(fixtureHtml, "example.com");
  assert.equal(out.position, 2);
  assert.equal(out.url, "https://example.com/hit");
});

test("target present only inside the local pack yields null position", () => {
  const out = parseOrganicResults(fixtureHtml, "onlyinpack.example");
  assert.equal(out.position, null);
  assert.equal(out.url, null);
});

test("subdomains of the target count as a match", () => {
  const out = parseOrganicResults(
    fixtureHtml.replace("https://third.example/x", "https://www.target.example/x"),
    "target.example",
  );
  assert.equal(out.position, 3);
});

test("detected serp features are reported", () => {
  const out = parseOrganicResults(fixtureHtml, "example.com");
  assert.ok(out.serpFeatures.includes("organic"));
  assert.ok(out.serpFeatures.includes("local_pack"));
  assert.ok(out.serpFeatures.includes("people_also_ask"));
});
