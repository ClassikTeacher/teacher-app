-- E2-05: Google Calendar (PRODUCT-SPEC 5.14.1, 5.5.2 «мягкая занятость», 8.2 «external_busy», 10.1 «токены шифруются»).

-- busy intervals imported from an external calendar: a soft block (students do not see the time as free,
-- the teacher is only warned). Owned by the schedule module; the integration replaces the rows of its source.
CREATE TABLE external_busy (
  id          uuid PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES account(id),
  source      text NOT NULL CHECK (source IN ('google')),
  during      tstzrange NOT NULL,
  synced_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_busy_bounds CHECK (
    lower_inc(during) AND NOT upper_inc(during) AND NOT isempty(during)
    AND NOT lower_inf(during) AND NOT upper_inf(during)
  )
);
CREATE INDEX external_busy_account_idx ON external_busy (account_id, source);
CREATE INDEX external_busy_during_idx ON external_busy USING gist (account_id, during);

-- one live connection per teacher; tokens are sealed with GOOGLE_TOKEN_KEY (SecretBox), never stored in clear
CREATE TABLE google_calendar_connection (
  id                       uuid PRIMARY KEY,
  account_id               uuid NOT NULL REFERENCES account(id),
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'revoked')),
  google_email             text,
  calendar_id              text,                      -- the app-created calendar («Занятия») that mirrors lessons
  refresh_token_enc        text NOT NULL,
  access_token_enc         text,
  access_token_expires_at  timestamptz,
  busy_calendar_ids        text[] NOT NULL DEFAULT '{primary}',
  import_enabled           boolean NOT NULL DEFAULT true,  -- freebusy → external_busy
  export_enabled           boolean NOT NULL DEFAULT true,  -- lessons → the app calendar
  last_import_at           timestamptz,
  last_export_at           timestamptz,
  export_requested_at      timestamptz,               -- set by lesson events; the job exports at once
  last_error               text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  revoked_at               timestamptz
);
CREATE UNIQUE INDEX google_calendar_connection_live_uniq
  ON google_calendar_connection (account_id) WHERE revoked_at IS NULL;
CREATE TRIGGER google_calendar_connection_set_updated_at BEFORE UPDATE ON google_calendar_connection
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- lesson → Google event of a connection; `signature` is what was last written, so unchanged lessons are skipped
CREATE TABLE google_calendar_event (
  id               uuid PRIMARY KEY,
  connection_id    uuid NOT NULL REFERENCES google_calendar_connection(id),
  lesson_id        uuid NOT NULL REFERENCES lesson(id),
  google_event_id  text NOT NULL,
  signature        text NOT NULL,
  synced_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (connection_id, lesson_id)
);

-- one-time OAuth `state` (hashed), bound to the account, 15 minutes to complete the consent screen
CREATE TABLE google_oauth_state (
  id          uuid PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES account(id),
  state_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
