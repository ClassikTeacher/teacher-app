-- M4-01: cancellations (5.7, CNL-08) — one row per act of cancelling (single, bulk or system) and one item per
-- affected lesson; an absence notice in a group lesson (CNL-03) is an item of action 'absence' with the student.

CREATE TABLE cancellation (
  id                      uuid PRIMARY KEY,
  initiator_id            uuid REFERENCES account(id),             -- NULL for the system (5.7.6)
  initiator_role          text NOT NULL
                          CHECK (initiator_role IN ('TEACHER', 'STUDENT', 'PARENT', 'ADMIN', 'SYSTEM')),
  on_behalf_of_student_id uuid REFERENCES account(id),             -- the parent's child (Р-25)
  kind                    text NOT NULL CHECK (kind IN ('single', 'bulk', 'system')),
  reason                  text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  template_id             uuid REFERENCES message_template(id),
  source                  text,                                    -- 5.7.6: the event behind a system cancellation
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cancellation_initiator_idx ON cancellation (initiator_id, created_at);

CREATE TABLE cancellation_item (
  id               uuid PRIMARY KEY,
  cancellation_id  uuid NOT NULL REFERENCES cancellation(id),
  lesson_id        uuid NOT NULL REFERENCES lesson(id),
  action           text NOT NULL CHECK (action IN ('cancelled', 'absence')),
  student_id       uuid REFERENCES account(id),                    -- the absent student (action = 'absence')
  is_late          boolean NOT NULL DEFAULT false,                 -- CNL-06
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((action = 'absence') = (student_id IS NOT NULL))
);
-- a lesson is cancelled once; a student reports absence from one lesson once
CREATE UNIQUE INDEX cancellation_item_lesson_uniq ON cancellation_item (lesson_id, student_id) NULLS NOT DISTINCT;
CREATE INDEX cancellation_item_batch_idx ON cancellation_item (cancellation_id);

-- when and by which act a lesson was cancelled (denormalised for lists and reports)
ALTER TABLE lesson ADD COLUMN cancelled_at timestamptz;
ALTER TABLE lesson ADD COLUMN cancellation_id uuid REFERENCES cancellation(id);
ALTER TABLE lesson ADD CONSTRAINT lesson_cancelled_at_chk CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL);
