-- M5-02: materials, collections, access grants, lesson materials (5.9, 8.2 «content»).
CREATE TABLE material (
  id           uuid PRIMARY KEY,
  teacher_id   uuid NOT NULL REFERENCES account(id),
  kind         text NOT NULL CHECK (kind IN ('file', 'link', 'text')),
  title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description  text,
  file_id      uuid REFERENCES file(id),
  url          text,
  body         text,
  subject_id   uuid REFERENCES subject(id),
  tags         text[] NOT NULL DEFAULT '{}',
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT material_kind_payload CHECK (
    (kind = 'file' AND file_id IS NOT NULL AND url IS NULL AND body IS NULL) OR
    (kind = 'link' AND url IS NOT NULL AND file_id IS NULL AND body IS NULL) OR
    (kind = 'text' AND body IS NOT NULL AND file_id IS NULL AND url IS NULL)
  )
);
CREATE INDEX material_teacher_idx ON material (teacher_id, created_at DESC) WHERE archived_at IS NULL;
CREATE TRIGGER material_set_updated_at BEFORE UPDATE ON material
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- flat in MVP (sections are stage 2, Р-30); the optional period is for «Материалы за ноябрь»
CREATE TABLE collection (
  id           uuid PRIMARY KEY,
  teacher_id   uuid NOT NULL REFERENCES account(id),
  title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description  text,
  period_from  date,
  period_to    date,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (period_from IS NULL OR period_to IS NULL OR period_from <= period_to)
);
CREATE INDEX collection_teacher_idx ON collection (teacher_id) WHERE archived_at IS NULL;
CREATE TRIGGER collection_set_updated_at BEFORE UPDATE ON collection
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE collection_item (
  id             uuid PRIMARY KEY,
  collection_id  uuid NOT NULL REFERENCES collection(id),
  item_type      text NOT NULL CHECK (item_type IN ('material', 'assignment')),
  item_id        uuid NOT NULL,
  position       integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_id, item_type, item_id)
);

-- materials of a lesson are handed to its participants before (on attach) or after (on the report) (5.9.3)
CREATE TABLE lesson_material (
  id             uuid PRIMARY KEY,
  lesson_id      uuid NOT NULL REFERENCES lesson(id),
  material_id    uuid REFERENCES material(id),
  collection_id  uuid REFERENCES collection(id),
  release        text NOT NULL CHECK (release IN ('before', 'after')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((material_id IS NULL) <> (collection_id IS NULL))
);
CREATE INDEX lesson_material_lesson_idx ON lesson_material (lesson_id);

-- who may see what (MAT-01); a group grant follows its membership, so new members are included (5.9.3)
CREATE TABLE access_grant (
  id                uuid PRIMARY KEY,
  teacher_id        uuid NOT NULL REFERENCES account(id),
  subject_type      text NOT NULL CHECK (subject_type IN ('material', 'collection', 'assignment')),
  subject_id        uuid NOT NULL,
  grantee_type      text NOT NULL CHECK (grantee_type IN ('student', 'group')),
  grantee_id        uuid NOT NULL,
  available_from    timestamptz,
  available_until   timestamptz,
  granted_by        uuid REFERENCES account(id),
  source_lesson_id  uuid REFERENCES lesson(id),
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (available_from IS NULL OR available_until IS NULL OR available_from < available_until)
);
CREATE INDEX access_grant_grantee_idx ON access_grant (grantee_type, grantee_id) WHERE revoked_at IS NULL;
CREATE INDEX access_grant_subject_idx ON access_grant (subject_type, subject_id) WHERE revoked_at IS NULL;

-- 💡 «просмотрено»: the teacher sees whether the student opened a material
CREATE TABLE material_view (
  id               uuid PRIMARY KEY,
  material_id      uuid NOT NULL REFERENCES material(id),
  student_id       uuid NOT NULL REFERENCES account(id),
  first_viewed_at  timestamptz NOT NULL,
  last_viewed_at   timestamptz NOT NULL,
  UNIQUE (material_id, student_id)
);

-- a lesson hands a subject to a student once (idempotent handlers under redelivery and concurrency)
CREATE UNIQUE INDEX access_grant_lesson_uniq
  ON access_grant (subject_type, subject_id, grantee_id, source_lesson_id)
  WHERE source_lesson_id IS NOT NULL;
