import { buildSqliteDatabase, type SqliteValue } from "./sqlite";
import { buildZip } from "./zip";

export interface Env {
  IMAGES: R2Bucket;
  DB: D1Database;
  BAIDEE_HMAC_SECRET: string;
  BAIDEE_API_TOKEN?: string;
  BAIDEE_SESSION_SECRET?: string;
}

type UserRole = "admin" | "viewer";
type AuthContext = { email: string; role: UserRole; via: "session" | "token" };
type SessionPayload = { email: string; role: UserRole; exp: number };

type CapturePayload = {
  schema_version: "1.0";
  capture_id: string;
  node_id: string;
  site_id: string;
  bed_id: string;
  timestamp: string;
  image_sha256: string;
  stage: "edge_triage" | "pi_verify" | "manual";
  [key: string]: unknown;
};

type HeartbeatPayload = {
  node_id: string;
  timestamp: string;
  fw_version?: string;
  wifi_ip?: string;
  rssi?: number;
  uptime_ms?: number;
  camera?: string;
  psram?: string;
  storage?: string;
  capture_interval_ms?: number;
  [key: string]: unknown;
};

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_DAILY_CAPTURES = 500;
const MAX_DAILY_IMAGE_BYTES = 100 * 1024 * 1024;
const COMMAND_TYPES = ["capture_now", "set_wifi", "set_config"] as const;
type CommandType = (typeof COMMAND_TYPES)[number];

const DEFAULT_ADMIN_EMAIL = "baidee@pwdvisionworks.com";
const SESSION_COOKIE = "baidee_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
// Cloudflare Workers' WebCrypto PBKDF2 implementation rejects iteration
// counts above 100,000 (NotSupportedError); Miniflare's local dev runtime
// does not enforce this, so this must be verified against real deploys.
const PBKDF2_ITERATIONS = 100000;
const MIN_PASSWORD_LENGTH = 8;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function isCapturePayload(value: unknown): value is CapturePayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return payload.schema_version === "1.0"
    && typeof payload.capture_id === "string"
    && typeof payload.node_id === "string"
    && typeof payload.site_id === "string"
    && typeof payload.bed_id === "string"
    && typeof payload.timestamp === "string"
    && typeof payload.image_sha256 === "string"
    && ["edge_triage", "pi_verify", "manual"].includes(String(payload.stage));
}

function isHeartbeatPayload(value: unknown): value is HeartbeatPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.node_id === "string" && typeof payload.timestamp === "string";
}

function hexToBytes(value: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/i.test(value)) return new Uint8Array();
  return new Uint8Array(value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
}

async function hmacHex(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifySignature(payload: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  const expected = hexToBytes(signature);
  const digestHex = await hmacHex(payload, secret);
  const digest = hexToBytes(digestHex);
  if (expected.length !== digest.length || expected.length === 0) return false;
  return digest.every((byte, index) => byte === expected[index]);
}

async function verifyApiToken(request: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const providedDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(authorization.slice(7))));
  const expectedDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return providedDigest.length === expectedDigest.length
    && providedDigest.every((byte, index) => byte === expectedDigest[index]);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Unlike hexToBytes() above, this accepts any even-length hex string (used
// for PBKDF2 salts/hashes rather than fixed-length HMAC-SHA256 signatures).
function parseHex(value: string): Uint8Array {
  const clean = value.length % 2 === 0 ? value : `0${value}`;
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(clean.substr(index * 2, 2), 16);
  }
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return new Uint8Array([...binary].map((char) => char.charCodeAt(0)));
}

async function pbkdf2Hex(password: string, saltHex: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: parseHex(saltHex), iterations: PBKDF2_ITERATIONS },
    keyMaterial,
    256,
  );
  return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = randomHex(16);
  const hash = await pbkdf2Hex(password, salt);
  return { salt, hash };
}

async function verifyPassword(password: string, saltHex: string, expectedHashHex: string): Promise<boolean> {
  const computed = parseHex(await pbkdf2Hex(password, saltHex));
  const expected = parseHex(expectedHashHex);
  if (computed.length !== expected.length || computed.length === 0) return false;
  return computed.every((byte, index) => byte === expected[index]);
}

async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacHex(payloadB64, secret);
  return `${payloadB64}.${signature}`;
}

async function verifySessionToken(token: string, secret: string): Promise<SessionPayload | null> {
  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) return null;
  if (!(await verifySignature(payloadB64, signature, secret))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as Partial<SessionPayload>;
    if (typeof payload.email !== "string" || typeof payload.role !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp < Date.now() / 1000) return null;
    return { email: payload.email, role: payload.role, exp: payload.exp };
  } catch {
    return null;
  }
}

function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get("cookie") ?? "";
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function sessionCookieHeader(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

// Accepts either a signed session cookie (human dashboard login) or the
// legacy BAIDEE_API_TOKEN bearer header (scripts like organize_dataset.py),
// which is treated as a full-access service credential.
async function authenticate(request: Request, env: Env): Promise<AuthContext | null> {
  const sessionToken = parseCookies(request)[SESSION_COOKIE];
  if (sessionToken && env.BAIDEE_SESSION_SECRET) {
    const payload = await verifySessionToken(sessionToken, env.BAIDEE_SESSION_SECRET);
    if (payload) return { email: payload.email, role: payload.role, via: "session" };
  }
  if (await verifyApiToken(request, env.BAIDEE_API_TOKEN)) {
    return { email: "service-token", role: "admin", via: "token" };
  }
  return null;
}

function imageKey(payload: CapturePayload, extension: "jpg" | "webp"): string {
  const date = payload.timestamp.slice(0, 10).replaceAll("-", "/");
  return `raw/${payload.site_id}/${payload.bed_id}/${date}/${payload.capture_id}.${extension}`;
}

async function ingest(request: Request, env: Env): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_UPLOAD_BYTES) return json({ error: "upload too large" }, 413);

  const form = await request.formData();
  const payloadText = form.get("payload");
  const image = form.get("image");
  if (typeof payloadText !== "string" || !(image instanceof File)) {
    return json({ error: "multipart fields payload and image are required" }, 400);
  }
  if (!(["image/jpeg", "image/webp"] as string[]).includes(image.type)) {
    return json({ error: "only image/jpeg and image/webp are accepted" }, 415);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return json({ error: "payload must be valid JSON" }, 422);
  }
  if (!isCapturePayload(payload)) return json({ error: "invalid capture payload" }, 422);

  const nodeId = request.headers.get("x-node-id");
  if (nodeId !== payload.node_id) return json({ error: "x-node-id does not match payload" }, 401);
  if (!(await verifySignature(payloadText, request.headers.get("x-signature"), env.BAIDEE_HMAC_SECRET))) {
    return json({ error: "invalid signature" }, 401);
  }

  const existing = await env.DB.prepare("SELECT capture_id FROM captures WHERE capture_id = ?")
    .bind(payload.capture_id)
    .first<{ capture_id: string }>();
  if (existing) return json({ accepted: true, duplicate: true, capture_id: payload.capture_id });

  const imageBytes = await image.arrayBuffer();
  if (imageBytes.byteLength > MAX_UPLOAD_BYTES) return json({ error: "image too large" }, 413);
  const usageDate = payload.timestamp.slice(0, 10);
  const usage = await env.DB.prepare(
    "SELECT capture_count, image_bytes FROM usage_daily WHERE usage_date = ?",
  ).bind(usageDate).first<{ capture_count: number; image_bytes: number }>();
  const captureCount = usage?.capture_count ?? 0;
  const imageBytesUsed = usage?.image_bytes ?? 0;
  if (captureCount >= MAX_DAILY_CAPTURES || imageBytesUsed + imageBytes.byteLength > MAX_DAILY_IMAGE_BYTES) {
    return json({ error: "daily development ingest limit reached", usage_date: usageDate }, 429);
  }
  const extension = image.type === "image/webp" ? "webp" : "jpg";
  const key = imageKey(payload, extension);
  await env.IMAGES.put(key, imageBytes, {
    httpMetadata: { contentType: image.type || "image/jpeg" },
    customMetadata: { capture_id: payload.capture_id, node_id: payload.node_id },
  });
  await env.DB.prepare(
    "INSERT INTO captures(capture_id, node_id, site_id, bed_id, captured_at, stage, payload_json, image_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    payload.capture_id,
    payload.node_id,
    payload.site_id,
    payload.bed_id,
    payload.timestamp,
    payload.stage,
    payloadText,
    key,
  ).run();
  await env.DB.prepare(
    "INSERT INTO usage_daily(usage_date, capture_count, image_bytes) VALUES (?, 1, ?) ON CONFLICT(usage_date) DO UPDATE SET capture_count = capture_count + 1, image_bytes = image_bytes + excluded.image_bytes",
  ).bind(usageDate, imageBytes.byteLength).run();

  return json({ accepted: true, duplicate: false, capture_id: payload.capture_id });
}

type CaptureFilters = { node: string | null; from: string | null; to: string | null };

type CaptureRow = {
  capture_id: string;
  node_id: string;
  site_id: string;
  bed_id: string;
  captured_at: string;
  stage: string;
  notes: string | null;
  payload_json: string;
  image_key: string;
};

function parseCaptureFilters(url: URL): CaptureFilters {
  return {
    node: url.searchParams.get("node"),
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
  };
}

function captureWhereClause(filters: CaptureFilters): { where: string; bindings: string[] } {
  const conditions: string[] = [];
  const bindings: string[] = [];
  if (filters.node) {
    conditions.push("node_id = ?");
    bindings.push(filters.node);
  }
  if (filters.from) {
    conditions.push("captured_at >= ?");
    bindings.push(filters.from);
  }
  if (filters.to) {
    conditions.push("captured_at <= ?");
    bindings.push(filters.to);
  }
  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", bindings };
}

async function fetchCaptures(
  env: Env,
  filters: CaptureFilters,
  order: "ASC" | "DESC",
  pagination?: { limit: number; offset: number },
): Promise<CaptureRow[]> {
  const { where, bindings } = captureWhereClause(filters);
  const pageClause = pagination ? " LIMIT ? OFFSET ?" : "";
  const sql = `SELECT capture_id, node_id, site_id, bed_id, captured_at, stage, notes, payload_json, image_key
     FROM captures ${where} ORDER BY captured_at ${order}${pageClause}`;
  const args = pagination ? [...bindings, pagination.limit, pagination.offset] : bindings;
  const result = await env.DB.prepare(sql).bind(...args).all<CaptureRow>();
  return result.results;
}

async function countCaptures(env: Env, filters: CaptureFilters): Promise<number> {
  const { where, bindings } = captureWhereClause(filters);
  const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM captures ${where}`)
    .bind(...bindings)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

async function listCaptures(request: Request, env: Env): Promise<Response> {
  if (!(await authenticate(request, env))) return json({ error: "unauthorized" }, 401);
  const url = new URL(request.url);
  const filters = parseCaptureFilters(url);
  const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100) : 50;
  const requestedOffset = Number(url.searchParams.get("offset") ?? 0);
  const offset = Number.isFinite(requestedOffset) ? Math.max(Math.trunc(requestedOffset), 0) : 0;
  const [rows, total] = await Promise.all([
    fetchCaptures(env, filters, "DESC", { limit, offset }),
    countCaptures(env, filters),
  ]);
  return json({
    captures: rows.map((capture) => ({ ...capture, payload: JSON.parse(capture.payload_json), payload_json: undefined })),
    total,
    limit,
    offset,
  });
}

async function getImage(request: Request, env: Env, captureId: string): Promise<Response> {
  if (!(await authenticate(request, env))) return json({ error: "unauthorized" }, 401);
  const capture = await env.DB.prepare("SELECT image_key FROM captures WHERE capture_id = ?")
    .bind(captureId)
    .first<{ image_key: string }>();
  if (!capture) return json({ error: "not found" }, 404);
  const object = await env.IMAGES.get(capture.image_key);
  if (!object) return json({ error: "image missing in storage" }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "image/jpeg",
      "cache-control": "private, max-age=86400",
    },
  });
}

async function updateCapture(request: Request, env: Env, captureId: string): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: "unauthorized" }, 401);
  if (auth.role !== "admin") return json({ error: "forbidden" }, 403);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "body must be valid JSON" }, 422);
  }
  const { notes } = (body ?? {}) as Record<string, unknown>;
  if (notes !== null && notes !== undefined && typeof notes !== "string") {
    return json({ error: "notes must be a string or null" }, 422);
  }
  const existing = await env.DB.prepare("SELECT capture_id FROM captures WHERE capture_id = ?")
    .bind(captureId)
    .first<{ capture_id: string }>();
  if (!existing) return json({ error: "not found" }, 404);
  const normalizedNotes = notes === undefined ? null : notes;
  await env.DB.prepare("UPDATE captures SET notes = ? WHERE capture_id = ?").bind(normalizedNotes, captureId).run();
  return json({ accepted: true, capture_id: captureId, notes: normalizedNotes });
}

async function deleteCapture(request: Request, env: Env, captureId: string): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: "unauthorized" }, 401);
  if (auth.role !== "admin") return json({ error: "forbidden" }, 403);
  const existing = await env.DB.prepare("SELECT image_key FROM captures WHERE capture_id = ?")
    .bind(captureId)
    .first<{ image_key: string }>();
  if (!existing) return json({ error: "not found" }, 404);
  await env.IMAGES.delete(existing.image_key);
  await env.DB.prepare("DELETE FROM captures WHERE capture_id = ?").bind(captureId).run();
  return json({ accepted: true });
}

const EXPORT_MAX_ROWS = 2000;

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

async function exportCaptures(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: "unauthorized" }, 401);
  if (auth.role !== "admin") return json({ error: "forbidden" }, 403);
  const url = new URL(request.url);
  const filters = parseCaptureFilters(url);
  const total = await countCaptures(env, filters);
  if (total === 0) return json({ error: "no captures match the given filters" }, 404);
  if (total > EXPORT_MAX_ROWS) {
    return json({ error: `too many captures match (${total}); narrow the date range to ${EXPORT_MAX_ROWS} or fewer` }, 422);
  }
  const rows = await fetchCaptures(env, filters, "ASC");

  const zipEntries: Array<{ name: string; data: Uint8Array }> = [];
  const sqliteRows: SqliteValue[][] = [];
  const csvLines = ["capture_id,node_id,site_id,bed_id,captured_at,stage,notes,image_filename"];

  for (const row of rows) {
    const extension = row.image_key.endsWith(".webp") ? "webp" : "jpg";
    const imageFilename = `${row.capture_id}.${extension}`;
    const object = await env.IMAGES.get(row.image_key);
    if (object) {
      zipEntries.push({ name: `images/${imageFilename}`, data: new Uint8Array(await object.arrayBuffer()) });
    }
    csvLines.push(
      [row.capture_id, row.node_id, row.site_id, row.bed_id, row.captured_at, row.stage, row.notes ?? "", imageFilename]
        .map(csvEscape)
        .join(","),
    );
    sqliteRows.push([
      { kind: "text", value: row.capture_id },
      { kind: "text", value: row.node_id },
      { kind: "text", value: row.site_id },
      { kind: "text", value: row.bed_id },
      { kind: "text", value: row.captured_at },
      { kind: "text", value: row.stage },
      row.notes === null ? { kind: "null" } : { kind: "text", value: row.notes },
      { kind: "text", value: imageFilename },
      { kind: "text", value: row.payload_json },
    ]);
  }

  zipEntries.push({ name: "metadata.csv", data: new TextEncoder().encode(csvLines.join("\n") + "\n") });
  const sqliteDb = buildSqliteDatabase(
    "captures",
    "CREATE TABLE captures (capture_id TEXT, node_id TEXT, site_id TEXT, bed_id TEXT, captured_at TEXT, stage TEXT, notes TEXT, image_filename TEXT, payload_json TEXT)",
    sqliteRows,
  );
  zipEntries.push({ name: "metadata.sqlite", data: sqliteDb });

  const zip = buildZip(zipEntries);
  const dateStamp = new Date().toISOString().slice(0, 10);
  return new Response(zip, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="baidee-export-${dateStamp}.zip"`,
    },
  });
}

async function getStats(request: Request, env: Env): Promise<Response> {
  if (!(await authenticate(request, env))) return json({ error: "unauthorized" }, 401);
  const totals = await env.DB.prepare(
    "SELECT COUNT(*) AS total_captures, COUNT(DISTINCT node_id) AS total_nodes FROM captures",
  ).first<{ total_captures: number; total_nodes: number }>();
  const today = new Date().toISOString().slice(0, 10);
  const todayUsage = await env.DB.prepare(
    "SELECT capture_count, image_bytes FROM usage_daily WHERE usage_date = ?",
  ).bind(today).first<{ capture_count: number; image_bytes: number }>();
  const byDay = await env.DB.prepare(
    "SELECT usage_date, capture_count, image_bytes FROM usage_daily ORDER BY usage_date DESC LIMIT 14",
  ).all<{ usage_date: string; capture_count: number; image_bytes: number }>();
  const byNode = await env.DB.prepare(
    `SELECT node_id, COUNT(*) AS capture_count, MAX(captured_at) AS last_capture_at
     FROM captures GROUP BY node_id ORDER BY capture_count DESC`,
  ).all<{ node_id: string; capture_count: number; last_capture_at: string }>();
  const byStage = await env.DB.prepare(
    "SELECT stage, COUNT(*) AS count FROM captures GROUP BY stage",
  ).all<{ stage: string; count: number }>();
  return json({
    total_captures: totals?.total_captures ?? 0,
    total_nodes: totals?.total_nodes ?? 0,
    today: { usage_date: today, capture_count: todayUsage?.capture_count ?? 0, image_bytes: todayUsage?.image_bytes ?? 0 },
    by_day: byDay.results,
    by_node: byNode.results,
    by_stage: byStage.results,
  });
}

async function listCommands(request: Request, env: Env): Promise<Response> {
  const node = new URL(request.url).searchParams.get("node");
  const signature = request.headers.get("x-signature");
  if (!node || !(await verifySignature(node, signature, env.BAIDEE_HMAC_SECRET))) {
    return json({ error: "invalid node authentication" }, 401);
  }
  const pending = await env.DB.prepare(
    "SELECT id, command, args_json FROM commands WHERE node_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 5",
  ).bind(node).all<{ id: number; command: string; args_json: string }>();
  if (pending.results.length > 0) {
    const ids = pending.results.map((row) => row.id);
    await env.DB.prepare(
      `UPDATE commands SET status = 'delivered', delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id IN (${ids.map(() => "?").join(",")})`,
    ).bind(...ids).run();
  }
  return json({
    node_id: node,
    commands: pending.results.map((row) => ({ id: row.id, command: row.command, args: JSON.parse(row.args_json) })),
  });
}

async function enqueueCommand(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: "unauthorized" }, 401);
  if (auth.role !== "admin") return json({ error: "forbidden" }, 403);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "body must be valid JSON" }, 422);
  }
  const { node_id: nodeId, command, args } = (body ?? {}) as Record<string, unknown>;
  if (typeof nodeId !== "string" || !nodeId) return json({ error: "node_id is required" }, 422);
  if (typeof command !== "string" || !COMMAND_TYPES.includes(command as CommandType)) {
    return json({ error: `command must be one of ${COMMAND_TYPES.join(", ")}` }, 422);
  }
  const argsJson = JSON.stringify(args ?? {});
  const result = await env.DB.prepare(
    "INSERT INTO commands(node_id, command, args_json) VALUES (?, ?, ?)",
  ).bind(nodeId, command, argsJson).run();
  return json({ accepted: true, id: result.meta.last_row_id, node_id: nodeId, command, args: args ?? {} }, 201);
}

async function ackCommand(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "body must be valid JSON" }, 422);
  }
  const { node_id: nodeId, command_id: commandId, status, message } = (body ?? {}) as Record<string, unknown>;
  if (typeof nodeId !== "string" || typeof commandId !== "number" || typeof status !== "string") {
    return json({ error: "node_id, command_id, status are required" }, 422);
  }
  if (!["done", "failed"].includes(status)) return json({ error: "status must be done or failed" }, 422);
  const canonical = `${nodeId}:${commandId}:${status}`;
  if (!(await verifySignature(canonical, request.headers.get("x-signature"), env.BAIDEE_HMAC_SECRET))) {
    return json({ error: "invalid signature" }, 401);
  }
  const command = await env.DB.prepare("SELECT node_id FROM commands WHERE id = ?")
    .bind(commandId)
    .first<{ node_id: string }>();
  if (!command || command.node_id !== nodeId) return json({ error: "command not found for node" }, 404);
  await env.DB.prepare(
    "UPDATE commands SET status = ?, result_json = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
  ).bind(status, JSON.stringify({ message: message ?? null }), commandId).run();
  return json({ accepted: true });
}

async function heartbeat(request: Request, env: Env): Promise<Response> {
  const bodyText = await request.text();
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return json({ error: "body must be valid JSON" }, 422);
  }
  if (!isHeartbeatPayload(payload)) return json({ error: "invalid heartbeat payload" }, 422);
  const nodeId = request.headers.get("x-node-id");
  if (nodeId !== payload.node_id) return json({ error: "x-node-id does not match payload" }, 401);
  if (!(await verifySignature(bodyText, request.headers.get("x-signature"), env.BAIDEE_HMAC_SECRET))) {
    return json({ error: "invalid signature" }, 401);
  }
  await env.DB.prepare(
    `INSERT INTO node_status(node_id, last_seen_at, fw_version, wifi_ip, rssi, uptime_ms, camera, psram, storage, capture_interval_ms, extra_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       fw_version = excluded.fw_version,
       wifi_ip = excluded.wifi_ip,
       rssi = excluded.rssi,
       uptime_ms = excluded.uptime_ms,
       camera = excluded.camera,
       psram = excluded.psram,
       storage = excluded.storage,
       capture_interval_ms = excluded.capture_interval_ms,
       extra_json = excluded.extra_json`,
  ).bind(
    payload.node_id,
    payload.timestamp,
    payload.fw_version ?? null,
    payload.wifi_ip ?? null,
    payload.rssi ?? null,
    payload.uptime_ms ?? null,
    payload.camera ?? null,
    payload.psram ?? null,
    payload.storage ?? null,
    payload.capture_interval_ms ?? null,
    JSON.stringify(payload),
  ).run();
  return json({ accepted: true });
}

async function listNodes(request: Request, env: Env): Promise<Response> {
  if (!(await authenticate(request, env))) return json({ error: "unauthorized" }, 401);
  const nodes = await env.DB.prepare(
    "SELECT * FROM node_status ORDER BY last_seen_at DESC",
  ).all();
  return json({ nodes: nodes.results });
}

async function login(request: Request, env: Env): Promise<Response> {
  if (!env.BAIDEE_SESSION_SECRET) return json({ error: "session secret not configured" }, 500);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "body must be valid JSON" }, 422);
  }
  const { email, password } = (body ?? {}) as Record<string, unknown>;
  if (typeof email !== "string" || typeof password !== "string") {
    return json({ error: "email and password are required" }, 422);
  }
  const normalizedEmail = normalizeEmail(email);
  const user = await env.DB.prepare(
    "SELECT password_hash, password_salt, role FROM users WHERE email = ?",
  ).bind(normalizedEmail).first<{ password_hash: string; password_salt: string; role: UserRole }>();
  if (!user || !(await verifyPassword(password, user.password_salt, user.password_hash))) {
    return json({ error: "invalid email or password" }, 401);
  }
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = await signSession({ email: normalizedEmail, role: user.role, exp }, env.BAIDEE_SESSION_SECRET);
  return new Response(JSON.stringify({ accepted: true, email: normalizedEmail, role: user.role }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": sessionCookieHeader(token, SESSION_TTL_SECONDS),
    },
  });
}

function logout(): Response {
  return new Response(JSON.stringify({ accepted: true }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": clearSessionCookieHeader(),
    },
  });
}

async function me(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: "unauthorized" }, 401);
  return json({ email: auth.email, role: auth.role });
}

// One-time setup: creates the default admin account. Only works while the
// users table is empty, and additionally requires the pre-existing
// BAIDEE_API_TOKEN as proof of ownership, so a stranger who finds this route
// before bootstrap cannot claim the admin account on their own.
async function bootstrapAdmin(request: Request, env: Env): Promise<Response> {
  if (!env.BAIDEE_SESSION_SECRET) return json({ error: "session secret not configured" }, 500);
  if (!(await verifyApiToken(request, env.BAIDEE_API_TOKEN))) return json({ error: "unauthorized" }, 401);
  const existing = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  if ((existing?.count ?? 0) > 0) return json({ error: "already bootstrapped" }, 409);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "body must be valid JSON" }, 422);
  }
  const { password } = (body ?? {}) as Record<string, unknown>;
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 422);
  }
  const { salt, hash } = await hashPassword(password);
  await env.DB.prepare(
    "INSERT INTO users(email, password_hash, password_salt, role, created_by) VALUES (?, ?, ?, 'admin', 'bootstrap')",
  ).bind(DEFAULT_ADMIN_EMAIL, hash, salt).run();
  return json({ accepted: true, email: DEFAULT_ADMIN_EMAIL, role: "admin" }, 201);
}

async function listUsers(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: "unauthorized" }, 401);
  if (auth.role !== "admin") return json({ error: "forbidden" }, 403);
  const users = await env.DB.prepare(
    "SELECT email, role, created_at, created_by FROM users ORDER BY created_at ASC",
  ).all();
  return json({ users: users.results });
}

// Admin-only: creates a new user, or resets an existing user's password and
// role if the email already exists (upsert) — this is the "create users and
// set passwords" capability the admin account needs.
async function createOrUpdateUser(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: "unauthorized" }, 401);
  if (auth.role !== "admin") return json({ error: "forbidden" }, 403);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "body must be valid JSON" }, 422);
  }
  const { email, password, role } = (body ?? {}) as Record<string, unknown>;
  if (typeof email !== "string" || !email.includes("@")) return json({ error: "a valid email is required" }, 422);
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 422);
  }
  const userRole: UserRole = role === "viewer" ? "viewer" : "admin";
  const normalizedEmail = normalizeEmail(email);
  const { salt, hash } = await hashPassword(password);
  await env.DB.prepare(
    `INSERT INTO users(email, password_hash, password_salt, role, created_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       password_hash = excluded.password_hash,
       password_salt = excluded.password_salt,
       role = excluded.role,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).bind(normalizedEmail, hash, salt, userRole, auth.email).run();
  return json({ accepted: true, email: normalizedEmail, role: userRole }, 201);
}

async function deleteUser(request: Request, env: Env, email: string): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: "unauthorized" }, 401);
  if (auth.role !== "admin") return json({ error: "forbidden" }, 403);
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail === DEFAULT_ADMIN_EMAIL) return json({ error: "cannot delete the default admin account" }, 400);
  if (normalizedEmail === auth.email) return json({ error: "cannot delete your own account" }, 400);
  await env.DB.prepare("DELETE FROM users WHERE email = ?").bind(normalizedEmail).run();
  return json({ accepted: true });
}

function landingHtml(): string {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BaiDee (ใบดี) — Smart Leaf Health AI Monitoring</title>
<meta name="description" content="ระบบเฝ้าระวังสุขภาพใบพืชด้วย AI สำหรับฟาร์มชิโสะเกาหลี โดย PWD Vision Works">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Kanit:wght@600;700&family=Noto+Sans+Thai:wght@400;500;600&display=swap">
<style>
  :root {
    --green-900:#17301f; --green-700:#2f6b4f; --green-500:#4caf7d;
    --plum-700:#5b3a5c; --cream-50:#faf7f2; --cream-100:#f1ece1;
    --ink-900:#1f2a22; --ink-500:#5b6760; --line:#ddd6c7;
  }
  * { box-sizing:border-box; }
  html { scroll-behavior:smooth; }
  body { margin:0; background:var(--cream-50); color:var(--ink-900); font-family:"Noto Sans Thai", sans-serif; line-height:1.6; }
  h1,h2,h3 { font-family:"Kanit","Noto Sans Thai",sans-serif; margin:0; }
  a { color:inherit; text-decoration:none; }
  .wrap { max-width:1180px; margin:0 auto; padding:0 24px; }
  .section { padding:72px 0; }
  .eyebrow { font-size:13px; letter-spacing:.08em; text-transform:uppercase; color:var(--green-500); font-weight:600; }
  .muted { color:var(--ink-500); }
  .pill { display:inline-flex; align-items:center; gap:6px; padding:6px 14px; border-radius:999px; font-size:13px; font-weight:500; }
  .grid { display:grid; gap:20px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:14px; padding:24px; }
  .icon { width:30px; height:30px; flex:none; }
  .flow { display:flex; align-items:stretch; gap:14px; flex-wrap:wrap; }
  .flow .arrow { display:flex; align-items:center; color:var(--line); flex:none; }
  .flow .step { flex:1 1 170px; min-width:170px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th,td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--ink-500); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }

  nav.topnav { position:sticky; top:0; z-index:20; background:rgba(250,247,242,.92); backdrop-filter:blur(6px); border-bottom:1px solid var(--line); }
  nav.topnav .inner { max-width:1180px; margin:0 auto; padding:14px 24px; display:flex; align-items:center; gap:24px; }
  nav.topnav .brand { font-family:"Kanit",sans-serif; font-weight:700; font-size:18px; color:var(--green-900); white-space:nowrap; }
  nav.topnav .links { display:flex; gap:20px; flex:1; font-size:14px; color:var(--ink-500); flex-wrap:wrap; }
  nav.topnav .links a:hover { color:var(--green-700); }
  nav.topnav .cta { background:var(--green-700); color:#fff; padding:9px 18px; border-radius:8px; font-weight:600; font-size:14px; white-space:nowrap; }
  nav.topnav .cta:hover { background:var(--green-900); }
  @media (max-width:760px) { nav.topnav .links { display:none; } }

  .hero { background:linear-gradient(180deg, var(--green-900), var(--green-700)); color:#fff; text-align:center; padding:84px 0 72px; }
  .hero h1 { font-size:46px; }
  .hero .th { font-size:22px; font-weight:500; opacity:.9; margin-top:6px; }
  .hero .tagline { font-size:18px; margin:20px auto 0; max-width:620px; opacity:.95; }
  .hero .stats { display:flex; justify-content:center; gap:14px; flex-wrap:wrap; margin-top:32px; }
  .hero .stats .pill { background:rgba(255,255,255,.12); color:#fff; }
  .hero .buttons { margin-top:32px; display:flex; justify-content:center; gap:12px; flex-wrap:wrap; }
  .btn-primary { background:#fff; color:var(--green-900); padding:12px 26px; border-radius:9px; font-weight:700; }
  .btn-ghost { border:1px solid rgba(255,255,255,.5); color:#fff; padding:12px 26px; border-radius:9px; font-weight:600; }

  footer { background:var(--green-900); color:rgba(255,255,255,.85); padding:40px 0; font-size:13px; }
  footer .inner { display:flex; justify-content:space-between; flex-wrap:wrap; gap:12px; }
</style>
</head>
<body>

<nav class="topnav">
  <div class="inner">
    <div class="brand">BaiDee <span style="font-weight:400;opacity:.65">ใบดี</span></div>
    <div class="links">
      <a href="#problem">โจทย์ปัญหา</a>
      <a href="#goals">เป้าหมาย</a>
      <a href="#architecture">สถาปัตยกรรม</a>
      <a href="#roadmap">แผนพัฒนา</a>
      <a href="#hardware">ฮาร์ดแวร์</a>
      <a href="#software">ซอฟต์แวร์ &amp; AI</a>
    </div>
    <a class="cta" href="/dashboard">เข้าสู่ Dashboard →</a>
  </div>
</nav>

<section class="hero">
  <div class="wrap">
    <div class="eyebrow" style="color:#bfe3cf">PWD Vision Works · Pilot Project</div>
    <h1>BaiDee</h1>
    <div class="th">ใบดี — Smart Leaf Health AI Monitoring</div>
    <p class="tagline">"ตาที่เฝ้าดูใบ ให้ทุกใบดี" — ระบบเฝ้าระวังสุขภาพใบชิโสะเกาหลี (Korean perilla) ด้วยกล้อง AI ที่ทำงานแทนสายตาเจ้าของฟาร์ม ตรวจได้บ่อยกว่าคน แจ้งเตือนแม่นยำกว่า พร้อมบอกตำแหน่งต้นที่ผิดปกติให้ทันที</p>
    <div class="stats">
      <span class="pill">แปลงนำร่อง 1×20 เมตร</span>
      <span class="pill">กล้องสูง 150 ซม.</span>
      <span class="pill">ตรวจ 3 กลุ่มอาการ + สถานะสุขภาพ</span>
    </div>
    <div class="buttons">
      <a class="btn-primary" href="/dashboard">เปิด Dashboard</a>
      <a class="btn-ghost" href="#architecture">ดูสถาปัตยกรรมระบบ</a>
    </div>
  </div>
</section>

<section class="section" id="problem">
  <div class="wrap">
    <div class="eyebrow">โจทย์ปัญหาของผู้ใช้</div>
    <h2 style="font-size:30px;margin-top:8px;max-width:640px">เฝ้าดูทุกใบด้วยตาเปล่าทั่วแปลงไม่ไหว</h2>
    <p class="muted" style="max-width:720px;margin-top:12px">การเดินตรวจต้นชิโสะทุกต้นทุกวันใช้แรงงานมาก และกว่าจะสังเกตเห็นอาการด้วยตาเปล่าก็มักลุกลามไปแล้ว BaiDee จึงถูกออกแบบมาเฝ้าระวัง 3 ความผิดปกติหลักที่เกิดกับใบ:</p>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin-top:28px">
      <div class="card">
        <div style="width:44px;height:44px;border-radius:10px;background:#eaf3ec;color:var(--green-700);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" stroke="none"><circle cx="7" cy="8" r="2.2"/><circle cx="16" cy="6.5" r="1.6"/><circle cx="12" cy="13" r="2.6"/><circle cx="18" cy="14" r="1.8"/><circle cx="7" cy="17" r="1.6"/></svg></div>
        <h3 style="font-size:18px;margin-top:14px">โรคใบ / เชื้อรา</h3>
        <p class="muted" style="font-size:14px;margin-top:8px">จุดรา ราแป้ง downy mildew ที่ลุกลามเร็วถ้าไม่พบตั้งแต่ระยะเริ่มต้น</p>
      </div>
      <div class="card">
        <div style="width:44px;height:44px;border-radius:10px;background:#eaf3ec;color:var(--green-700);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3s6 6.5 6 11a6 6 0 1 1-12 0c0-4.5 6-11 6-11Z"/></svg></div>
        <h3 style="font-size:18px;margin-top:14px">ขาดน้ำ / ขาดธาตุอาหาร</h3>
        <p class="muted" style="font-size:14px;margin-top:8px">ใบเหลือง ซีด ขอบไหม้ ม้วนหรือเหี่ยว สัญญาณที่บอกปัญหาการดูแลแปลง</p>
      </div>
      <div class="card">
        <div style="width:44px;height:44px;border-radius:10px;background:#eaf3ec;color:var(--green-700);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><ellipse cx="12" cy="13" rx="5" ry="6.5"/><path d="M12 6.5V4M9 6l-1.5-2M15 6l1.5-2M4 11h3M4 15h3M17 11h3M17 15h3M8.5 19l-2 2M15.5 19l2 2"/></svg></div>
        <h3 style="font-size:18px;margin-top:14px">แมลงกัดกินใบ</h3>
        <p class="muted" style="font-size:14px;margin-top:8px">รอยรูทะลุ รอยแทะ ที่ต้องจับสัญญาณตั้งแต่ขนาดเล็กก่อนระบาด</p>
      </div>
    </div>
  </div>
</section>

<section class="section" id="goals" style="background:var(--cream-100)">
  <div class="wrap">
    <div class="eyebrow">เป้าหมายของการพัฒนา</div>
    <h2 style="font-size:30px;margin-top:8px;max-width:640px">ให้ AI ช่วยแบ่งเบาแรงงาน ไม่ใช่แทนที่เจ้าของแปลง</h2>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin-top:28px">
      <div class="card">
        <div style="width:44px;height:44px;border-radius:10px;background:#fff;color:var(--green-700);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v13M6 12l6 6 6-6"/></svg></div>
        <h3 style="font-size:17px;margin-top:14px">ลดแรงงานเจ้าของฟาร์ม</h3>
        <p class="muted" style="font-size:14px;margin-top:8px">ไม่ต้องเดินตรวจทุกต้นเอง ระบบคอยสอดส่องแทนตลอดเวลา</p>
      </div>
      <div class="card">
        <div style="width:44px;height:44px;border-radius:10px;background:#fff;color:var(--green-700);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg></div>
        <h3 style="font-size:17px;margin-top:14px">ตรวจบ่อยกว่าคน</h3>
        <p class="muted" style="font-size:14px;margin-top:8px">ถ่ายภาพตามรอบที่ตั้งไว้ (ปรับได้จาก dashboard) ไม่มีวันลา ไม่มีวันพลาดรอบ</p>
      </div>
      <div class="card">
        <div style="width:44px;height:44px;border-radius:10px;background:#fff;color:var(--green-700);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg></div>
        <h3 style="font-size:17px;margin-top:14px">แจ้งเตือนแม่นยำ</h3>
        <p class="muted" style="font-size:14px;margin-top:8px">มีกฎ cooldown และยืนยันซ้ำก่อนแจ้ง ลด false alarm ที่ทำให้คนเลิกเชื่อระบบ</p>
      </div>
      <div class="card">
        <div style="width:44px;height:44px;border-radius:10px;background:#fff;color:var(--green-700);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 21s7-7.2 7-12a7 7 0 1 0-14 0c0 4.8 7 12 7 12Z"/><circle cx="12" cy="9" r="2.4"/></svg></div>
        <h3 style="font-size:17px;margin-top:14px">บอกตำแหน่งต้นที่ผิดปกติ</h3>
        <p class="muted" style="font-size:14px;margin-top:8px">ระบุ โซน/แถว/ต้นที่ ด้วยป้าย AprilTag ไม่ต้องเดินหาทั้งแปลง</p>
      </div>
    </div>
  </div>
</section>

<section class="section" id="architecture">
  <div class="wrap">
    <div class="eyebrow">สถาปัตยกรรมของระบบ</div>
    <h2 style="font-size:30px;margin-top:8px;max-width:680px">5 ชั้นการทำงาน ตั้งแต่กล้องถึงมือเจ้าของฟาร์ม</h2>
    <div style="width:100%;overflow-x:auto;padding-bottom:8px;margin-top:28px">
    <div class="flow" style="min-width:960px">
      <div class="card step">
        <div style="width:40px;height:40px;border-radius:9px;background:#eaf3ec;color:var(--green-700);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M8 7l1.6-2.5h4.8L16 7"/><circle cx="12" cy="13.5" r="3.6"/></svg></div>
        <h3 style="font-size:15px;margin-top:12px">การตรวจวัด<br><span class="muted" style="font-weight:400;font-size:12px">Sensing</span></h3>
        <p class="muted" style="font-size:12.5px;margin-top:8px">ESP32-S3 CAM + OV3660 ถ่ายภาพใบตามตารางเวลาหรือสั่งถ่ายทันทีจาก dashboard</p>
      </div>
      <div class="arrow"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M7 4l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="card step">
        <div style="width:40px;height:40px;border-radius:9px;background:#eaf3ec;color:var(--green-700);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M9 6V3M15 6V3M9 21v-3M15 21v-3M6 9H3M6 15H3M21 9h-3M21 15h-3"/></svg></div>
        <h3 style="font-size:15px;margin-top:12px">โหนดควบคุม<br><span class="muted" style="font-weight:400;font-size:12px">Control Node</span></h3>
        <p class="muted" style="font-size:12.5px;margin-top:8px">ESP32 คัดกรองเบื้องต้น (HSV) + Raspberry Pi 5 ที่ตู้หัวแปลงตรวจซ้ำและระบุตำแหน่ง</p>
      </div>
      <div class="arrow"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M7 4l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="card step">
        <div style="width:40px;height:40px;border-radius:9px;background:#eaf3ec;color:var(--green-700);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9a11 11 0 0 1 16 0"/><path d="M7 12.5a7 7 0 0 1 10 0"/><path d="M10 16a3 3 0 0 1 4 0"/><circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none"/></svg></div>
        <h3 style="font-size:15px;margin-top:12px">การสื่อสาร<br><span class="muted" style="font-weight:400;font-size:12px">Communication</span></h3>
        <p class="muted" style="font-size:12.5px;margin-top:8px">Wi-Fi ในโรงเรือน + ส่งต่อเข้า Cloudflare Workers</p>
      </div>
      <div class="arrow"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M7 4l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="card step">
        <div style="width:40px;height:40px;border-radius:9px;background:#eaf3ec;color:var(--green-700);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3.4"/><circle cx="4" cy="6" r="1.7"/><circle cx="20" cy="6" r="1.7"/><circle cx="4" cy="18" r="1.7"/><circle cx="20" cy="18" r="1.7"/><path d="M9.6 10L5.4 7.1M14.4 10l4.2-2.9M9.6 14L5.4 16.9M14.4 14l4.2 2.9"/></svg></div>
        <h3 style="font-size:15px;margin-top:12px">การประมวลผล<br><span class="muted" style="font-weight:400;font-size:12px">Processing / AI</span></h3>
        <p class="muted" style="font-size:12.5px;margin-top:8px">RF-DETR (Apache-2.0) ตรวจ 3 คลาสอาการ + คำนวณ health_score ต่อภาพ</p>
      </div>
      <div class="arrow"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M7 4l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="card step">
        <div style="width:40px;height:40px;border-radius:9px;background:#eaf3ec;color:var(--green-700);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3a5 5 0 0 0-5 5v3a4 4 0 0 1-1 2.6L5 15h14l-1-1.4A4 4 0 0 1 17 11V8a5 5 0 0 0-5-5Z"/><path d="M9.5 18a2.5 2.5 0 0 0 5 0"/></svg></div>
        <h3 style="font-size:15px;margin-top:12px">แจ้งเตือน &amp; แสดงผล<br><span class="muted" style="font-weight:400;font-size:12px">Alert &amp; Display</span></h3>
        <p class="muted" style="font-size:12.5px;margin-top:8px">LINE Messaging API (พิวดี้) ส่งภาพครอป+ตำแหน่ง และ Cloudflare Dashboard</p>
      </div>
    </div>
    </div>
  </div>
</section>

<section class="section" id="roadmap" style="background:var(--cream-100)">
  <div class="wrap">
    <div class="eyebrow">ภาพรวมของระบบ &amp; แผนพัฒนา</div>
    <h2 style="font-size:30px;margin-top:8px;max-width:680px">จากกล้องในโรงเรือน ถึงมือถือเจ้าของฟาร์ม</h2>
    <p class="muted" style="margin-top:12px;font-size:14.5px">ESP32-S3 CAM → ตู้ควบคุม (Pi 5) → Cloudflare (Worker + R2 + D1) → LINE / Dashboard → เจ้าของฟาร์ม &nbsp;·&nbsp; ผู้ดูแลเข้าซ่อมบำรุง</p>
    <div style="width:100%;overflow-x:auto;padding-bottom:8px;margin-top:28px">
    <div class="flow" style="min-width:1040px;align-items:stretch">
      <div class="card step" style="position:relative">
        <span class="pill" style="background:#e3f3e8;color:var(--green-700);position:absolute;top:-12px;left:20px">กำลังพัฒนา</span>
        <div class="eyebrow" style="margin-top:6px">Phase 1 · 4-5 สัปดาห์</div>
        <h3 style="font-size:16px;margin-top:8px">ESP32 เก็บภาพ + ระบบระบุตำแหน่ง</h3>
        <p class="muted" style="font-size:13px;margin-top:8px">ท่อข้อมูลถ่าย-อัปโหลดเสถียร, รู้ coverage จริง, ทดสอบคำสั่งควบคุม/heartbeat จากระยะไกลแล้ว</p>
      </div>
      <div class="arrow"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M7 4l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="card step">
        <div class="eyebrow">Phase 2 · 4-6 สัปดาห์ (ขนาน)</div>
        <h3 style="font-size:16px;margin-top:8px">Dataset (Roboflow) + Train (Colab)</h3>
        <p class="muted" style="font-size:13px;margin-top:8px">เก็บภาพจริง label แล้ว bake-off โมเดล RF-DETR กับทางเลือก Apache-2.0 อื่น</p>
      </div>
      <div class="arrow"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M7 4l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="card step">
        <div class="eyebrow">Phase 3 · 4-5 สัปดาห์</div>
        <h3 style="font-size:16px;margin-top:8px">Web App บน Pi 5 + Cloudflare</h3>
        <p class="muted" style="font-size:13px;margin-top:8px">ตรวจ → ระบุตำแหน่ง → เก็บ → แจ้งเตือน → ดูผลผ่านเว็บครบวงจร (Dashboard ส่วนแรกใช้งานได้แล้ว)</p>
      </div>
      <div class="arrow"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M7 4l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="card step">
        <div class="eyebrow">Phase 4 · 4-6 สัปดาห์</div>
        <h3 style="font-size:16px;margin-top:8px">AI บน ESP32 + ทดสอบภาคสนาม</h3>
        <p class="muted" style="font-size:13px;margin-top:8px">คัดกรองสองขั้น (triage+verify) ลด false positive พิสูจน์ในสภาพจริงก่อนใช้งานจริง v1.0</p>
      </div>
    </div>
    </div>
  </div>
</section>

<section class="section" id="hardware">
  <div class="wrap">
    <div class="eyebrow">BOM — ฮาร์ดแวร์ที่ใช้</div>
    <h2 style="font-size:30px;margin-top:8px;max-width:680px">อุปกรณ์หน้างานต่อ 1 จุดติดตั้ง</h2>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr));margin-top:28px">
      <div class="card">
        <h3 style="font-size:16px">กล้องถ่ายภาพ (Edge Capture)</h3>
        <ul class="muted" style="font-size:13.5px;margin:10px 0 0;padding-left:18px">
          <li>ESP32-S3 CAM (MB0184, OV3660)</li>
          <li>16MB Flash / 8MB PSRAM</li>
          <li>เคสกันน้ำ IP65+ พร้อมฮูดกันหยด/แสงจ้า</li>
          <li>อะแดปเตอร์ไฟ 5V ≥ 2A</li>
        </ul>
      </div>
      <div class="card">
        <h3 style="font-size:16px">ตู้ควบคุมหัวแปลง</h3>
        <ul class="muted" style="font-size:13.5px;margin:10px 0 0;padding-left:18px">
          <li>Raspberry Pi 5 (8GB) + SSD/NVMe</li>
          <li>Access Point ในตู้</li>
          <li>UPS ขนาดเล็ก + ปลั๊กกันไฟกระชาก</li>
          <li>ตู้กันน้ำ/กันฝุ่น ระบายความร้อนได้</li>
        </ul>
      </div>
      <div class="card">
        <h3 style="font-size:16px">เครือข่ายระยะไกล</h3>
        <ul class="muted" style="font-size:13.5px;margin:10px 0 0;padding-left:18px">
          <li>Outdoor wireless Access point</li>
          <li>รองรับระยะ ~200 เมตรแบบเห็นกัน (LOS)</li>
          <li>เชื่อมตู้แปลง ↔ router/อินเทอร์เน็ต</li>
        </ul>
      </div>
      <div class="card">
        <h3 style="font-size:16px">ป้ายระบุตำแหน่ง</h3>
        <ul class="muted" style="font-size:13.5px;margin:10px 0 0;padding-left:18px">
          <li>Tag สำหรับเครื่องอ่าน</li>
          <li>QR code + ตัวเลขใหญ่ สำหรับคนสแกน</li>
          <li>แถบเทา 18% + แถบสีอ้างอิง ปรับ white balance</li>
          <li>วัสดุอะคริลิก/อะลูมิเนียม ทนยูวี</li>
        </ul>
      </div>
      <div class="card" style="border-style:dashed">
        <h3 style="font-size:16px">แผนขยาย (BaiDee Kit)</h3>
        <ul class="muted" style="font-size:13.5px;margin:10px 0 0;padding-left:18px">
          <li>เซนเซอร์ความชื้นดิน / อุณหภูมิ-ความชื้นอากาศ</li>
          <li>กล้อง 12MP (Pi Camera Module 3) ถ้าตัดสินใจขยาย</li>
          <li>รางเลื่อนกล้อง — รอผล Coverage Experiment</li>
        </ul>
      </div>
    </div>
  </div>
</section>

<section class="section" id="software" style="background:var(--cream-100)">
  <div class="wrap">
    <div class="eyebrow">Software + AI Model</div>
    <h2 style="font-size:30px;margin-top:8px;max-width:680px">สิ่งที่เจ้าของฟาร์มใช้งานได้จริง</h2>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr));margin-top:28px">
      <div class="card">
        <div style="width:44px;height:44px;border-radius:10px;background:#fff;color:var(--green-700);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/></svg></div>
        <h3 style="font-size:16px;margin-top:14px">Cloudflare Dashboard</h3>
        <ul class="muted" style="font-size:13.5px;margin:10px 0 0;padding-left:18px">
          <li>สถิติภาพรวม + สถานะกล้องรายโหนด (online/stale/offline)</li>
          <li>สั่งถ่ายภาพทันที / เปลี่ยน Wi-Fi / ตั้งรอบถ่ายจากระยะไกล</li>
          <li>แกลเลอรีภาพพร้อม thumbnail, preview เต็ม และ metadata</li>
          <li>ระบบผู้ใช้ (admin/viewer) ด้วย email + password</li>
        </ul>
      </div>
      <div class="card">
        <div style="width:44px;height:44px;border-radius:10px;background:#fff;color:var(--green-700);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3a5 5 0 0 0-5 5v3a4 4 0 0 1-1 2.6L5 15h14l-1-1.4A4 4 0 0 1 17 11V8a5 5 0 0 0-5-5Z"/><path d="M9.5 18a2.5 2.5 0 0 0 5 0"/></svg></div>
        <h3 style="font-size:16px;margin-top:14px">LINE Alert </h3>
        <ul class="muted" style="font-size:13.5px;margin:10px 0 0;padding-left:18px">
          <li>แจ้งตำแหน่งโซน/แถว/ต้นที่ผิดปกติ พร้อมภาพครอป</li>
          <li>พิมพ์คุยได้: "สถานะ" "ภาพล่าสุด" "ถ่ายเดี๋ยวนี้" "โซน 3"</li>
          <li>ปุ่มยืนยัน/ไม่ใช่ เก็บ feedback กลับเข้าระบบ</li>
          <li>สรุปรายวัน (digest) + cooldown ลด false alarm</li>
        </ul>
      </div>
      <div class="card">
        <div style="width:44px;height:44px;border-radius:10px;background:#fff;color:var(--green-700);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3.4"/><circle cx="4" cy="6" r="1.7"/><circle cx="20" cy="6" r="1.7"/><circle cx="4" cy="18" r="1.7"/><circle cx="20" cy="18" r="1.7"/><path d="M9.6 10L5.4 7.1M14.4 10l4.2-2.9M9.6 14L5.4 16.9M14.4 14l4.2 2.9"/></svg></div>
        <h3 style="font-size:16px;margin-top:14px">AI Detection Model</h3>
        <ul class="muted" style="font-size:13.5px;margin:10px 0 0;padding-left:18px">
          <li>RF-DETR (Apache-2.0) ตรวจ LEAF_STRESS, PEST_DAMAGE, FUNGAL_INFECTION</li>
          <li>HEALTHY เป็นสถานะที่คำนวณได้ + health_score ต่อภาพ</li>
          <li>ระบุพิกัดโซน/แถว/ต้นด้วย Tag homography</li>
          <li>Human-in-the-loop: ผลยืนยัน/แก้ไขป้อนกลับเข้า dataset</li>
        </ul>
      </div>
    </div>
  </div>
</section>

<footer>
  <div class="wrap inner">
    <div>© PWD Vision Works · BaiDee (ใบดี) — อยู่ระหว่างพัฒนา Phase 1</div>
    <a href="/dashboard" style="color:#fff;font-weight:600">เข้าสู่ Dashboard →</a>
  </div>
</footer>

</body>
</html>`;
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BaiDee Dashboard</title>
<style>
  :root { color-scheme: light dark; --bg:#0f1512; --card:#17201b; --fg:#e7f0ea; --muted:#8fa196; --accent:#4caf7d; --border:#25322b; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); }
  header { padding: 16px 20px; border-bottom: 1px solid var(--border); display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; }
  header h1 { font-size: 18px; margin:0; }
  main { padding: 20px; max-width: 1200px; margin: 0 auto; }
  .stats { display:grid; grid-template-columns: repeat(auto-fit, minmax(160px,1fr)); gap:12px; margin-bottom:20px; }
  .stat-card { background: var(--card); border:1px solid var(--border); border-radius:10px; padding:14px; }
  .stat-card .label { color: var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .stat-card .value { font-size:24px; font-weight:600; margin-top:4px; }
  section { background: var(--card); border:1px solid var(--border); border-radius:10px; padding:16px; margin-bottom:20px; }
  section h2 { margin-top:0; font-size:15px; }
  table { width:100%; border-collapse: collapse; font-size:13px; }
  th, td { text-align:left; padding:8px; border-bottom:1px solid var(--border); vertical-align:middle; }
  th { color: var(--muted); font-weight:500; }
  img.thumb { width:64px; height:48px; object-fit:cover; border-radius:6px; cursor:pointer; background:#222; }
  .badge { padding:2px 8px; border-radius:999px; font-size:11px; }
  .badge.ok { background:#1e3d2c; color:#7be3a5; }
  .badge.warn { background:#3d2f1e; color:#e3b97b; }
  .badge.bad { background:#3d1e1e; color:#e37b7b; }
  button, input, select { font: inherit; }
  button { background: var(--accent); color:#06180f; border:none; border-radius:6px; padding:6px 12px; cursor:pointer; font-weight:600; }
  button.secondary { background: transparent; color: var(--fg); border:1px solid var(--border); }
  input, select { background:#0f1512; color: var(--fg); border:1px solid var(--border); border-radius:6px; padding:6px 10px; }
  #modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,.75); align-items:center; justify-content:center; padding:20px; z-index:10; }
  #modal img { max-width:90vw; max-height:80vh; border-radius:8px; }
  #modal pre { color:#cde; max-width:90vw; overflow:auto; background:#0f1512; padding:12px; border-radius:8px; }
  #loginGate { max-width:360px; margin: 80px auto; text-align:center; }
  #loginGate input { width:100%; margin:10px 0; }
  #loginError { color:#e37b7b; min-height:1.2em; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .node-card { border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:10px; }
  .node-card h3 { margin:0 0 6px; font-size:14px; }
  .muted { color: var(--muted); font-size:12px; }
</style>
</head>
<body>
<div id="loginGate">
  <h2>BaiDee Dashboard</h2>
  <p class="muted">Sign in with your BaiDee account.</p>
  <input id="loginEmail" type="email" placeholder="Email" autocomplete="username">
  <input id="loginPassword" type="password" placeholder="Password" autocomplete="current-password">
  <button id="loginSubmit">Sign in</button>
  <p id="loginError"></p>
</div>
<div id="app" style="display:none">
<header>
  <h1>BaiDee Dashboard</h1>
  <div class="row">
    <span class="muted" id="whoami"></span>
    <button class="secondary" id="refreshBtn">Refresh</button>
    <button class="secondary" id="logoutBtn">Sign out</button>
  </div>
</header>
<main>
  <div class="stats" id="stats"></div>

  <section>
    <h2>Camera nodes</h2>
    <div id="nodes"></div>
  </section>

  <section>
    <h2>Recent captures</h2>
    <div class="row" style="margin-bottom:10px">
      <input id="nodeFilter" placeholder="filter by node_id">
      <input id="fromFilter" type="date" title="from date">
      <input id="toFilter" type="date" title="to date">
      <select id="pageSize">
        <option value="50">50 / page</option>
        <option value="100">100 / page</option>
      </select>
      <button class="secondary" id="filterBtn">Filter</button>
      <button class="secondary" id="exportBtn">Download export (zip)</button>
    </div>
    <table>
      <thead><tr><th>Image</th><th>Capture</th><th>Node</th><th>Time (Bangkok)</th><th>Stage</th><th>Status</th><th>Notes</th><th></th></tr></thead>
      <tbody id="captureRows"></tbody>
    </table>
    <div class="row" style="margin-top:12px; justify-content:space-between">
      <span class="muted" id="captureRange"></span>
      <div class="row">
        <button class="secondary" id="prevPageBtn">&larr; Prev</button>
        <span class="muted" id="pageLabel"></span>
        <button class="secondary" id="nextPageBtn">Next &rarr;</button>
      </div>
    </div>
  </section>

  <section id="usersSection" style="display:none">
    <h2>Users</h2>
    <p class="muted">Create a new account or reset an existing one's password. Only admins can see this section.</p>
    <div class="row" style="margin-bottom:10px">
      <input id="newUserEmail" type="email" placeholder="email@example.com">
      <input id="newUserPassword" type="password" placeholder="password (min 8 chars)">
      <select id="newUserRole">
        <option value="admin">admin</option>
        <option value="viewer">viewer</option>
      </select>
      <button id="createUserBtn">Create / reset user</button>
    </div>
    <table>
      <thead><tr><th>Email</th><th>Role</th><th>Created</th><th></th></tr></thead>
      <tbody id="userRows"></tbody>
    </table>
  </section>
</main>
</div>

<div id="modal">
  <div>
    <img id="modalImg">
    <pre id="modalMeta"></pre>
  </div>
</div>

<script>
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let currentUser = null;
let captureOffset = 0;
let captureLimit = 50;

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, credentials: "same-origin" });
  if (response.status === 401) { showGate(); throw new Error("unauthorized"); }
  return response;
}

function showGate() {
  document.getElementById("loginGate").style.display = "block";
  document.getElementById("app").style.display = "none";
}
function showApp() {
  document.getElementById("loginGate").style.display = "none";
  document.getElementById("app").style.display = "block";
  document.getElementById("usersSection").style.display = currentUser && currentUser.role === "admin" ? "block" : "none";
  document.getElementById("whoami").textContent = currentUser ? currentUser.email + " (" + currentUser.role + ")" : "";
  loadAll();
}

document.getElementById("loginSubmit").onclick = async () => {
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errorEl = document.getElementById("loginError");
  errorEl.textContent = "";
  if (!email || !password) { errorEl.textContent = "Enter your email and password."; return; }
  const response = await fetch("/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) { errorEl.textContent = "Invalid email or password."; return; }
  currentUser = await response.json();
  showApp();
};
document.getElementById("loginPassword").addEventListener("keydown", (event) => {
  if (event.key === "Enter") document.getElementById("loginSubmit").click();
});
document.getElementById("logoutBtn").onclick = async () => {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
  currentUser = null;
  showGate();
};
document.getElementById("refreshBtn").onclick = loadAll;
document.getElementById("filterBtn").onclick = () => { captureOffset = 0; loadCaptures(); };
document.getElementById("pageSize").onchange = (event) => { captureLimit = Number(event.target.value); captureOffset = 0; loadCaptures(); };
document.getElementById("prevPageBtn").onclick = () => { captureOffset = Math.max(0, captureOffset - captureLimit); loadCaptures(); };
document.getElementById("nextPageBtn").onclick = () => { captureOffset += captureLimit; loadCaptures(); };
document.getElementById("exportBtn").onclick = () => {
  const params = captureFilterParams();
  window.location.href = "/v1/export?" + params.toString();
};
document.getElementById("modal").onclick = () => { document.getElementById("modal").style.display = "none"; };

function bangkokTime(iso) {
  try {
    return new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", hour12: false });
  } catch { return iso; }
}

function fmtBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B","KB","MB","GB"];
  let i = 0; let value = bytes;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return value.toFixed(1) + " " + units[i];
}

async function loadStats() {
  const response = await api("/v1/stats");
  const data = await response.json();
  const el = document.getElementById("stats");
  el.innerHTML = [
    ["Total captures", data.total_captures],
    ["Camera nodes", data.total_nodes],
    ["Today's captures", data.today.capture_count],
    ["Today's storage", fmtBytes(data.today.image_bytes)],
  ].map(([label, value]) => \`<div class="stat-card"><div class="label">\${label}</div><div class="value">\${value}</div></div>\`).join("");
}

function refreshSoon() {
  // The device polls for commands roughly every 45s and then needs a few
  // seconds to execute, upload, and ack, so one immediate refresh will
  // rarely show the result. Check back a few times over the next minute.
  loadAll();
  for (const delayMs of [15000, 30000, 60000, 90000]) {
    setTimeout(loadAll, delayMs);
  }
}

async function sendCommand(nodeId, command, args) {
  const response = await api("/v1/cmd", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ node_id: nodeId, command, args: args || {} }),
  });
  if (response.ok) {
    alert(command + " queued for " + nodeId + ". The device checks for commands about every 45s, so it can take up to 1-2 minutes to show up below — this page will auto-refresh a few times.");
    refreshSoon();
  } else {
    const data = await response.json().catch(() => ({}));
    alert(data.error || "failed to queue command");
  }
}

function nodeBadge(node) {
  if (!node.last_seen_at) return '<span class="badge bad">never seen</span>';
  const ageMs = Date.now() - new Date(node.last_seen_at).getTime();
  if (ageMs < 15 * 60 * 1000) return '<span class="badge ok">online</span>';
  if (ageMs < 6 * 60 * 60 * 1000) return '<span class="badge warn">stale</span>';
  return '<span class="badge bad">offline</span>';
}

async function loadNodes() {
  const response = await api("/v1/nodes");
  const data = await response.json();
  const el = document.getElementById("nodes");
  if (!data.nodes.length) { el.innerHTML = '<p class="muted">No heartbeat received yet.</p>'; return; }
  const canControl = currentUser && currentUser.role === "admin";
  el.innerHTML = data.nodes.map((node) => \`
    <div class="node-card" data-node="\${escapeHtml(node.node_id)}">
      <h3>\${escapeHtml(node.node_id)} \${nodeBadge(node)}</h3>
      <p class="muted">last seen \${bangkokTime(node.last_seen_at)} · fw \${escapeHtml(node.fw_version || "-")} · ip \${escapeHtml(node.wifi_ip || "-")} · rssi \${node.rssi ?? "-"} dBm · uptime \${node.uptime_ms ? Math.round(node.uptime_ms/60000)+"m" : "-"}</p>
      <div class="row">
        \${canControl
          ? '<button class="captureNowBtn">Capture now</button><button class="secondary wifiBtn">Change Wi-Fi</button><button class="secondary intervalBtn">Set capture interval</button>'
          : '<span class="muted">viewer (read-only)</span>'}
      </div>
    </div>\`).join("");
}

document.getElementById("nodes").addEventListener("click", (event) => {
  const card = event.target.closest(".node-card");
  if (!card) return;
  const nodeId = card.dataset.node;
  if (event.target.closest(".captureNowBtn")) sendCommand(nodeId, "capture_now");
  else if (event.target.closest(".wifiBtn")) promptWifi(nodeId);
  else if (event.target.closest(".intervalBtn")) promptInterval(nodeId);
});

function promptWifi(nodeId) {
  const ssid = prompt("New Wi-Fi SSID for " + nodeId);
  if (!ssid) return;
  const password = prompt("New Wi-Fi password");
  if (password === null) return;
  sendCommand(nodeId, "set_wifi", { ssid, password });
}

function promptInterval(nodeId) {
  const minutes = prompt("Capture interval in minutes for " + nodeId, "60");
  if (!minutes) return;
  sendCommand(nodeId, "set_config", { capture_interval_ms: Number(minutes) * 60000 });
}

async function openPreview(captureId, meta) {
  const response = await api("/v1/image/" + encodeURIComponent(captureId));
  const blob = await response.blob();
  document.getElementById("modalImg").src = URL.createObjectURL(blob);
  document.getElementById("modalMeta").textContent = JSON.stringify(meta, null, 2);
  document.getElementById("modal").style.display = "flex";
}

const thumbCache = new Map();
async function thumbSrc(captureId) {
  if (thumbCache.has(captureId)) return thumbCache.get(captureId);
  const response = await api("/v1/image/" + encodeURIComponent(captureId));
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  thumbCache.set(captureId, url);
  return url;
}

function captureFilterParams() {
  const params = new URLSearchParams();
  const node = document.getElementById("nodeFilter").value.trim();
  const from = document.getElementById("fromFilter").value;
  const to = document.getElementById("toFilter").value;
  if (node) params.set("node", node);
  if (from) params.set("from", from + "T00:00:00Z");
  if (to) params.set("to", to + "T23:59:59Z");
  return params;
}

async function loadCaptures() {
  const params = captureFilterParams();
  params.set("limit", String(captureLimit));
  params.set("offset", String(captureOffset));
  const response = await api("/v1/captures?" + params.toString());
  const data = await response.json();
  const tbody = document.getElementById("captureRows");
  const canControl = currentUser && currentUser.role === "admin";
  tbody.innerHTML = data.captures.map((capture) => \`
    <tr data-id="\${escapeHtml(capture.capture_id)}">
      <td><img class="thumb" id="thumb-\${escapeHtml(capture.capture_id)}"></td>
      <td>\${escapeHtml(capture.capture_id)}</td>
      <td>\${escapeHtml(capture.node_id)}</td>
      <td>\${bangkokTime(capture.captured_at)}</td>
      <td>\${escapeHtml(capture.stage)}</td>
      <td>\${escapeHtml(capture.payload?.status || "-")}</td>
      <td class="muted" style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${escapeHtml(capture.notes || "-")}</td>
      <td>\${canControl
        ? \`<button class="secondary editNotesBtn" data-id="\${escapeHtml(capture.capture_id)}">Edit</button> <button class="secondary deleteCaptureBtn" data-id="\${escapeHtml(capture.capture_id)}">Delete</button>\`
        : ""}</td>
    </tr>\`).join("");
  for (const capture of data.captures) {
    thumbSrc(capture.capture_id).then((src) => {
      const img = document.getElementById("thumb-" + capture.capture_id);
      if (img) { img.src = src; img.onclick = () => openPreview(capture.capture_id, capture.payload); }
    });
  }
  const start = data.total === 0 ? 0 : captureOffset + 1;
  const end = Math.min(captureOffset + data.captures.length, data.total);
  document.getElementById("captureRange").textContent = data.total === 0 ? "No captures match" : \`Showing \${start}-\${end} of \${data.total}\`;
  document.getElementById("pageLabel").textContent = \`Page \${Math.floor(captureOffset / captureLimit) + 1} of \${Math.max(1, Math.ceil(data.total / captureLimit))}\`;
  document.getElementById("prevPageBtn").disabled = captureOffset <= 0;
  document.getElementById("nextPageBtn").disabled = captureOffset + captureLimit >= data.total;
}

document.getElementById("captureRows").addEventListener("click", (event) => {
  const editBtn = event.target.closest(".editNotesBtn");
  const deleteBtn = event.target.closest(".deleteCaptureBtn");
  if (editBtn) editCaptureNotes(editBtn.dataset.id);
  else if (deleteBtn) deleteCaptureRow(deleteBtn.dataset.id);
});

async function editCaptureNotes(captureId) {
  const notes = prompt("Notes for " + captureId, "");
  if (notes === null) return;
  const response = await api("/v1/captures/" + encodeURIComponent(captureId), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ notes: notes || null }),
  });
  if (response.ok) loadCaptures(); else alert("failed to save notes");
}

async function deleteCaptureRow(captureId) {
  if (!confirm("Delete capture " + captureId + "? This removes the image from storage too and cannot be undone.")) return;
  const response = await api("/v1/captures/" + encodeURIComponent(captureId), { method: "DELETE" });
  if (response.ok) loadCaptures(); else alert("failed to delete capture");
}

document.getElementById("createUserBtn").onclick = async () => {
  const email = document.getElementById("newUserEmail").value.trim();
  const password = document.getElementById("newUserPassword").value;
  const role = document.getElementById("newUserRole").value;
  if (!email || !password) { alert("Email and password are required."); return; }
  const response = await api("/auth/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, role }),
  });
  const data = await response.json().catch(() => ({}));
  if (response.ok) {
    document.getElementById("newUserEmail").value = "";
    document.getElementById("newUserPassword").value = "";
    loadUsers();
  } else {
    alert(data.error || "failed to save user");
  }
};

document.getElementById("userRows").addEventListener("click", (event) => {
  const btn = event.target.closest(".deleteUserBtn");
  if (btn) deleteUserAccount(btn.dataset.email);
});

async function deleteUserAccount(email) {
  if (!confirm("Delete user " + email + "?")) return;
  const response = await api("/auth/users/" + encodeURIComponent(email), { method: "DELETE" });
  const data = await response.json().catch(() => ({}));
  if (response.ok) loadUsers(); else alert(data.error || "failed to delete user");
}

async function loadUsers() {
  if (!currentUser || currentUser.role !== "admin") return;
  const response = await api("/auth/users");
  const data = await response.json();
  const tbody = document.getElementById("userRows");
  tbody.innerHTML = data.users.map((u) => {
    const protectedAccount = u.email === currentUser.email || u.email === "baidee@pwdvisionworks.com";
    const deleteCell = protectedAccount ? "" : \`<button class="secondary deleteUserBtn" data-email="\${escapeHtml(u.email)}">Delete</button>\`;
    return \`<tr><td>\${escapeHtml(u.email)}</td><td>\${escapeHtml(u.role)}</td><td>\${bangkokTime(u.created_at)}</td><td>\${deleteCell}</td></tr>\`;
  }).join("");
}

async function loadAll() {
  await Promise.all([loadStats(), loadNodes(), loadCaptures(), loadUsers()]);
}

(async () => {
  try {
    const response = await fetch("/auth/me", { credentials: "same-origin" });
    if (response.ok) {
      currentUser = await response.json();
      showApp();
      return;
    }
  } catch {}
  showGate();
})();
</script>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(landingHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (request.method === "GET" && url.pathname === "/api") {
      return json({
        service: "baidee-api",
        status: "ok",
        version: "0.4.0",
        endpoints: [
          "/healthz", "/dashboard",
          "/v1/ingest", "/v1/captures", "/v1/captures/{capture_id} (PATCH)", "/v1/captures/{capture_id} (DELETE)",
          "/v1/image/{capture_id}", "/v1/export", "/v1/stats",
          "/v1/cmd", "/v1/cmd (POST)", "/v1/cmd/ack", "/v1/heartbeat", "/v1/nodes",
          "/auth/bootstrap", "/auth/login", "/auth/logout", "/auth/me",
          "/auth/users", "/auth/users (POST)", "/auth/users/{email} (DELETE)",
        ],
      });
    }
    if (request.method === "GET" && url.pathname === "/healthz") return json({ status: "ok" });
    if (request.method === "GET" && url.pathname === "/dashboard") {
      return new Response(dashboardHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (request.method === "POST" && url.pathname === "/auth/bootstrap") {
      try {
        return await bootstrapAdmin(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "bootstrap_failed", error: String(error) }));
        return json({ error: "could not bootstrap admin" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/auth/login") {
      try {
        return await login(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "login_failed", error: String(error) }));
        return json({ error: "could not log in" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/auth/logout") return logout();
    if (request.method === "GET" && url.pathname === "/auth/me") {
      try {
        return await me(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "me_failed", error: String(error) }));
        return json({ error: "could not load session" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/auth/users") {
      try {
        return await listUsers(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "list_users_failed", error: String(error) }));
        return json({ error: "could not list users" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/auth/users") {
      try {
        return await createOrUpdateUser(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "create_user_failed", error: String(error) }));
        return json({ error: "could not save user" }, 500);
      }
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/auth/users/")) {
      try {
        return await deleteUser(request, env, decodeURIComponent(url.pathname.slice("/auth/users/".length)));
      } catch (error) {
        console.error(JSON.stringify({ event: "delete_user_failed", error: String(error) }));
        return json({ error: "could not delete user" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/v1/captures") {
      try {
        return await listCaptures(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "captures_failed", error: String(error) }));
        return json({ error: "could not list captures" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname.startsWith("/v1/image/")) {
      try {
        return await getImage(request, env, decodeURIComponent(url.pathname.slice("/v1/image/".length)));
      } catch (error) {
        console.error(JSON.stringify({ event: "image_failed", error: String(error) }));
        return json({ error: "could not load image" }, 500);
      }
    }
    if (request.method === "PATCH" && url.pathname.startsWith("/v1/captures/")) {
      try {
        return await updateCapture(request, env, decodeURIComponent(url.pathname.slice("/v1/captures/".length)));
      } catch (error) {
        console.error(JSON.stringify({ event: "update_capture_failed", error: String(error) }));
        return json({ error: "could not update capture" }, 500);
      }
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/v1/captures/")) {
      try {
        return await deleteCapture(request, env, decodeURIComponent(url.pathname.slice("/v1/captures/".length)));
      } catch (error) {
        console.error(JSON.stringify({ event: "delete_capture_failed", error: String(error) }));
        return json({ error: "could not delete capture" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/v1/export") {
      try {
        return await exportCaptures(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "export_failed", error: String(error) }));
        return json({ error: "could not build export" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/v1/stats") {
      try {
        return await getStats(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "stats_failed", error: String(error) }));
        return json({ error: "could not load stats" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/v1/nodes") {
      try {
        return await listNodes(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "nodes_failed", error: String(error) }));
        return json({ error: "could not load nodes" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/v1/cmd") return listCommands(request, env);
    if (request.method === "POST" && url.pathname === "/v1/cmd") {
      try {
        return await enqueueCommand(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "enqueue_command_failed", error: String(error) }));
        return json({ error: "could not enqueue command" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/cmd/ack") {
      try {
        return await ackCommand(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "ack_command_failed", error: String(error) }));
        return json({ error: "could not ack command" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/heartbeat") {
      try {
        return await heartbeat(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "heartbeat_failed", error: String(error) }));
        return json({ error: "could not record heartbeat" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/ingest") {
      try {
        return await ingest(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "ingest_failed", error: String(error) }));
        return json({ error: "ingest failed" }, 500);
      }
    }
    return json({ error: "not found" }, 404);
  },
};
