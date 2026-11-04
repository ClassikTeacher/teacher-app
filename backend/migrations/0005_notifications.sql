-- M1-07: notification skeleton (7.5 "Уведомления", 5.13.4). PostgreSQL is the source of truth;
-- BullMQ on Redis is only transport, so a Redis loss never loses a notification.

CREATE TABLE notification (
  id            uuid PRIMARY KEY,
  type_code     text NOT NULL,
  recipient_id  uuid NOT NULL REFERENCES account(id),
  bot           text NOT NULL CHECK (bot IN ('auth', 'staff', 'student', 'parent')),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key    text NOT NULL UNIQUE,                         -- NTF-08
  due_at        timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('scheduled', 'queued', 'sending', 'sent', 'failed', 'skipped', 'cancelled')),
  attempts      integer NOT NULL DEFAULT 0,
  sent_at       timestamptz,
  error         text,
  cc_of_id      uuid REFERENCES notification(id),             -- copy for a parent (NTF-03)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_due_idx ON notification (due_at) WHERE status = 'scheduled';
CREATE INDEX notification_recipient_idx ON notification (recipient_id, created_at DESC);
CREATE TRIGGER notification_set_updated_at BEFORE UPDATE ON notification
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
