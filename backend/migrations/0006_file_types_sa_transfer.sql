-- M1-08: allowed file types (Р-31, UC-44, 5.10.3), editable by admins.
CREATE TABLE file_type (
  ext         text PRIMARY KEY,                               -- lower-case extension without a dot
  category    text NOT NULL CHECK (category IN ('image', 'document', 'spreadsheet', 'audio', 'video', 'archive', 'other')),
  mime        text NOT NULL,
  is_allowed  boolean NOT NULL DEFAULT true,
  position    integer NOT NULL DEFAULT 0,
  updated_by  uuid REFERENCES account(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER file_type_set_updated_at BEFORE UPDATE ON file_type
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO file_type (ext, category, mime, is_allowed, position) VALUES
  ('jpg',  'image',       'image/jpeg', true, 10),
  ('jpeg', 'image',       'image/jpeg', true, 11),
  ('png',  'image',       'image/png',  true, 12),
  ('webp', 'image',       'image/webp', true, 13),
  ('heic', 'image',       'image/heic', true, 14),
  ('pdf',  'document',    'application/pdf', true, 20),
  ('doc',  'document',    'application/msword', true, 21),
  ('docx', 'document',    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', true, 22),
  ('odt',  'document',    'application/vnd.oasis.opendocument.text', true, 23),
  ('rtf',  'document',    'application/rtf', true, 24),
  ('txt',  'document',    'text/plain', true, 25),
  ('xlsx', 'spreadsheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', true, 30),
  ('pptx', 'spreadsheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', true, 31),
  ('mp3',  'audio',       'audio/mpeg', true, 40),
  ('m4a',  'audio',       'audio/mp4', true, 41),
  ('ogg',  'audio',       'audio/ogg', false, 42),          -- voice notes: stage 2
  ('mp4',  'video',       'video/mp4', true, 50),
  ('zip',  'archive',     'application/zip', false, 60),    -- archives off by default (5.10.3)
  ('rar',  'archive',     'application/vnd.rar', false, 61),
  ('7z',   'archive',     'application/x-7z-compressed', false, 62)
ON CONFLICT DO NOTHING;

-- M1-09: super admin transfer via the system API with confirmation in AuthBot (5.3.4, UC-02).
CREATE TABLE super_admin_transfer (
  id               uuid PRIMARY KEY,
  from_account_id  uuid NOT NULL REFERENCES account(id),
  to_account_id    uuid NOT NULL REFERENCES account(id),
  previous_role    text NOT NULL CHECK (previous_role IN ('ADMIN', 'NONE')),   -- what the old SA becomes
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'declined', 'expired', 'cancelled')),
  expires_at       timestamptz NOT NULL,
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX super_admin_transfer_single_pending ON super_admin_transfer (status) WHERE status = 'pending';
