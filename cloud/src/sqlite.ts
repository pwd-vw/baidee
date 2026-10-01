// Minimal, dependency-free writer for a single-table SQLite database file
// (no indexes, bulk-loaded rowid table b-tree). Validated against the real
// `sqlite3` CLI (PRAGMA integrity_check, row/column round-trip, multi-page
// trees) before being ported here — see dev_log for the validation session.
// Pure Uint8Array/DataView, no Node APIs, so it runs as-is in Workers.

const PAGE_SIZE = 8192;

export type SqliteValue = { kind: "text"; value: string } | { kind: "int"; value: number } | { kind: "null" };

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

function encodeVarint(value: number): number[] {
  if (value < 0) throw new Error("negative varint");
  if (value <= 0x7f) return [value & 0x7f];
  const groups: number[] = [];
  let v = value;
  while (v > 0) {
    groups.unshift(v % 128);
    v = Math.floor(v / 128);
  }
  const bytes: number[] = [];
  for (let i = 0; i < groups.length - 1; i++) bytes.push(groups[i] | 0x80);
  bytes.push(groups[groups.length - 1]);
  return bytes;
}

function textSerialType(byteLength: number): number {
  return byteLength * 2 + 13;
}

function intSerialTypeAndBytes(value: number): { type: number; bytes: number[] } {
  if (value === 0) return { type: 8, bytes: [] };
  if (value === 1) return { type: 9, bytes: [] };
  const abs = Math.abs(value);
  if (abs < 0x80) return { type: 1, bytes: [value & 0xff] };
  if (abs < 0x8000) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setInt16(0, value, false);
    return { type: 2, bytes: [...b] };
  }
  if (abs < 0x80000000) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, value, false);
    return { type: 4, bytes: [...b] };
  }
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(value), false);
  return { type: 6, bytes: [...b] };
}

function buildRecord(columns: SqliteValue[]): Uint8Array {
  const serialTypes: number[] = [];
  const bodies: Uint8Array[] = [];
  for (const col of columns) {
    if (col.kind === "null") {
      serialTypes.push(0);
      bodies.push(new Uint8Array(0));
    } else if (col.kind === "text") {
      const buf = new TextEncoder().encode(col.value);
      serialTypes.push(textSerialType(buf.length));
      bodies.push(buf);
    } else {
      const { type, bytes } = intSerialTypeAndBytes(col.value);
      serialTypes.push(type);
      bodies.push(new Uint8Array(bytes));
    }
  }
  const serialTypeBytes = serialTypes.flatMap((t) => encodeVarint(t));
  let headerLenFieldLen = 1;
  let headerLength = 0;
  for (;;) {
    headerLength = headerLenFieldLen + serialTypeBytes.length;
    const actualFieldLen = encodeVarint(headerLength).length;
    if (actualFieldLen === headerLenFieldLen) break;
    headerLenFieldLen = actualFieldLen;
  }
  const header = concatBytes([new Uint8Array(encodeVarint(headerLength)), new Uint8Array(serialTypeBytes)]);
  return concatBytes([header, ...bodies]);
}

function buildLeafPages(records: Uint8Array[]): Uint8Array[] {
  const leaves: Uint8Array[] = [];
  let cells: Uint8Array[] = [];
  let usedHeader = 8;
  let contentStart = PAGE_SIZE;

  function flush() {
    if (cells.length === 0) return;
    const page = new Uint8Array(PAGE_SIZE);
    const view = new DataView(page.buffer);
    let cursor = PAGE_SIZE;
    const pointers: number[] = [];
    for (const cell of cells) {
      cursor -= cell.length;
      page.set(cell, cursor);
      pointers.push(cursor);
    }
    view.setUint8(0, 0x0d);
    view.setUint16(1, 0, false);
    view.setUint16(3, cells.length, false);
    view.setUint16(5, cursor, false);
    view.setUint8(7, 0);
    let ptrOffset = 8;
    for (const p of pointers) {
      view.setUint16(ptrOffset, p, false);
      ptrOffset += 2;
    }
    leaves.push(page);
    cells = [];
    usedHeader = 8;
    contentStart = PAGE_SIZE;
  }

  records.forEach((payload, index) => {
    const rowid = index + 1;
    const cellBody = concatBytes([
      new Uint8Array(encodeVarint(payload.length)),
      new Uint8Array(encodeVarint(rowid)),
      payload,
    ]);
    const neededHeader = usedHeader + 2;
    const neededContent = contentStart - cellBody.length;
    if (neededContent < neededHeader && cells.length > 0) {
      flush();
      const retryContent = PAGE_SIZE - cellBody.length;
      if (retryContent < 8 + 2) throw new Error("single row too large for page size");
      cells.push(cellBody);
      usedHeader = 8 + 2;
      contentStart = retryContent;
      return;
    }
    cells.push(cellBody);
    usedHeader = neededHeader;
    contentStart = neededContent;
  });
  flush();
  return leaves;
}

function buildInteriorPage(leafPageNumbers: number[], leafMaxRowids: number[]): Uint8Array {
  const page = new Uint8Array(PAGE_SIZE);
  const view = new DataView(page.buffer);
  const cellCount = leafPageNumbers.length - 1;
  let cursor = PAGE_SIZE;
  const pointers: number[] = [];
  for (let i = 0; i < cellCount; i++) {
    const childPage = leafPageNumbers[i];
    const key = leafMaxRowids[i];
    const cellBody = new Uint8Array(4 + encodeVarint(key).length);
    new DataView(cellBody.buffer).setUint32(0, childPage, false);
    cellBody.set(encodeVarint(key), 4);
    cursor -= cellBody.length;
    page.set(cellBody, cursor);
    pointers.push(cursor);
  }
  view.setUint8(0, 0x05);
  view.setUint16(1, 0, false);
  view.setUint16(3, cellCount, false);
  view.setUint16(5, cursor, false);
  view.setUint8(7, 0);
  view.setUint32(8, leafPageNumbers[leafPageNumbers.length - 1], false);
  let ptrOffset = 12;
  for (const p of pointers) {
    view.setUint16(ptrOffset, p, false);
    ptrOffset += 2;
  }
  return page;
}

function buildDatabaseHeader(pageCount: number): Uint8Array {
  const h = new Uint8Array(100);
  const view = new DataView(h.buffer);
  h.set(new TextEncoder().encode("SQLite format 3\0"), 0);
  view.setUint16(16, PAGE_SIZE, false); // PAGE_SIZE fits directly; the "65536 encodes as 1" rule only matters at the max page size
  view.setUint8(18, 1);
  view.setUint8(19, 1);
  view.setUint8(20, 0);
  view.setUint8(21, 64);
  view.setUint8(22, 32);
  view.setUint8(23, 32);
  view.setUint32(24, 1, false);
  view.setUint32(28, pageCount, false);
  view.setUint32(32, 0, false);
  view.setUint32(36, 0, false);
  view.setUint32(40, 1, false);
  view.setUint32(44, 4, false);
  view.setUint32(48, 0, false);
  view.setUint32(52, 0, false);
  view.setUint32(56, 1, false);
  view.setUint32(60, 0, false);
  view.setUint32(64, 0, false);
  view.setUint32(68, 0, false);
  view.setUint32(92, 1, false);
  view.setUint32(96, 3045000, false);
  return h;
}

/** Builds a complete, valid SQLite database file holding one table. */
export function buildSqliteDatabase(tableName: string, createTableSql: string, rows: SqliteValue[][]): Uint8Array {
  const records = rows.map(buildRecord);
  const leaves = buildLeafPages(records);
  if (leaves.length === 0) {
    const empty = new Uint8Array(PAGE_SIZE);
    const view = new DataView(empty.buffer);
    view.setUint8(0, 0x0d);
    view.setUint16(1, 0, false);
    view.setUint16(3, 0, false);
    view.setUint16(5, PAGE_SIZE, false);
    view.setUint8(7, 0);
    leaves.push(empty);
  }

  const capturesRootPageNumber = 2;
  let pages: Uint8Array[];
  if (leaves.length === 1) {
    pages = [leaves[0]];
  } else {
    const leafPageNumbers = leaves.map((_, i) => 3 + i);
    const leafMaxRowids: number[] = [];
    let runningRowid = 0;
    for (const leaf of leaves) {
      const cellCount = new DataView(leaf.buffer).getUint16(3, false);
      runningRowid += cellCount;
      leafMaxRowids.push(runningRowid);
    }
    const interior = buildInteriorPage(leafPageNumbers, leafMaxRowids);
    pages = [interior, ...leaves];
  }

  const masterRecord = buildRecord([
    { kind: "text", value: "table" },
    { kind: "text", value: tableName },
    { kind: "text", value: tableName },
    { kind: "int", value: capturesRootPageNumber },
    { kind: "text", value: createTableSql },
  ]);

  const totalPages = 1 + pages.length;
  const header = buildDatabaseHeader(totalPages);

  const page1 = new Uint8Array(PAGE_SIZE);
  page1.set(header, 0);
  const HEADER_BASE = 100;
  const masterCell = concatBytes([
    new Uint8Array(encodeVarint(masterRecord.length)),
    new Uint8Array(encodeVarint(1)),
    masterRecord,
  ]);
  const masterContentStart = PAGE_SIZE - masterCell.length;
  page1.set(masterCell, masterContentStart);
  const page1View = new DataView(page1.buffer);
  page1View.setUint8(HEADER_BASE, 0x0d);
  page1View.setUint16(HEADER_BASE + 1, 0, false);
  page1View.setUint16(HEADER_BASE + 3, 1, false);
  page1View.setUint16(HEADER_BASE + 5, masterContentStart, false);
  page1View.setUint8(HEADER_BASE + 7, 0);
  page1View.setUint16(HEADER_BASE + 8, masterContentStart, false);

  return concatBytes([page1, ...pages]);
}
