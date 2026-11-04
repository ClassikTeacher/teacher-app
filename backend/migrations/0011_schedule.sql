-- M3: schedule — personal blocks, series, lessons, participants, occupancy (7.5), lesson history,
-- availability windows. PRODUCT-SPEC 5.5, 5.6, 8.2 "calendar".

-- personal "busy" block of a teacher (5.5.2, Р-17); only the teacher's occupancy
CREATE TABLE personal_block (
  id          uuid PRIMARY KEY,
  teacher_id  uuid NOT NULL REFERENCES account(id),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  title       text CHECK (title IS NULL OR length(title) <= 100),
  removed_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX personal_block_teacher_idx ON personal_block (teacher_id, starts_at) WHERE removed_at IS NULL;
CREATE TRIGGER personal_block_set_updated_at BEFORE UPDATE ON personal_block
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- regular lessons (5.5.6): RRULE is only the storage format, expansion happens in the teacher's zone (7.5)
CREATE TABLE lesson_series (
  id                  uuid PRIMARY KEY,
  teacher_id          uuid NOT NULL REFERENCES account(id),
  student_id          uuid REFERENCES account(id),
  group_id            uuid REFERENCES study_group(id),
  rrule               text NOT NULL,
  start_local         time NOT NULL,
  duration_min        integer NOT NULL CHECK (duration_min BETWEEN 15 AND 480),
  timezone            text NOT NULL,
  starts_on           date NOT NULL,
  ends_on             date,
  paused_from         date,
  paused_to           date,
  materialized_until  date,
  subject_id          uuid REFERENCES subject(id),
  format              text CHECK (format IS NULL OR format IN ('online', 'in_person', 'at_student')),
  location            text,
  meeting_url         text,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((student_id IS NULL) <> (group_id IS NULL)),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CHECK ((paused_from IS NULL) = (paused_to IS NULL)),
  CHECK (paused_to IS NULL OR paused_to >= paused_from)
);
CREATE INDEX lesson_series_teacher_idx ON lesson_series (teacher_id) WHERE status = 'active';
CREATE INDEX lesson_series_materialize_idx ON lesson_series (materialized_until) WHERE status = 'active';
CREATE TRIGGER lesson_series_set_updated_at BEFORE UPDATE ON lesson_series
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- lesson (5.6.1, 5.6.2); times in UTC; version grows on every time/participant/status change (LES-05, NTF-08)
CREATE TABLE lesson (
  id               uuid PRIMARY KEY,
  teacher_id       uuid NOT NULL REFERENCES account(id),
  group_id         uuid REFERENCES study_group(id),
  series_id        uuid REFERENCES lesson_series(id),
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled', 'cancelled', 'awaiting_report', 'completed', 'not_held')),
  subject_id       uuid REFERENCES subject(id),
  planned_topic    text CHECK (planned_topic IS NULL OR length(planned_topic) <= 200),
  topic            text CHECK (topic IS NULL OR length(topic) <= 200),
  format           text CHECK (format IS NULL OR format IN ('online', 'in_person', 'at_student')),
  location         text CHECK (location IS NULL OR length(location) <= 200),
  meeting_url      text CHECK (meeting_url IS NULL OR length(meeting_url) <= 500),
  shared_comment   text CHECK (shared_comment IS NULL OR length(shared_comment) <= 2000),
  teacher_notes    text CHECK (teacher_notes IS NULL OR length(teacher_notes) <= 2000),
  seq_no           integer,                                    -- only individual lessons (5.6.1 "Номер")
  not_held_reason  text CHECK (not_held_reason IS NULL OR length(not_held_reason) <= 500),
  reported_at      timestamptz,                                -- completed / not_held decided at
  outside_windows  boolean NOT NULL DEFAULT false,             -- CAL-09 mark, informational
  created_by       uuid REFERENCES account(id),
  created_via      text NOT NULL DEFAULT 'teacher'
                   CHECK (created_via IN ('teacher', 'student_booking', 'series', 'booking_accepted')),
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (status <> 'not_held' OR not_held_reason IS NOT NULL),
  CHECK (status NOT IN ('completed', 'not_held') OR reported_at IS NOT NULL)
);
CREATE INDEX lesson_teacher_time_idx ON lesson (teacher_id, starts_at);
CREATE INDEX lesson_group_idx ON lesson (group_id, starts_at) WHERE group_id IS NOT NULL;
CREATE INDEX lesson_series_idx ON lesson (series_id, starts_at) WHERE series_id IS NOT NULL;
-- one live instance of a series per start (materialisation re-runs never duplicate, 5.5.6)
CREATE UNIQUE INDEX lesson_series_instance_uniq ON lesson (series_id, starts_at)
  WHERE series_id IS NOT NULL AND status <> 'cancelled';
-- LES-01 sweep: scheduled lessons whose end passed
CREATE INDEX lesson_scheduled_end_idx ON lesson (ends_at) WHERE status = 'scheduled';
CREATE INDEX lesson_awaiting_idx ON lesson (teacher_id, ends_at) WHERE status = 'awaiting_report';
CREATE TRIGGER lesson_set_updated_at BEFORE UPDATE ON lesson
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- per-pair counter behind lesson.seq_no ("Занятие №12"); incremented under the link row lock
ALTER TABLE teacher_student ADD COLUMN lesson_seq integer NOT NULL DEFAULT 0;

CREATE TABLE lesson_participant (
  id              uuid PRIMARY KEY,
  lesson_id       uuid NOT NULL REFERENCES lesson(id),
  student_id      uuid NOT NULL REFERENCES account(id),
  attendance      text CHECK (attendance IS NULL OR attendance IN ('present', 'late', 'absent_notified', 'absent')),
  absence_reason  text CHECK (absence_reason IS NULL OR length(absence_reason) <= 500),
  added_at        timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX lesson_participant_active_uniq ON lesson_participant (lesson_id, student_id) WHERE removed_at IS NULL;
CREATE INDEX lesson_participant_student_idx ON lesson_participant (student_id, lesson_id) WHERE removed_at IS NULL;

-- occupancy (7.5, CAL-01): one row per participant; the teacher's row is widened by the buffers (CAL-04),
-- which are recorded here so a later settings change does not touch existing rows
CREATE TABLE occupancy (
  id                 uuid PRIMARY KEY,
  account_id         uuid NOT NULL REFERENCES account(id),
  kind               text NOT NULL CHECK (kind IN ('lesson', 'block')),
  lesson_id          uuid REFERENCES lesson(id),
  block_id           uuid REFERENCES personal_block(id),
  during             tstzrange NOT NULL,                           -- '[start, end)'
  buffer_before_min  integer NOT NULL DEFAULT 0 CHECK (buffer_before_min BETWEEN 0 AND 120),
  buffer_after_min   integer NOT NULL DEFAULT 0 CHECK (buffer_after_min BETWEEN 0 AND 120),
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT occupancy_source CHECK (
    (kind = 'lesson' AND lesson_id IS NOT NULL AND block_id IS NULL) OR
    (kind = 'block'  AND block_id  IS NOT NULL AND lesson_id IS NULL)
  ),
  CONSTRAINT occupancy_bounds CHECK (
    lower_inc(during) AND NOT upper_inc(during) AND NOT isempty(during)
    AND NOT lower_inf(during) AND NOT upper_inf(during)
  ),
  CONSTRAINT occupancy_no_overlap
    EXCLUDE USING gist (account_id WITH =, during WITH &&) WHERE (is_active)
);
CREATE INDEX occupancy_lesson_idx ON occupancy (lesson_id) WHERE lesson_id IS NOT NULL;
CREATE INDEX occupancy_block_idx ON occupancy (block_id) WHERE block_id IS NOT NULL;
CREATE TRIGGER occupancy_set_updated_at BEFORE UPDATE ON occupancy
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- immutable lesson history (LES-05)
CREATE TABLE lesson_event (
  id         uuid PRIMARY KEY,
  lesson_id  uuid NOT NULL REFERENCES lesson(id),
  type       text NOT NULL,
  actor_id   uuid REFERENCES account(id),
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lesson_event_lesson_idx ON lesson_event (lesson_id, at);
CREATE OR REPLACE FUNCTION lesson_event_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'lesson_event is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER lesson_event_no_update_delete
  BEFORE UPDATE OR DELETE ON lesson_event
  FOR EACH ROW EXECUTE FUNCTION lesson_event_immutable();

-- availability windows (5.5.4): weekly rules in the teacher's local time (CAL-05), ISO weekday 1 = Monday
CREATE TABLE availability_rule (
  id           uuid PRIMARY KEY,
  teacher_id   uuid NOT NULL REFERENCES account(id),
  weekday      integer NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_local  time NOT NULL,
  end_local    time NOT NULL,
  valid_from   date,
  valid_to     date,
  removed_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (end_local > start_local),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE INDEX availability_rule_teacher_idx ON availability_rule (teacher_id, weekday) WHERE removed_at IS NULL;

-- date exceptions: close a day or an interval, or open an extra interval
CREATE TABLE availability_exception (
  id           uuid PRIMARY KEY,
  teacher_id   uuid NOT NULL REFERENCES account(id),
  date         date NOT NULL,
  start_local  time,
  end_local    time,
  kind         text NOT NULL CHECK (kind IN ('closed', 'extra')),
  removed_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((start_local IS NULL) = (end_local IS NULL)),
  CHECK (start_local IS NULL OR end_local > start_local),
  CHECK (kind <> 'extra' OR start_local IS NOT NULL)
);
CREATE INDEX availability_exception_teacher_idx ON availability_exception (teacher_id, date) WHERE removed_at IS NULL;
