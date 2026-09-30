export interface Env {
  IMAGES: R2Bucket;
  DB: D1Database;
  BAIDEE_HMAC_SECRET: string;
  BAIDEE_API_TOKEN?: string;
}

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

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

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

function hexToBytes(value: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/i.test(value)) return new Uint8Array();
  return new Uint8Array(value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
}

async function verifySignature(payload: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  const expected = hexToBytes(signature);
  if (expected.length !== digest.length) return false;
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

function imageKey(payload: CapturePayload): string {
  const date = payload.timestamp.slice(0, 10).replaceAll("-", "/");
  return `raw/${payload.site_id}/${payload.bed_id}/${date}/${payload.capture_id}.jpg`;
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

  const key = imageKey(payload);
  await env.IMAGES.put(key, image.stream(), {
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

  return json({ accepted: true, duplicate: false, capture_id: payload.capture_id });
}

async function listCaptures(request: Request, env: Env): Promise<Response> {
  if (!(await verifyApiToken(request, env.BAIDEE_API_TOKEN))) return json({ error: "unauthorized" }, 401);
  const url = new URL(request.url);
  const node = url.searchParams.get("node");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100) : 50;
  const conditions: string[] = [];
  const bindings: string[] = [];
  if (node) {
    conditions.push("node_id = ?");
    bindings.push(node);
  }
  if (from) {
    conditions.push("captured_at >= ?");
    bindings.push(from);
  }
  if (to) {
    conditions.push("captured_at <= ?");
    bindings.push(to);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await env.DB.prepare(
    `SELECT capture_id, node_id, site_id, bed_id, captured_at, stage, payload_json, image_key
     FROM captures ${where} ORDER BY captured_at DESC LIMIT ?`,
  ).bind(...bindings, limit).all<{
    capture_id: string;
    node_id: string;
    site_id: string;
    bed_id: string;
    captured_at: string;
    stage: string;
    payload_json: string;
    image_key: string;
  }>();
  return json({ captures: result.results.map((capture) => ({
    ...capture,
    payload: JSON.parse(capture.payload_json),
    payload_json: undefined,
  })) });
}

async function listCommands(request: Request, env: Env): Promise<Response> {
  const node = new URL(request.url).searchParams.get("node");
  const signature = request.headers.get("x-signature");
  if (!node || !(await verifySignature(node, signature, env.BAIDEE_HMAC_SECRET))) {
    return json({ error: "invalid node authentication" }, 401);
  }
  return json({ node_id: node, commands: [] });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return json({ status: "ok" });
    if (request.method === "GET" && url.pathname === "/v1/captures") {
      try {
        return await listCaptures(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "captures_failed", error: String(error) }));
        return json({ error: "could not list captures" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/v1/cmd") return listCommands(request, env);
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
