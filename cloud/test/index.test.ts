import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import { FakeD1 } from "./fakeD1";
import { FakeR2 } from "./fakeR2";

const secret = "test-secret";
let db: FakeD1;
let images: FakeR2;
let env: Env;

beforeEach(() => {
  db = new FakeD1();
  images = new FakeR2();
  env = {
    DB: db as unknown as Env["DB"],
    IMAGES: images as unknown as Env["IMAGES"],
    BAIDEE_HMAC_SECRET: secret,
    BAIDEE_API_TOKEN: "read-token",
    BAIDEE_SESSION_SECRET: "test-session-secret",
  } as unknown as Env;
});

function sessionCookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected a set-cookie header");
  return setCookie.split(";")[0];
}

async function sign(value: string): Promise<string> {
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

describe("BaiDee Worker", () => {
  it("returns a health response", async () => {
    const response = await worker.fetch(new Request("https://baidee.test/healthz"), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("requires a bearer token for capture queries", async () => {
    const response = await worker.fetch(new Request("https://baidee.test/v1/captures"), env);
    expect(response.status).toBe(401);
  });

  it("authenticates camera command polling with node HMAC", async () => {
    const node = "bd-s01-b01-c01";
    const response = await worker.fetch(
      new Request(`https://baidee.test/v1/cmd?node=${node}`, { headers: { "x-signature": await sign(node) } }),
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ node_id: node, commands: [] });
  });

  it("rejects unauthenticated command polling", async () => {
    const response = await worker.fetch(
      new Request("https://baidee.test/v1/cmd?node=bd-s01-b01-c01"),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("rejects command enqueue without a bearer token", async () => {
    const response = await worker.fetch(
      new Request("https://baidee.test/v1/cmd", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ node_id: "bd-s01-b01-c01", command: "capture_now" }),
      }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("rejects an unknown command type on enqueue", async () => {
    const response = await worker.fetch(
      new Request("https://baidee.test/v1/cmd", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer read-token" },
        body: JSON.stringify({ node_id: "bd-s01-b01-c01", command: "reboot" }),
      }),
      env,
    );
    expect(response.status).toBe(422);
  });

  it("enqueues a command and delivers it once to the node, then allows acking it", async () => {
    const node = "bd-s01-b01-c01";
    const enqueueResponse = await worker.fetch(
      new Request("https://baidee.test/v1/cmd", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer read-token" },
        body: JSON.stringify({ node_id: node, command: "capture_now" }),
      }),
      env,
    );
    expect(enqueueResponse.status).toBe(201);
    const enqueued = await enqueueResponse.json() as { id: number };

    const pollResponse = await worker.fetch(
      new Request(`https://baidee.test/v1/cmd?node=${node}`, { headers: { "x-signature": await sign(node) } }),
      env,
    );
    const polled = await pollResponse.json() as { commands: Array<{ id: number; command: string }> };
    expect(polled.commands).toEqual([{ id: enqueued.id, command: "capture_now", args: {} }]);

    // Delivered commands are not handed out again.
    const secondPoll = await worker.fetch(
      new Request(`https://baidee.test/v1/cmd?node=${node}`, { headers: { "x-signature": await sign(node) } }),
      env,
    );
    await expect(secondPoll.json()).resolves.toEqual({ node_id: node, commands: [] });

    const ackCanonical = `${node}:${enqueued.id}:done`;
    const ackResponse = await worker.fetch(
      new Request("https://baidee.test/v1/cmd/ack", {
        method: "POST",
        headers: { "content-type": "application/json", "x-signature": await sign(ackCanonical) },
        body: JSON.stringify({ node_id: node, command_id: enqueued.id, status: "done" }),
      }),
      env,
    );
    expect(ackResponse.status).toBe(200);
  });

  it("rejects a command ack with an invalid signature", async () => {
    const response = await worker.fetch(
      new Request("https://baidee.test/v1/cmd/ack", {
        method: "POST",
        headers: { "content-type": "application/json", "x-signature": "00" },
        body: JSON.stringify({ node_id: "bd-s01-b01-c01", command_id: 1, status: "done" }),
      }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("records a heartbeat and exposes it through /v1/nodes", async () => {
    const node = "bd-s01-b01-c01";
    const body = JSON.stringify({ node_id: node, timestamp: "2026-09-30T08:00:00Z", fw_version: "0.2.0", rssi: -60 });
    const response = await worker.fetch(
      new Request("https://baidee.test/v1/heartbeat", {
        method: "POST",
        headers: { "x-node-id": node, "x-signature": await sign(body) },
        body,
      }),
      env,
    );
    expect(response.status).toBe(200);

    const nodesResponse = await worker.fetch(
      new Request("https://baidee.test/v1/nodes", { headers: { authorization: "Bearer read-token" } }),
      env,
    );
    const data = await nodesResponse.json() as { nodes: Array<{ node_id: string; fw_version: string }> };
    expect(data.nodes).toHaveLength(1);
    expect(data.nodes[0].node_id).toBe(node);
    expect(data.nodes[0].fw_version).toBe("0.2.0");
  });

  it("rejects a heartbeat with a mismatched node id", async () => {
    const body = JSON.stringify({ node_id: "bd-s01-b01-c01", timestamp: "2026-09-30T08:00:00Z" });
    const response = await worker.fetch(
      new Request("https://baidee.test/v1/heartbeat", {
        method: "POST",
        headers: { "x-node-id": "bd-s01-b01-c02", "x-signature": await sign(body) },
        body,
      }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("serves the dashboard as HTML", async () => {
    const response = await worker.fetch(new Request("https://baidee.test/dashboard"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("serves the landing page at / with a nav link to /dashboard", async () => {
    const response = await worker.fetch(new Request("https://baidee.test/"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain('href="/dashboard"');
  });

  it("keeps the old root JSON service info available at /api", async () => {
    const response = await worker.fetch(new Request("https://baidee.test/api"), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ service: "baidee-api" });
  });
});

async function adminCookie(): Promise<string> {
  await worker.fetch(
    new Request("https://baidee.test/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer read-token" },
      body: JSON.stringify({ password: "correct horse battery" }),
    }),
    env,
  );
  const login = await worker.fetch(
    new Request("https://baidee.test/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "baidee@pwdvisionworks.com", password: "correct horse battery" }),
    }),
    env,
  );
  return sessionCookieFrom(login);
}

async function seedCapture(id: string, capturedAt: string, options: { nodeId?: string; withImage?: boolean } = {}) {
  const nodeId = options.nodeId ?? "bd-s01-b01-c01";
  const imageKey = `raw/s01/b01/${capturedAt.slice(0, 4)}/${capturedAt.slice(5, 7)}/${capturedAt.slice(8, 10)}/${id}.jpg`;
  db.captures.push({
    capture_id: id,
    node_id: nodeId,
    site_id: "s01",
    bed_id: "b01",
    captured_at: capturedAt,
    stage: "edge_triage",
    notes: null,
    payload_json: JSON.stringify({ status: "HEALTHY" }),
    image_key: imageKey,
  });
  if (options.withImage !== false) {
    await images.put(imageKey, new TextEncoder().encode("fake-jpeg-bytes"), { httpMetadata: { contentType: "image/jpeg" } });
  }
}

describe("Capture management: pagination, update, delete, export", () => {
  it("paginates captures and reports a total count independent of the page", async () => {
    for (let i = 0; i < 5; i++) await seedCapture(`cap-${i}`, `2026-10-0${i + 1}T00:00:00Z`);
    const cookie = await adminCookie();

    const firstPage = await worker.fetch(
      new Request("https://baidee.test/v1/captures?limit=2&offset=0", { headers: { cookie } }),
      env,
    );
    const firstData = await firstPage.json() as { captures: Array<{ capture_id: string }>; total: number };
    expect(firstData.total).toBe(5);
    expect(firstData.captures).toHaveLength(2);
    expect(firstData.captures[0].capture_id).toBe("cap-4"); // newest first

    const secondPage = await worker.fetch(
      new Request("https://baidee.test/v1/captures?limit=2&offset=2", { headers: { cookie } }),
      env,
    );
    const secondData = await secondPage.json() as { captures: Array<{ capture_id: string }>; total: number };
    expect(secondData.total).toBe(5);
    expect(secondData.captures.map((c) => c.capture_id)).toEqual(["cap-2", "cap-1"]);
  });

  it("filters captures by a date range", async () => {
    await seedCapture("cap-early", "2026-09-01T00:00:00Z");
    await seedCapture("cap-mid", "2026-09-15T00:00:00Z");
    await seedCapture("cap-late", "2026-09-30T00:00:00Z");
    const cookie = await adminCookie();

    const response = await worker.fetch(
      new Request("https://baidee.test/v1/captures?from=2026-09-10&to=2026-09-20", { headers: { cookie } }),
      env,
    );
    const data = await response.json() as { captures: Array<{ capture_id: string }>; total: number };
    expect(data.total).toBe(1);
    expect(data.captures[0].capture_id).toBe("cap-mid");
  });

  it("lets an admin set a capture's notes", async () => {
    await seedCapture("cap-1", "2026-10-01T00:00:00Z");
    const cookie = await adminCookie();
    const response = await worker.fetch(
      new Request("https://baidee.test/v1/captures/cap-1", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ notes: "blurry, needs recapture" }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    const list = await worker.fetch(new Request("https://baidee.test/v1/captures", { headers: { cookie } }), env);
    const data = await list.json() as { captures: Array<{ notes: string | null }> };
    expect(data.captures[0].notes).toBe("blurry, needs recapture");
  });

  it("rejects a viewer from updating or deleting capture notes", async () => {
    await seedCapture("cap-1", "2026-10-01T00:00:00Z");
    const adminC = await adminCookie();
    await worker.fetch(
      new Request("https://baidee.test/auth/users", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: adminC },
        body: JSON.stringify({ email: "viewer@example.com", password: "viewer password", role: "viewer" }),
      }),
      env,
    );
    const viewerLogin = await worker.fetch(
      new Request("https://baidee.test/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "viewer@example.com", password: "viewer password" }),
      }),
      env,
    );
    const viewerCookie = sessionCookieFrom(viewerLogin);

    const patchResponse = await worker.fetch(
      new Request("https://baidee.test/v1/captures/cap-1", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: viewerCookie },
        body: JSON.stringify({ notes: "x" }),
      }),
      env,
    );
    expect(patchResponse.status).toBe(403);

    const deleteResponse = await worker.fetch(
      new Request("https://baidee.test/v1/captures/cap-1", { method: "DELETE", headers: { cookie: viewerCookie } }),
      env,
    );
    expect(deleteResponse.status).toBe(403);
  });

  it("returns 404 updating or deleting a capture that does not exist", async () => {
    const cookie = await adminCookie();
    const patchResponse = await worker.fetch(
      new Request("https://baidee.test/v1/captures/does-not-exist", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ notes: "x" }),
      }),
      env,
    );
    expect(patchResponse.status).toBe(404);

    const deleteResponse = await worker.fetch(
      new Request("https://baidee.test/v1/captures/does-not-exist", { method: "DELETE", headers: { cookie } }),
      env,
    );
    expect(deleteResponse.status).toBe(404);
  });

  it("deletes a capture's D1 row and its R2 image together", async () => {
    await seedCapture("cap-1", "2026-10-01T00:00:00Z");
    const imageKey = db.captures[0].image_key as string;
    expect(images.has(imageKey)).toBe(true);
    const cookie = await adminCookie();

    const response = await worker.fetch(
      new Request("https://baidee.test/v1/captures/cap-1", { method: "DELETE", headers: { cookie } }),
      env,
    );
    expect(response.status).toBe(200);
    expect(images.has(imageKey)).toBe(false);

    const list = await worker.fetch(new Request("https://baidee.test/v1/captures", { headers: { cookie } }), env);
    const data = await list.json() as { total: number };
    expect(data.total).toBe(0);
  });

  it("exports matching captures as a downloadable zip with images, csv, and sqlite metadata", async () => {
    await seedCapture("cap-1", "2026-10-01T00:00:00Z");
    await seedCapture("cap-2", "2026-10-01T01:00:00Z");
    const cookie = await adminCookie();

    const response = await worker.fetch(new Request("https://baidee.test/v1/export", { headers: { cookie } }), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toContain("attachment");

    const bytes = new Uint8Array(await response.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50); // zip local file header signature
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).toContain("images/cap-1.jpg");
    expect(text).toContain("images/cap-2.jpg");
    expect(text).toContain("metadata.csv");
    expect(text).toContain("metadata.sqlite");
  });

  it("returns 404 from export when no captures match the filters", async () => {
    const cookie = await adminCookie();
    const response = await worker.fetch(
      new Request("https://baidee.test/v1/export?node=no-such-node", { headers: { cookie } }),
      env,
    );
    expect(response.status).toBe(404);
  });

  it("rejects a viewer from exporting", async () => {
    await seedCapture("cap-1", "2026-10-01T00:00:00Z");
    const adminC = await adminCookie();
    await worker.fetch(
      new Request("https://baidee.test/auth/users", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: adminC },
        body: JSON.stringify({ email: "viewer2@example.com", password: "viewer password", role: "viewer" }),
      }),
      env,
    );
    const viewerLogin = await worker.fetch(
      new Request("https://baidee.test/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "viewer2@example.com", password: "viewer password" }),
      }),
      env,
    );
    const viewerCookie = sessionCookieFrom(viewerLogin);
    const response = await worker.fetch(new Request("https://baidee.test/v1/export", { headers: { cookie: viewerCookie } }), env);
    expect(response.status).toBe(403);
  });
});

describe("User accounts and sessions", () => {
  it("rejects bootstrap without the service token", async () => {
    const response = await worker.fetch(
      new Request("https://baidee.test/auth/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "correct horse battery" }),
      }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("bootstraps the default admin once, then refuses a second bootstrap", async () => {
    const first = await worker.fetch(
      new Request("https://baidee.test/auth/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer read-token" },
        body: JSON.stringify({ password: "correct horse battery" }),
      }),
      env,
    );
    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({ email: "baidee@pwdvisionworks.com", role: "admin" });

    const second = await worker.fetch(
      new Request("https://baidee.test/auth/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer read-token" },
        body: JSON.stringify({ password: "another password" }),
      }),
      env,
    );
    expect(second.status).toBe(409);
  });

  it("logs in with email/password and sets a session cookie usable on protected routes", async () => {
    await worker.fetch(
      new Request("https://baidee.test/auth/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer read-token" },
        body: JSON.stringify({ password: "correct horse battery" }),
      }),
      env,
    );

    const loginResponse = await worker.fetch(
      new Request("https://baidee.test/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "BaiDee@PwdVisionWorks.com", password: "correct horse battery" }),
      }),
      env,
    );
    expect(loginResponse.status).toBe(200);
    await expect(loginResponse.json()).resolves.toMatchObject({ email: "baidee@pwdvisionworks.com", role: "admin" });
    const cookie = sessionCookieFrom(loginResponse);

    const capturesResponse = await worker.fetch(
      new Request("https://baidee.test/v1/captures", { headers: { cookie } }),
      env,
    );
    expect(capturesResponse.status).toBe(200);

    const meResponse = await worker.fetch(new Request("https://baidee.test/auth/me", { headers: { cookie } }), env);
    await expect(meResponse.json()).resolves.toEqual({ email: "baidee@pwdvisionworks.com", role: "admin" });
  });

  it("rejects login with the wrong password", async () => {
    await worker.fetch(
      new Request("https://baidee.test/auth/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer read-token" },
        body: JSON.stringify({ password: "correct horse battery" }),
      }),
      env,
    );
    const response = await worker.fetch(
      new Request("https://baidee.test/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "baidee@pwdvisionworks.com", password: "wrong password" }),
      }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("logout clears the session so protected routes require login again", async () => {
    await worker.fetch(
      new Request("https://baidee.test/auth/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer read-token" },
        body: JSON.stringify({ password: "correct horse battery" }),
      }),
      env,
    );
    const loginResponse = await worker.fetch(
      new Request("https://baidee.test/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "baidee@pwdvisionworks.com", password: "correct horse battery" }),
      }),
      env,
    );
    const cookie = sessionCookieFrom(loginResponse);

    const logoutResponse = await worker.fetch(
      new Request("https://baidee.test/auth/logout", { method: "POST", headers: { cookie } }),
      env,
    );
    const clearedCookie = sessionCookieFrom(logoutResponse);
    expect(clearedCookie).toBe("baidee_session=");

    const meAfterLogout = await worker.fetch(new Request("https://baidee.test/auth/me", { headers: { cookie: clearedCookie } }), env);
    expect(meAfterLogout.status).toBe(401);
  });

  it("lets an admin create a viewer account that cannot send device commands", async () => {
    await worker.fetch(
      new Request("https://baidee.test/auth/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer read-token" },
        body: JSON.stringify({ password: "correct horse battery" }),
      }),
      env,
    );
    const adminLogin = await worker.fetch(
      new Request("https://baidee.test/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "baidee@pwdvisionworks.com", password: "correct horse battery" }),
      }),
      env,
    );
    const adminCookie = sessionCookieFrom(adminLogin);

    const createResponse = await worker.fetch(
      new Request("https://baidee.test/auth/users", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: adminCookie },
        body: JSON.stringify({ email: "viewer@example.com", password: "viewer password", role: "viewer" }),
      }),
      env,
    );
    expect(createResponse.status).toBe(201);

    const viewerLogin = await worker.fetch(
      new Request("https://baidee.test/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "viewer@example.com", password: "viewer password" }),
      }),
      env,
    );
    const viewerCookie = sessionCookieFrom(viewerLogin);

    const readResponse = await worker.fetch(
      new Request("https://baidee.test/v1/captures", { headers: { cookie: viewerCookie } }),
      env,
    );
    expect(readResponse.status).toBe(200);

    const commandResponse = await worker.fetch(
      new Request("https://baidee.test/v1/cmd", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: viewerCookie },
        body: JSON.stringify({ node_id: "bd-s01-b01-c01", command: "capture_now" }),
      }),
      env,
    );
    expect(commandResponse.status).toBe(403);
  });

  it("rejects a non-admin trying to create users", async () => {
    await worker.fetch(
      new Request("https://baidee.test/auth/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer read-token" },
        body: JSON.stringify({ password: "correct horse battery" }),
      }),
      env,
    );
    await worker.fetch(
      new Request("https://baidee.test/auth/users", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer read-token" },
        body: JSON.stringify({ email: "viewer@example.com", password: "viewer password", role: "viewer" }),
      }),
      env,
    );
    const viewerLogin = await worker.fetch(
      new Request("https://baidee.test/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "viewer@example.com", password: "viewer password" }),
      }),
      env,
    );
    const viewerCookie = sessionCookieFrom(viewerLogin);

    const response = await worker.fetch(
      new Request("https://baidee.test/auth/users", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: viewerCookie },
        body: JSON.stringify({ email: "other@example.com", password: "another password" }),
      }),
      env,
    );
    expect(response.status).toBe(403);
  });

  it("will not let an admin delete the default admin account or their own account", async () => {
    await worker.fetch(
      new Request("https://baidee.test/auth/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer read-token" },
        body: JSON.stringify({ password: "correct horse battery" }),
      }),
      env,
    );
    const adminLogin = await worker.fetch(
      new Request("https://baidee.test/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "baidee@pwdvisionworks.com", password: "correct horse battery" }),
      }),
      env,
    );
    const adminCookie = sessionCookieFrom(adminLogin);

    const deleteDefaultAdmin = await worker.fetch(
      new Request("https://baidee.test/auth/users/baidee@pwdvisionworks.com", { method: "DELETE", headers: { cookie: adminCookie } }),
      env,
    );
    expect(deleteDefaultAdmin.status).toBe(400);
  });
});
