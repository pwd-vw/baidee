// Minimal in-memory stand-in for the R2 bucket binding used by cloud/src/index.ts.

export class FakeR2 {
  private objects = new Map<string, { body: Uint8Array; contentType: string }>();

  async put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<void> {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    this.objects.set(key, { body: bytes, contentType: options?.httpMetadata?.contentType ?? "application/octet-stream" });
  }

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      httpMetadata: { contentType: object.contentType },
      body: object.body,
      arrayBuffer: async () => object.body.buffer.slice(object.body.byteOffset, object.body.byteOffset + object.body.byteLength),
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }
}
