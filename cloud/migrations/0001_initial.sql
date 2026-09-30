CREATE TABLE IF NOT EXISTS captures (
  capture_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  bed_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('edge_triage', 'pi_verify', 'manual')),
  payload_json TEXT NOT NULL,
  image_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_captures_node_time ON captures(node_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_bed_time ON captures(site_id, bed_id, captured_at DESC);
