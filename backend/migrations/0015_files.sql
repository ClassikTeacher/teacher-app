-- M5-01: files (7.5 «Файлы», 5.10.3 HW-01/05/07, Р-27). Source of truth is S3; this table is the index.
CREATE TABLE file (
  id                uuid PRIMARY KEY,
  bucket            text NOT NULL,
  key               text NOT NULL,                       -- random object key, never derived from the name
  original_name     text NOT NULL,
  ext               text NOT NULL REFERENCES file_type(ext),
  mime              text NOT NULL,
  size              bigint NOT NULL CHECK (size > 0),
  sha256            text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  scan_status       text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'clean', 'infected', 'skipped')),
  scan_error        text,
  uploaded_by       uuid NOT NULL REFERENCES account(id),
  owner_teacher_id  uuid NOT NULL REFERENCES account(id),  -- whose quota the size is charged to (Р-27)
  -- `draft` until attached to a material / submission / review; orphans are collected after 24 h (HW-06)
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'attached', 'deleted')),
  attached_at       timestamptz,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket, key)
);
CREATE INDEX file_owner_idx ON file (owner_teacher_id) WHERE status <> 'deleted';
CREATE INDEX file_draft_idx ON file (created_at) WHERE status = 'draft';
CREATE INDEX file_scan_pending_idx ON file (created_at) WHERE scan_status = 'pending';
CREATE TRIGGER file_set_updated_at BEFORE UPDATE ON file
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Telegram `file_id` is valid only for the bot that saw the file: one cache row per (file, bot) (7.5).
CREATE TABLE telegram_file_cache (
  id                       uuid PRIMARY KEY,
  file_id                  uuid NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  bot                      text NOT NULL CHECK (bot IN ('auth', 'staff', 'student', 'parent')),
  telegram_file_id         text NOT NULL,
  telegram_file_unique_id  text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, bot)
);

-- The teacher's storage usage: one row, updated atomically so two concurrent uploads cannot both pass the quota.
CREATE TABLE storage_usage (
  teacher_id  uuid PRIMARY KEY REFERENCES account(id),
  used_bytes  bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
