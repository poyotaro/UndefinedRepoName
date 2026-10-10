-- W1 試作：受け取ったリクエストをそのまま記録する
CREATE TABLE IF NOT EXISTS probe_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL,   -- サーバーが受け取った時刻（ミリ秒）
  n INTEGER NOT NULL,       -- URL プールの番号 0〜4095
  ip TEXT,
  ua TEXT,
  accept TEXT,
  country TEXT
);
CREATE INDEX IF NOT EXISTS probe_log_ts ON probe_log (ts_ms);
