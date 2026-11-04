-- M4-05: notification settings (5.13.2 copies to parents, 5.13.3 reminders, 5.13.4 quiet hours, digest).

-- per-account delivery preferences; a missing row means the defaults
CREATE TABLE notification_profile (
  account_id          uuid PRIMARY KEY REFERENCES account(id),
  reminder_offsets_min integer[] NOT NULL DEFAULT '{1440,60}',   -- 5.13.3 💡 24 h and 1 h; empty = off
  quiet_enabled       boolean NOT NULL DEFAULT true,
  quiet_from          time NOT NULL DEFAULT '22:00',              -- NTF-06 in the recipient's zone
  quiet_to            time NOT NULL DEFAULT '08:00',
  digest_enabled      boolean NOT NULL DEFAULT true,              -- teachers: the morning digest (5.5.7)
  digest_time         time NOT NULL DEFAULT '08:00',
  deliver_via_parent  boolean NOT NULL DEFAULT false,             -- NTF-04 💡 (teachers)
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(reminder_offsets_min) <= 3)
);
CREATE TRIGGER notification_profile_set_updated_at BEFORE UPDATE ON notification_profile
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- per-type switches: a teacher's copy defaults (cc_default), their per-student overrides (cc_student),
-- and a recipient's own mutes (mute) — parents for non-critical copies (NTF-02), anyone for types they may disable
CREATE TABLE notification_setting (
  id          uuid PRIMARY KEY,
  owner_id    uuid NOT NULL REFERENCES account(id),
  kind        text NOT NULL CHECK (kind IN ('cc_default', 'cc_student', 'mute')),
  student_id  uuid REFERENCES account(id),
  type_code   text NOT NULL,
  enabled     boolean NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'cc_student') = (student_id IS NOT NULL))
);
CREATE UNIQUE INDEX notification_setting_uniq ON notification_setting (owner_id, kind, type_code, student_id) NULLS NOT DISTINCT;
CREATE TRIGGER notification_setting_set_updated_at BEFORE UPDATE ON notification_setting
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- why a notification was (re)routed: a copy to a parent (NTF-03) or the parent standing in for an unreachable student (NTF-04)
ALTER TABLE notification ADD COLUMN route text CHECK (route IS NULL OR route IN ('cc', 'via_parent'));
ALTER TABLE notification ADD COLUMN for_account_id uuid REFERENCES account(id);
