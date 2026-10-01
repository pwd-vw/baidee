import { describe, expect, it } from "vitest";
import { buildZip } from "../src/zip";

describe("buildZip", () => {
  it("starts with a local file header signature and ends with the end-of-central-directory signature", () => {
    const zip = buildZip([{ name: "a.txt", data: new TextEncoder().encode("hello") }]);
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50);
  });

  it("records the correct entry count and names in the end-of-central-directory record", () => {
    const entries = [
      { name: "images/1.jpg", data: new Uint8Array([1, 2, 3]) },
      { name: "images/2.jpg", data: new Uint8Array([4, 5, 6, 7]) },
      { name: "metadata.csv", data: new TextEncoder().encode("a,b\n1,2\n") },
    ];
    const zip = buildZip(entries);
    const view = new DataView(zip.buffer);
    const entryCount = view.getUint16(zip.length - 22 + 8, true);
    expect(entryCount).toBe(3);
    const text = new TextDecoder("latin1").decode(zip);
    for (const entry of entries) expect(text).toContain(entry.name);
  });

  it("computes CRC32 matching the well-known test vector for \"123456789\"", () => {
    // This is the standard CRC-32 (IEEE 802.3) conformance check value.
    const zip = buildZip([{ name: "t", data: new TextEncoder().encode("123456789") }]);
    const crc = new DataView(zip.buffer).getUint32(14, true); // local header CRC-32 field
    expect(crc).toBe(0xcbf43926);
  });

  it("stores file bytes uncompressed and recoverable by direct slicing", () => {
    const data = new TextEncoder().encode("round-trip me");
    const zip = buildZip([{ name: "x.bin", data }]);
    // Local header is 30 bytes + name length (5 for "x.bin"); data follows immediately.
    const dataStart = 30 + 5;
    const recovered = zip.slice(dataStart, dataStart + data.length);
    expect(new TextDecoder().decode(recovered)).toBe("round-trip me");
  });
});
