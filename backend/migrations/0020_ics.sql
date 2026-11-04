-- M6-04: ICS subscription feeds (5.14.2, 8.2 «ics_feed»): one live secret link per account, re-issuable.
CREATE TABLE ics_feed (
  id          uuid PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES account(id),
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE UNIQUE INDEX ics_feed_account_live_uniq ON ics_feed (account_id) WHERE revoked_at IS NULL;
