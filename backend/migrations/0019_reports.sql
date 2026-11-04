-- M6-03: progress reports (5.12, 8.2 «report»): a snapshot of the period, sent to the student with copies.
CREATE TABLE report (
  id                  uuid PRIMARY KEY,
  teacher_id          uuid NOT NULL REFERENCES account(id),
  student_id          uuid NOT NULL REFERENCES account(id),
  teacher_student_id  uuid NOT NULL REFERENCES teacher_student(id),
  period_from         date NOT NULL,
  period_to           date NOT NULL,
  snapshot            jsonb NOT NULL,
  comment             text CHECK (comment IS NULL OR length(comment) <= 2000),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent')),
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (period_from <= period_to)
);
CREATE INDEX report_teacher_student_idx ON report (teacher_id, student_id, created_at DESC);
CREATE INDEX report_student_idx ON report (student_id, sent_at DESC) WHERE status = 'sent';
CREATE TRIGGER report_set_updated_at BEFORE UPDATE ON report
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
