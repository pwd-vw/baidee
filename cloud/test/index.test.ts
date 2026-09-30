import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";

const secret = "test-secret";
const env = {
  BAIDEE_HMAC_SECRET: secret,
  BAIDEE_API_TOKEN: "read-token",
} as unknown as Env;

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
});
