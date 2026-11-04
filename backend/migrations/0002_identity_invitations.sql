-- M1-03: invitations (INV-01…05), audit log (AUD-01) and transactional outbox (7.5).

ALTER TABLE account ADD COLUMN prior_status text
  CHECK (prior_status IN ('invited', 'onboarding', 'active'));

CREATE TABLE invitation (
  id                       uuid PRIMARY KEY,
  token_hash               text NOT NULL UNIQUE,              -- sha256 of the deep-link token (INV-05)
  kind                     text NOT NULL CHECK (kind IN ('bootstrap', 'teacher', 'admin', 'student', 'parent')),
  created_by               uuid REFERENCES account(id),       -- NULL for bootstrap
  target_telegram_user_id  bigint,                            -- INV-03: bound to a user, NULL = anyone
  payload                  jsonb NOT NULL DEFAULT '{}'::jsonb, -- subject, weekly limit, name, teacher_id, student_id…
  max_uses                 integer NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  used_count               integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expires_at               timestamptz NOT NULL,
  status                   text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'used', 'revoked', 'expired')),
  used_by                  uuid REFERENCES account(id),
  used_at                  timestamptz,
  revoked_by               uuid REFERENCES account(id),
  revoked_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitation_pending_expiry_idx ON invitation (expires_at) WHERE status = 'pending';
CREATE INDEX invitation_created_by_idx ON invitation (created_by, created_at DESC);
CREATE TRIGGER invitation_set_updated_at BEFORE UPDATE ON invitation
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- append-only audit (AUD-01); partitioning by month is a later platform task (P-02)
CREATE TABLE audit_log (
  id           uuid PRIMARY KEY,
  actor_id     uuid REFERENCES account(id),                    -- NULL = system
  actor_role   text,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    uuid,
  before       jsonb,
  after        jsonb,
  source       text NOT NULL CHECK (source IN ('bot', 'web', 'api', 'system')),
  ip           inet,
  correlation_id text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, at DESC);
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;

-- transactional outbox: written in the same transaction as the domain change, published by the worker
CREATE TABLE outbox_event (
  id              uuid PRIMARY KEY,
  aggregate_type  text NOT NULL,
  aggregate_id    uuid,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text
);
CREATE INDEX outbox_event_unpublished_idx ON outbox_event (created_at) WHERE published_at IS NULL;
