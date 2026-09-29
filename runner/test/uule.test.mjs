import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeUuleCanonicalName } from "../lib/uule.mjs";

test("known ASCII canonical name matches the documented encoding", () => {
  const uule = encodeUuleCanonicalName("West New York,New Jersey,United States");
  assert.ok(uule.startsWith("w+CAIQICI"), uule);
});

test("multibyte names use byte length, not character length", () => {
  const name = "東京都新宿区"; // 6 chars, 18 bytes
  const uule = encodeUuleCanonicalName(name);
  const proto = Buffer.from(
    uule.slice(2).replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  );
  assert.equal(proto[5], 18);
  assert.equal(proto.subarray(6).toString("utf8"), name);
});

test("names longer than 127 bytes are rejected (varint not implemented)", () => {
  assert.throws(() => encodeUuleCanonicalName("x".repeat(128)));
});
