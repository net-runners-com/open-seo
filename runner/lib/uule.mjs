// UULE v2 "canonical name" encoding: protobuf {1:2, 2:32, 4:<name>} with a
// single-byte length. 08 02 10 20 22 <len> <utf8 name>, base64url, "w+" prefix.
export function encodeUuleCanonicalName(name) {
  const bytes = Buffer.from(name, "utf8");
  if (bytes.length > 127) {
    throw new Error("canonical name too long for single-byte varint");
  }
  const proto = Buffer.concat([
    Buffer.from([0x08, 0x02, 0x10, 0x20, 0x22, bytes.length]),
    bytes,
  ]);
  return (
    "w+" +
    proto
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
  );
}
