-- M6-01/M6-02: journals, scales, grade entries with history, test kinds (5.11, 8.2 «gradebook»).

-- Scales: the platform 10-point scale (owner NULL, Р-10) and one live custom scale per teacher (5.11.4).
CREATE TABLE grade_scale (
  id           uuid PRIMARY KEY,
  owner_id     uuid REFERENCES account(id),
  kind         text NOT NULL CHECK (kind IN ('numeric', 'custom')),
  title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 60),
  min_value    integer,
  max_value    integer,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grade_scale_numeric_bounds CHECK (
    (kind = 'numeric' AND min_value IS NOT NULL AND max_value IS NOT NULL AND min_value < max_value) OR
    (kind = 'custom' AND min_value IS NULL AND max_value IS NULL)
  )
);
CREATE UNIQUE INDEX grade_scale_custom_owner_uniq ON grade_scale (owner_id)
  WHERE kind = 'custom' AND archived_at IS NULL;
CREATE TRIGGER grade_scale_set_updated_at BEFORE UPDATE ON grade_scale
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO grade_scale (id, owner_id, kind, title, min_value, max_value) VALUES
  ('019a0000-0000-7000-8000-0000000000a1', NULL, 'numeric', '10-балльная', 1, 10);

-- Values of a custom scale: 2–10 live values, text and emoji, order, optional weight; JRN-06 — a used value
-- is archived, never deleted.
CREATE TABLE grade_scale_value (
  id           uuid PRIMARY KEY,
  scale_id     uuid NOT NULL REFERENCES grade_scale(id),
  label        text NOT NULL CHECK (length(label) BETWEEN 1 AND 30),
  emoji        text CHECK (emoji IS NULL OR length(emoji) BETWEEN 1 AND 16),
  position     integer NOT NULL DEFAULT 0,
  weight       numeric(6,2),
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX grade_scale_value_scale_idx ON grade_scale_value (scale_id, position);
CREATE TRIGGER grade_scale_value_set_updated_at BEFORE UPDATE ON grade_scale_value
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Kinds of tests (5.11.3): platform defaults (owner NULL) plus the teacher's own additions.
CREATE TABLE test_kind (
  id           uuid PRIMARY KEY,
  owner_id     uuid REFERENCES account(id),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  position     integer NOT NULL DEFAULT 0,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX test_kind_owner_name_uniq ON test_kind (owner_id, lower(name)) NULLS NOT DISTINCT;

INSERT INTO test_kind (id, owner_id, name, position) VALUES
  ('019a0000-0000-7000-8000-0000000000b1', NULL, 'ЦТ', 10),
  ('019a0000-0000-7000-8000-0000000000b2', NULL, 'ЦЭ', 20),
  ('019a0000-0000-7000-8000-0000000000b3', NULL, 'РТ-1', 30),
  ('019a0000-0000-7000-8000-0000000000b4', NULL, 'РТ-2', 40),
  ('019a0000-0000-7000-8000-0000000000b5', NULL, 'РТ-3', 50),
  ('019a0000-0000-7000-8000-0000000000b6', NULL, 'Пробный', 60),
  ('019a0000-0000-7000-8000-0000000000b7', NULL, 'Школьный тест', 70),
  ('019a0000-0000-7000-8000-0000000000b8', NULL, 'Другое', 80);

-- Three journals per subject of a link (JRN-01…02); owner teacher and student denormalised (8.0).
CREATE TABLE journal (
  id                  uuid PRIMARY KEY,
  teacher_student_id  uuid NOT NULL REFERENCES teacher_student(id),
  teacher_id          uuid NOT NULL REFERENCES account(id),
  student_id          uuid NOT NULL REFERENCES account(id),
  subject_id          uuid NOT NULL REFERENCES subject(id),
  type                text NOT NULL CHECK (type IN ('school', 'tests', 'custom')),
  visible_to_student  boolean NOT NULL DEFAULT true,     -- JRN-04 (Р-5)
  visible_to_parent   boolean NOT NULL DEFAULT true,
  hidden              boolean NOT NULL DEFAULT false,    -- the teacher does not use it (5.11.1)
  target_score        numeric(6,2),                      -- tests: the goal line 💡
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (teacher_student_id, subject_id, type)
);
CREATE INDEX journal_teacher_student_idx ON journal (teacher_id, student_id);
CREATE INDEX journal_student_idx ON journal (student_id);
CREATE TRIGGER journal_set_updated_at BEFORE UPDATE ON journal
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A record (JRN-03): date, value (numeric for school and tests, a scale value for custom), category or test
-- kind, weight, comment, links to a lesson and an assignment, source and confirmation status (5.11.2 💡).
CREATE TABLE grade_entry (
  id             uuid PRIMARY KEY,
  journal_id     uuid NOT NULL REFERENCES journal(id),
  teacher_id     uuid NOT NULL REFERENCES account(id),
  student_id     uuid NOT NULL REFERENCES account(id),
  date           date NOT NULL,
  category       text CHECK (category IS NULL OR category IN ('current', 'independent', 'control', 'exam', 'quarter', 'year')),
  test_kind_id   uuid REFERENCES test_kind(id),
  value_numeric  numeric(6,2),
  value_max      numeric(6,2),
  scale_value_id uuid REFERENCES grade_scale_value(id),
  parts          jsonb,                                  -- tests 💡 { "a": 30, "b": 25 }
  weight         numeric(6,2) NOT NULL DEFAULT 1 CHECK (weight >= 0),
  comment        text CHECK (comment IS NULL OR length(comment) <= 500),
  lesson_id      uuid REFERENCES lesson(id),
  assignment_id  uuid REFERENCES assignment(id),
  file_id        uuid REFERENCES file(id),              -- tests: the scanned answer sheet (5.11.3)
  source         text NOT NULL CHECK (source IN ('teacher', 'student', 'parent')),
  created_by     uuid NOT NULL REFERENCES account(id),
  status         text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'pending', 'rejected')),
  version        integer NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grade_entry_value CHECK (value_numeric IS NOT NULL OR scale_value_id IS NOT NULL),
  CONSTRAINT grade_entry_max CHECK (value_max IS NULL OR (value_numeric IS NOT NULL AND value_max > 0 AND value_numeric <= value_max))
);
CREATE INDEX grade_entry_journal_idx ON grade_entry (journal_id, date DESC, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX grade_entry_pending_idx ON grade_entry (teacher_id, created_at) WHERE status = 'pending' AND deleted_at IS NULL;
CREATE INDEX grade_entry_assignment_idx ON grade_entry (assignment_id, student_id) WHERE assignment_id IS NOT NULL AND deleted_at IS NULL;
CREATE TRIGGER grade_entry_set_updated_at BEFORE UPDATE ON grade_entry
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- JRN-05: every change of a record is kept; append-only like audit_log.
CREATE TABLE grade_entry_history (
  id          uuid PRIMARY KEY,
  entry_id    uuid NOT NULL REFERENCES grade_entry(id),
  changed_by  uuid REFERENCES account(id),
  action      text NOT NULL CHECK (action IN ('created', 'updated', 'deleted', 'confirmed', 'rejected')),
  before      jsonb,
  after       jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX grade_entry_history_entry_idx ON grade_entry_history (entry_id, at);
CREATE OR REPLACE FUNCTION grade_entry_history_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'grade_entry_history is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER grade_entry_history_no_update_delete
  BEFORE UPDATE OR DELETE ON grade_entry_history
  FOR EACH ROW EXECUTE FUNCTION grade_entry_history_immutable();

-- 5.11.2 💡: a grade entered by the student or a parent waits for the teacher, or is accepted at once.
ALTER TABLE teacher_profile ADD COLUMN grade_auto_confirm boolean NOT NULL DEFAULT false;
