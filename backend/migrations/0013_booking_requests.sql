-- M4-03 / M4-04: requests from students and parents (5.5.5 «Режим с подтверждением», 5.7.4 «Перенос»).
-- A request never occupies time (Р-22, Р-24): the lesson is created or moved through CAL-01 when the teacher accepts.

CREATE TABLE booking_request (
  id                uuid PRIMARY KEY,
  teacher_id        uuid NOT NULL REFERENCES account(id),
  student_id        uuid NOT NULL REFERENCES account(id),
  kind              text NOT NULL CHECK (kind IN ('booking', 'reschedule', 'reschedule_ask')),
  lesson_id         uuid REFERENCES lesson(id),                 -- the lesson to move (reschedule kinds)
  starts_at         timestamptz,                                -- the wanted slot (not for reschedule_ask)
  ends_at           timestamptz,
  comment           text CHECK (comment IS NULL OR length(comment) <= 500),
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
  created_by        uuid NOT NULL REFERENCES account(id),       -- the student, or a parent on their behalf
  decided_by        uuid REFERENCES account(id),
  decision_message  text CHECK (decision_message IS NULL OR length(decision_message) <= 500),
  decision_reason   text,                                       -- accepted / declined / slot_taken / expired / lesson_changed
  decided_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'booking') = (lesson_id IS NULL)),
  CHECK ((kind = 'reschedule_ask') = (starts_at IS NULL)),
  CHECK ((starts_at IS NULL) = (ends_at IS NULL)),
  CHECK (starts_at IS NULL OR ends_at > starts_at),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
CREATE INDEX booking_request_teacher_pending_idx ON booking_request (teacher_id, created_at) WHERE status = 'pending';
CREATE INDEX booking_request_student_idx ON booking_request (student_id, created_at);
CREATE INDEX booking_request_lesson_idx ON booking_request (lesson_id) WHERE lesson_id IS NOT NULL;
-- one open request per lesson and student (a second «перенести» replaces nothing; the first must be decided)
CREATE UNIQUE INDEX booking_request_lesson_pending_uniq ON booking_request (lesson_id, student_id)
  WHERE status = 'pending' AND lesson_id IS NOT NULL;
CREATE TRIGGER booking_request_set_updated_at BEFORE UPDATE ON booking_request
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
