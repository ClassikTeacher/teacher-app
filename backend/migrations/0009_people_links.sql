-- M2: people — teacher-student links with periods, family links, student profile.
-- PRODUCT-SPEC 8.2 "people", 3.8 lifecycles.

-- student-owned facts shared by all teachers (5.4.1: класс, школа)
CREATE TABLE student_profile (
  account_id    uuid PRIMARY KEY REFERENCES account(id),
  school        text,
  grade         text,
  onboarded_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER student_profile_set_updated_at BEFORE UPDATE ON student_profile
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- teacher-student link = the student card at this teacher (5.4.1). A card is created in `pending`
-- before the student exists (UC-10 step 2), so student_id is filled when the link is accepted.
-- Re-adding the same student reuses the row (journals hang off it, JRN-02) and opens a new period.
CREATE TABLE teacher_student (
  id                    uuid PRIMARY KEY,
  teacher_id            uuid NOT NULL REFERENCES account(id),
  student_id            uuid REFERENCES account(id),
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'active', 'ended', 'declined', 'cancelled')),
  invitation_id         uuid REFERENCES invitation(id),
  invite_name           text,                                   -- name typed by the teacher for a pending card
  invite_grade          text,
  alias                 text,                                   -- visible to this teacher only
  subject_ids           uuid[] NOT NULL DEFAULT '{}',
  max_lessons_per_week  integer CHECK (max_lessons_per_week IS NULL OR max_lessons_per_week BETWEEN 1 AND 50),
  goals                 text,
  notes                 text,                                   -- teacher private notes
  calendar_open         boolean,                                -- NULL = teacher default (calendar_mode)
  started_at            timestamptz,
  ended_at              timestamptz,
  ended_by              uuid REFERENCES account(id),
  end_reason            text CHECK (end_reason IN ('removed_by_teacher', 'left_by_student', 'ended_by_parent', 'system')),
  end_message           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('active', 'ended') OR student_id IS NOT NULL),
  CHECK (status <> 'pending' OR student_id IS NULL),
  CHECK (status <> 'ended' OR (ended_at IS NOT NULL AND end_reason IS NOT NULL))
);
-- PPL-02 / 3.8: one link row per pair; pending cards have no student yet
CREATE UNIQUE INDEX teacher_student_pair_uniq ON teacher_student (teacher_id, student_id) WHERE student_id IS NOT NULL;
CREATE INDEX teacher_student_teacher_idx ON teacher_student (teacher_id, status);
-- one card per invitation link; a reopened link takes the invitation over from the retired pending card
CREATE UNIQUE INDEX teacher_student_invitation_uniq ON teacher_student (invitation_id) WHERE invitation_id IS NOT NULL;
CREATE INDEX teacher_student_student_idx ON teacher_student (student_id, status) WHERE student_id IS NOT NULL;
CREATE TRIGGER teacher_student_set_updated_at BEFORE UPDATE ON teacher_student
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- history of activity periods (5.8.4: re-adding opens a new period)
CREATE TABLE teacher_student_period (
  id          uuid PRIMARY KEY,
  link_id     uuid NOT NULL REFERENCES teacher_student(id),
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz,
  end_reason  text CHECK (end_reason IN ('removed_by_teacher', 'left_by_student', 'ended_by_parent', 'system')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX teacher_student_period_link_idx ON teacher_student_period (link_id, started_at);
CREATE UNIQUE INDEX teacher_student_period_open_uniq ON teacher_student_period (link_id) WHERE ended_at IS NULL;

-- family link, shared by all teachers of the student (5.4.3, Р-4); created only when the parent accepts
CREATE TABLE family_link (
  id             uuid PRIMARY KEY,
  parent_id      uuid NOT NULL REFERENCES account(id),
  student_id     uuid NOT NULL REFERENCES account(id),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  invited_by     uuid REFERENCES account(id),                -- the teacher who issued the link
  invitation_id  uuid REFERENCES invitation(id),
  confirmed_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  revoked_by     uuid REFERENCES account(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id <> student_id),
  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);
CREATE UNIQUE INDEX family_link_active_uniq ON family_link (parent_id, student_id) WHERE status = 'active';
CREATE INDEX family_link_student_idx ON family_link (student_id, status);
CREATE INDEX family_link_parent_idx ON family_link (parent_id, status);
CREATE TRIGGER family_link_set_updated_at BEFORE UPDATE ON family_link
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
