// Minimal in-memory stand-in for the D1 bindings used by cloud/src/index.ts.
// It pattern-matches the small, fixed set of SQL statements the Worker issues
// rather than implementing a real SQL engine.

type Row = Record<string, unknown>;

export class FakeD1 {
  captures: Row[] = [];
  usageDaily: Row[] = [];
  commands: Row[] = [];
  nodeStatus: Row[] = [];
  nodeEvents: Row[] = [];
  users: Row[] = [];
  private nextCommandId = 1;

  prepare(sql: string) {
    const db = this;
    return {
      _sql: sql,
      _args: [] as unknown[],
      bind(...args: unknown[]) {
        this._args = args;
        return this;
      },
      async first<T = Row>(): Promise<T | null> {
        const rows = await db.run(this._sql, this._args);
        return (rows[0] as T) ?? null;
      },
      async all<T = Row>(): Promise<{ results: T[] }> {
        const rows = await db.run(this._sql, this._args);
        return { results: rows as T[] };
      },
      async run(): Promise<{ meta: { last_row_id: number } }> {
        await db.run(this._sql, this._args);
        return { meta: { last_row_id: db.nextCommandId - 1 } };
      },
    };
  }

  private async run(sql: string, args: unknown[]): Promise<Row[]> {
    const s = sql.replace(/\s+/g, " ").trim();

    if (s.startsWith("SELECT capture_id FROM captures WHERE capture_id")) {
      const row = this.captures.find((c) => c.capture_id === args[0]);
      return row ? [row] : [];
    }
    if (s.startsWith("SELECT capture_count, image_bytes FROM usage_daily")) {
      const row = this.usageDaily.find((u) => u.usage_date === args[0]);
      return row ? [row] : [];
    }
    if (s.startsWith("INSERT INTO captures")) {
      const [capture_id, node_id, site_id, bed_id, captured_at, stage, payload_json, image_key] = args;
      this.captures.push({ capture_id, node_id, site_id, bed_id, captured_at, stage, notes: null, payload_json, image_key });
      return [];
    }
    if (s.startsWith("INSERT INTO usage_daily")) {
      const [usage_date, count, bytes] = args as [string, number, number];
      const existing = this.usageDaily.find((u) => u.usage_date === usage_date);
      if (existing) {
        existing.capture_count = Number(existing.capture_count) + count;
        existing.image_bytes = Number(existing.image_bytes) + bytes;
      } else {
        this.usageDaily.push({ usage_date, capture_count: count, image_bytes: bytes });
      }
      return [];
    }
    if (s.startsWith("SELECT capture_id, node_id, site_id, bed_id, captured_at, stage, notes, payload_json, image_key")) {
      let rows = [...this.captures];
      let argIndex = 0;
      const whereMatch = s.match(/WHERE (.*?) ORDER BY/);
      if (whereMatch) {
        const conditions = whereMatch[1].split(" AND ");
        for (const condition of conditions) {
          const value = args[argIndex++];
          if (condition.startsWith("node_id")) rows = rows.filter((r) => r.node_id === value);
          else if (condition.startsWith("captured_at >=")) rows = rows.filter((r) => (r.captured_at as string) >= (value as string));
          else if (condition.startsWith("captured_at <=")) rows = rows.filter((r) => (r.captured_at as string) <= (value as string));
        }
      }
      const descending = s.includes("ORDER BY captured_at DESC");
      rows.sort((a, b) => (descending
        ? (b.captured_at as string).localeCompare(a.captured_at as string)
        : (a.captured_at as string).localeCompare(b.captured_at as string)));
      if (s.includes("LIMIT ? OFFSET ?")) {
        const limit = Number(args[argIndex++]);
        const offset = Number(args[argIndex++]);
        rows = rows.slice(offset, offset + limit);
      }
      return rows.map((r) => ({ ...r, notes: r.notes ?? null }));
    }
    if (s.startsWith("SELECT capture_id, node_id, captured_at, stage, payload_json FROM captures")) {
      let rows = [...this.captures];
      if (s.includes("WHERE node_id = ?")) rows = rows.filter((r) => r.node_id === args[0]);
      rows.sort((a, b) => (b.captured_at as string).localeCompare(a.captured_at as string));
      const limit = Number(args[args.length - 1]);
      return rows.slice(0, limit);
    }
    if (s.startsWith("SELECT id, node_id, command, status, created_at, delivered_at, completed_at, result_json FROM commands")) {
      let rows = [...this.commands];
      if (s.includes("WHERE node_id = ?")) rows = rows.filter((r) => r.node_id === args[0]);
      rows.sort((a, b) => (b.created_at as string).localeCompare(a.created_at as string));
      const limit = Number(args[args.length - 1]);
      return rows.slice(0, limit).map((r) => ({ ...r, result_json: r.result_json ?? null, delivered_at: r.delivered_at ?? null, completed_at: r.completed_at ?? null }));
    }
    if (s.startsWith("SELECT image_key FROM captures WHERE capture_id")) {
      const row = this.captures.find((c) => c.capture_id === args[0]);
      return row ? [row] : [];
    }
    if (s.startsWith("SELECT COUNT(*) AS total_captures")) {
      const nodes = new Set(this.captures.map((c) => c.node_id));
      return [{ total_captures: this.captures.length, total_nodes: nodes.size }];
    }
    if (s.startsWith("SELECT COUNT(*) AS total FROM captures")) {
      let rows = [...this.captures];
      const whereMatch = s.match(/WHERE (.*)$/);
      if (whereMatch) {
        const conditions = whereMatch[1].split(" AND ");
        let argIndex = 0;
        for (const condition of conditions) {
          const value = args[argIndex++];
          if (condition.startsWith("node_id")) rows = rows.filter((r) => r.node_id === value);
          else if (condition.startsWith("captured_at >=")) rows = rows.filter((r) => (r.captured_at as string) >= (value as string));
          else if (condition.startsWith("captured_at <=")) rows = rows.filter((r) => (r.captured_at as string) <= (value as string));
        }
      }
      return [{ total: rows.length }];
    }
    if (s.startsWith("UPDATE captures SET notes = ? WHERE capture_id")) {
      const [notes, captureId] = args;
      const row = this.captures.find((c) => c.capture_id === captureId);
      if (row) row.notes = notes;
      return [];
    }
    if (s.startsWith("DELETE FROM captures WHERE capture_id")) {
      this.captures = this.captures.filter((c) => c.capture_id !== args[0]);
      return [];
    }
    if (s.startsWith("SELECT capture_count, image_bytes FROM usage_daily WHERE usage_date")) {
      const row = this.usageDaily.find((u) => u.usage_date === args[0]);
      return row ? [row] : [];
    }
    if (s.startsWith("SELECT usage_date, capture_count, image_bytes FROM usage_daily")) {
      return [...this.usageDaily].sort((a, b) => (b.usage_date as string).localeCompare(a.usage_date as string)).slice(0, 14);
    }
    if (s.startsWith("SELECT node_id, COUNT(*) AS capture_count")) {
      const byNode = new Map<string, number>();
      for (const c of this.captures) byNode.set(c.node_id as string, (byNode.get(c.node_id as string) ?? 0) + 1);
      return [...byNode.entries()].map(([node_id, capture_count]) => ({ node_id, capture_count }));
    }
    if (s.startsWith("SELECT stage, COUNT(*) AS count FROM captures")) {
      const byStage = new Map<string, number>();
      for (const c of this.captures) byStage.set(c.stage as string, (byStage.get(c.stage as string) ?? 0) + 1);
      return [...byStage.entries()].map(([stage, count]) => ({ stage, count }));
    }
    if (s.startsWith("SELECT id, command, args_json FROM commands WHERE node_id")) {
      return this.commands
        .filter((c) => c.node_id === args[0] && c.status === "pending")
        .sort((a, b) => (a.created_at as string).localeCompare(b.created_at as string))
        .slice(0, 5);
    }
    if (s.startsWith("UPDATE commands SET status = 'delivered'")) {
      const ids = new Set(args as number[]);
      for (const c of this.commands) if (ids.has(c.id as number)) c.status = "delivered";
      return [];
    }
    if (s.startsWith("INSERT INTO commands")) {
      const [node_id, command, args_json] = args;
      const id = this.nextCommandId++;
      this.commands.push({ id, node_id, command, args_json, status: "pending", created_at: new Date().toISOString() });
      return [];
    }
    if (s.startsWith("SELECT node_id FROM commands WHERE id")) {
      const row = this.commands.find((c) => c.id === args[0]);
      return row ? [row] : [];
    }
    if (s.startsWith("UPDATE commands SET status = ?, result_json")) {
      const [status, result_json, id] = args;
      const row = this.commands.find((c) => c.id === id);
      if (row) {
        row.status = status;
        row.result_json = result_json;
      }
      return [];
    }
    if (s.startsWith("INSERT INTO node_status")) {
      const [node_id] = args;
      const existing = this.nodeStatus.find((n) => n.node_id === node_id);
      const keys = ["node_id", "last_seen_at", "fw_version", "wifi_ip", "rssi", "uptime_ms", "camera", "psram", "storage", "capture_interval_ms", "extra_json"];
      const row = Object.fromEntries(keys.map((key, i) => [key, args[i]]));
      if (existing) Object.assign(existing, row); else this.nodeStatus.push(row);
      return [];
    }
    if (s.startsWith("SELECT * FROM node_status")) {
      return [...this.nodeStatus].sort((a, b) => (b.last_seen_at as string).localeCompare(a.last_seen_at as string));
    }
    if (s.startsWith("INSERT INTO node_events")) {
      const keys = ["node_id", "ts", "fw_version", "wifi_ip", "rssi", "uptime_ms", "camera", "psram", "storage", "capture_interval_ms"];
      this.nodeEvents.push(Object.fromEntries(keys.map((key, i) => [key, args[i]])));
      return [];
    }
    if (s.startsWith("SELECT node_id, ts, fw_version, wifi_ip, rssi, uptime_ms, camera, psram, storage, capture_interval_ms")) {
      let rows = [...this.nodeEvents];
      let argIndex = 0;
      if (s.includes("WHERE node_id = ?")) {
        const value = args[argIndex++];
        rows = rows.filter((r) => r.node_id === value);
      }
      rows.sort((a, b) => (b.ts as string).localeCompare(a.ts as string));
      const limit = Number(args[argIndex]);
      return rows.slice(0, limit);
    }
    if (s.startsWith("SELECT COUNT(*) AS count FROM users")) {
      return [{ count: this.users.length }];
    }
    if (s.includes("INSERT INTO users") && s.includes("ON CONFLICT(email)")) {
      const [email, password_hash, password_salt, role, created_by] = args;
      const existing = this.users.find((u) => u.email === email);
      if (existing) {
        existing.password_hash = password_hash;
        existing.password_salt = password_salt;
        existing.role = role;
      } else {
        this.users.push({ email, password_hash, password_salt, role, created_by, created_at: new Date().toISOString() });
      }
      return [];
    }
    if (s.includes("INSERT INTO users")) {
      // Bootstrap insert: VALUES (?, ?, ?, 'admin', 'bootstrap') — role/created_by are literals, not bound args.
      const [email, password_hash, password_salt] = args;
      this.users.push({ email, password_hash, password_salt, role: "admin", created_by: "bootstrap", created_at: new Date().toISOString() });
      return [];
    }
    if (s.startsWith("SELECT password_hash, password_salt, role FROM users WHERE email")) {
      const row = this.users.find((u) => u.email === args[0]);
      return row ? [row] : [];
    }
    if (s.startsWith("SELECT email, role, created_at, created_by FROM users")) {
      return [...this.users].sort((a, b) => (a.created_at as string).localeCompare(b.created_at as string));
    }
    if (s.startsWith("DELETE FROM users WHERE email")) {
      this.users = this.users.filter((u) => u.email !== args[0]);
      return [];
    }

    throw new Error(`FakeD1: unhandled query: ${s}`);
  }
}
