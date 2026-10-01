import { describe, expect, it } from "vitest";
import { buildSqliteDatabase, type SqliteValue } from "../src/sqlite";

const CREATE_SQL = "CREATE TABLE captures (capture_id TEXT, notes TEXT)";

function row(captureId: string, notes: string | null): SqliteValue[] {
  return [
    { kind: "text", value: captureId },
    notes === null ? { kind: "null" } : { kind: "text", value: notes },
  ];
}

function bytesContain(haystack: Uint8Array, needle: string): boolean {
  const n = new TextEncoder().encode(needle);
  outer: for (let i = 0; i <= haystack.length - n.length; i++) {
    for (let j = 0; j < n.length; j++) {
      if (haystack[i + j] !== n[j]) continue outer;
    }
    return true;
  }
  return false;
}

describe("buildSqliteDatabase", () => {
  it("writes the SQLite magic header and a page-size-aligned file", () => {
    const db = buildSqliteDatabase("captures", CREATE_SQL, [row("cap-1", "hello")]);
    const header = new TextDecoder().decode(db.slice(0, 16));
    expect(header).toBe("SQLite format 3\0");
    expect(db.length % 8192).toBe(0);
  });

  it("records the correct total page count in the file header", () => {
    const db = buildSqliteDatabase("captures", CREATE_SQL, [row("cap-1", null)]);
    const pageCount = new DataView(db.buffer).getUint32(28, false);
    expect(pageCount).toBe(db.length / 8192);
  });

  it("embeds the CREATE TABLE statement and row text as literal UTF-8 bytes", () => {
    const db = buildSqliteDatabase("captures", CREATE_SQL, [row("20261001T000000Z_bd-s01-b01-c01", "needs review")]);
    expect(bytesContain(db, CREATE_SQL)).toBe(true);
    expect(bytesContain(db, "20261001T000000Z_bd-s01-b01-c01")).toBe(true);
    expect(bytesContain(db, "needs review")).toBe(true);
  });

  it("builds a valid multi-page b-tree when rows overflow a single leaf page", () => {
    const rows = Array.from({ length: 500 }, (_, i) =>
      row(`cap-${i}`, i % 3 === 0 ? null : `note-${i}-${"x".repeat(80)}`),
    );
    const db = buildSqliteDatabase("captures", CREATE_SQL, rows);
    expect(db.length / 8192).toBeGreaterThan(5); // definitely spilled across many pages
    // Spot-check first, middle, and last row content survived.
    expect(bytesContain(db, "cap-0")).toBe(true);
    expect(bytesContain(db, "cap-250")).toBe(true);
    expect(bytesContain(db, "cap-499")).toBe(true);
  });

  it("handles an empty table without throwing", () => {
    const db = buildSqliteDatabase("captures", CREATE_SQL, []);
    expect(db.length).toBe(16384); // schema page + one empty leaf page
    const pageCount = new DataView(db.buffer).getUint32(28, false);
    expect(pageCount).toBe(2);
  });
});
