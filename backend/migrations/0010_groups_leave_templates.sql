-- M2: groups (5.4.4), leave requests (5.8.2, LINK-01…05) and message templates (5.7.2).

CREATE TABLE study_group (
  id                    uuid PRIMARY KEY,
  teacher_id            uuid NOT NULL REFERENCES account(id),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  subject_id            uuid REFERENCES subject(id),
  emoji                 text,
  default_duration_min  integer CHECK (default_duration_min IS NULL OR default_duration_min BETWEEN 15 AND 480),
  telegram_chat_id      bigint,                                   -- stage 2 (groups.telegram)
  archived_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX study_group_teacher_idx ON study_group (teacher_id) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX study_group_name_uniq ON study_group (teacher_id, lower(name)) WHERE archived_at IS NULL;
CREATE TRIGGER study_group_set_updated_at BEFORE UPDATE ON study_group
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE group_member (
  id          uuid PRIMARY KEY,
  group_id    uuid NOT NULL REFERENCES study_group(id),
  student_id  uuid NOT NULL REFERENCES account(id),
  joined_at   timestamptz NOT NULL DEFAULT now(),
  left_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX group_member_active_uniq ON group_member (group_id, student_id) WHERE left_at IS NULL;
CREATE INDEX group_member_student_idx ON group_member (student_id) WHERE left_at IS NULL;

-- student asks to leave a teacher; a parent decides (LINK-02…05); 7 days to answer, reminder after 48 h
CREATE TABLE leave_request (
  id                  uuid PRIMARY KEY,
  teacher_student_id  uuid NOT NULL REFERENCES teacher_student(id),
  initiated_by        uuid NOT NULL REFERENCES account(id),
  reason              text NOT NULL,
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'declined', 'expired', 'cancelled')),
  decided_by          uuid REFERENCES account(id),
  decision_comment    text,
  decided_at          timestamptz,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX leave_request_single_pending ON leave_request (teacher_student_id) WHERE status = 'pending';
CREATE INDEX leave_request_pending_expiry_idx ON leave_request (expires_at) WHERE status = 'pending';
CREATE TRIGGER leave_request_set_updated_at BEFORE UPDATE ON leave_request
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- reusable reason texts of a teacher (5.7.2); kind separates cancellation reasons from link-ending messages
CREATE TABLE message_template (
  id           uuid PRIMARY KEY,
  owner_id     uuid NOT NULL REFERENCES account(id),
  kind         text NOT NULL DEFAULT 'cancel_reason' CHECK (kind IN ('cancel_reason', 'end_link')),
  text         text NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  position     integer NOT NULL DEFAULT 0,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_template_owner_idx ON message_template (owner_id, kind, position) WHERE archived_at IS NULL;
CREATE TRIGGER message_template_set_updated_at BEFORE UPDATE ON message_template
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
