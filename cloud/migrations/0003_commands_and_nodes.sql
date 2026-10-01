CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  command TEXT NOT NULL CHECK (command IN ('capture_now', 'set_wifi', 'set_config')),
  args_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'done', 'failed')),
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  delivered_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_commands_node_status ON commands(node_id, status, created_at);

CREATE TABLE IF NOT EXISTS node_status (
  node_id TEXT PRIMARY KEY,
  last_seen_at TEXT NOT NULL,
  fw_version TEXT,
  wifi_ip TEXT,
  rssi INTEGER,
  uptime_ms INTEGER,
  camera TEXT,
  psram TEXT,
  storage TEXT,
  capture_interval_ms INTEGER,
  extra_json TEXT
);
