-- M1-03 review fix: audit rows must be immutable even for the table owner (AUD-01).
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- M1-04: teacher profile filled during onboarding (5.1.2) and settings (8.2 teacher_profile).
CREATE TABLE teacher_profile (
  account_id                   uuid PRIMARY KEY REFERENCES account(id),
  subject_ids                  uuid[] NOT NULL DEFAULT '{}',
  default_duration_min         integer NOT NULL DEFAULT 60 CHECK (default_duration_min BETWEEN 15 AND 480),
  buffer_before_min            integer NOT NULL DEFAULT 0 CHECK (buffer_before_min BETWEEN 0 AND 120),
  buffer_after_min             integer NOT NULL DEFAULT 0 CHECK (buffer_after_min BETWEEN 0 AND 120),
  calendar_mode                text NOT NULL DEFAULT 'closed' CHECK (calendar_mode IN ('closed', 'open_all', 'open_selected')),
  booking_confirmation         text NOT NULL DEFAULT 'auto' CHECK (booking_confirmation IN ('auto', 'manual')),
  booking_rules                jsonb NOT NULL DEFAULT '{}'::jsonb,
  late_cancel_hours            integer NOT NULL DEFAULT 24 CHECK (late_cancel_hours >= 0),
  student_cancel_cutoff_hours  integer CHECK (student_cancel_cutoff_hours >= 0),
  student_can_cancel           boolean NOT NULL DEFAULT true,
  parent_can_cancel            boolean NOT NULL DEFAULT true,
  default_notice_text          text NOT NULL DEFAULT '',
  onboarded_at                 timestamptz,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER teacher_profile_set_updated_at BEFORE UPDATE ON teacher_profile
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
