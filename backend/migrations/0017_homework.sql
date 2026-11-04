-- M5-03/M5-04: assignments, per-student targets, submissions and reviews (5.10, 8.2 «homework»).
CREATE TABLE assignment (
  id                  uuid PRIMARY KEY,
  teacher_id          uuid NOT NULL REFERENCES account(id),
  title               text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body                text,
  due_mode            text NOT NULL CHECK (due_mode IN ('fixed', 'next_lesson', 'none')),
  due_at              timestamptz,                       -- fixed mode only; targets carry their own
  assigned_lesson_id  uuid REFERENCES lesson(id),
  check_lesson_id     uuid REFERENCES lesson(id),
  collection_id       uuid REFERENCES collection(id),
  submission_mode     text NOT NULL CHECK (submission_mode IN ('files', 'text', 'files_text', 'mark', 'none')),
  submission_rules    jsonb NOT NULL DEFAULT '{}',       -- { allowedExts?, maxFiles?, allowResubmit, acceptLate }
  grading             jsonb NOT NULL DEFAULT '{"kind":"none"}',  -- { kind: none | pass_fail | journal, journalId?, scaleId? }
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed')),
  published_at        timestamptz,
  closed_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (due_mode <> 'fixed' OR due_at IS NOT NULL)
);
CREATE INDEX assignment_teacher_idx ON assignment (teacher_id, status, created_at DESC);
CREATE TRIGGER assignment_set_updated_at BEFORE UPDATE ON assignment
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- groups an assignment was addressed to: members joining later become targets while it is published (5.9.3)
CREATE TABLE assignment_group (
  id             uuid PRIMARY KEY,
  assignment_id  uuid NOT NULL REFERENCES assignment(id),
  group_id       uuid NOT NULL REFERENCES study_group(id),
  UNIQUE (assignment_id, group_id)
);

-- one row per student: their own due date (next-lesson mode), status machine of 5.10.2
CREATE TABLE assignment_target (
  id             uuid PRIMARY KEY,
  assignment_id  uuid NOT NULL REFERENCES assignment(id),
  student_id     uuid NOT NULL REFERENCES account(id),
  due_at         timestamptz,
  due_lesson_id  uuid REFERENCES lesson(id),             -- the lesson the due date follows (next_lesson mode)
  status         text NOT NULL DEFAULT 'assigned'
                 CHECK (status IN ('assigned', 'submitted', 'overdue', 'returned', 'accepted', 'withdrawn')),
  viewed_at      timestamptz,
  overdue_notified_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, student_id)
);
CREATE INDEX assignment_target_student_idx ON assignment_target (student_id, status);
CREATE INDEX assignment_target_due_idx ON assignment_target (due_at) WHERE status = 'assigned';
CREATE TRIGGER assignment_target_set_updated_at BEFORE UPDATE ON assignment_target
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE submission (
  id             uuid PRIMARY KEY,
  assignment_id  uuid NOT NULL REFERENCES assignment(id),
  target_id      uuid NOT NULL REFERENCES assignment_target(id),
  teacher_id     uuid NOT NULL REFERENCES account(id),  -- denormalised owner (8.0)
  student_id     uuid NOT NULL REFERENCES account(id),
  attempt_no     integer NOT NULL CHECK (attempt_no >= 1),
  text           text,
  submitted_at   timestamptz NOT NULL,
  is_late        boolean NOT NULL DEFAULT false,
  UNIQUE (target_id, attempt_no)
);
CREATE INDEX submission_teacher_idx ON submission (teacher_id, submitted_at);

CREATE TABLE submission_file (
  id             uuid PRIMARY KEY,
  submission_id  uuid NOT NULL REFERENCES submission(id),
  file_id        uuid NOT NULL REFERENCES file(id),
  position       integer NOT NULL DEFAULT 0,
  UNIQUE (submission_id, file_id)
);

CREATE TABLE submission_review (
  id              uuid PRIMARY KEY,
  submission_id   uuid NOT NULL UNIQUE REFERENCES submission(id),
  reviewer_id     uuid NOT NULL REFERENCES account(id),
  decision        text NOT NULL CHECK (decision IN ('accepted', 'returned')),
  comment         text,
  grade_entry_id  uuid,                                  -- M6-01 fills it when a grade is given
  reviewed_at     timestamptz NOT NULL
);

CREATE TABLE submission_review_file (
  id         uuid PRIMARY KEY,
  review_id  uuid NOT NULL REFERENCES submission_review(id),
  file_id    uuid NOT NULL REFERENCES file(id),
  position   integer NOT NULL DEFAULT 0,
  UNIQUE (review_id, file_id)
);
