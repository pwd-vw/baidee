CREATE TABLE IF NOT EXISTS node_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  fw_version TEXT,
  wifi_ip TEXT,
  rssi INTEGER,
  uptime_ms INTEGER,
  camera TEXT,
  psram TEXT,
  storage TEXT,
  capture_interval_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_node_events_node_ts ON node_events(node_id, ts DESC);
