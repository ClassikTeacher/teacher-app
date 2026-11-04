-- M1-06: feature flags and limits (5.3.1–5.3.3). The catalogue lives in code; rows hold admin overrides.

CREATE TABLE feature (
  key              text PRIMARY KEY,
  global_enabled   boolean NOT NULL DEFAULT true,   -- platform-wide switch
  default_enabled  boolean NOT NULL,                -- value for teachers without a personal override
  default_limits   jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by       uuid REFERENCES account(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER feature_set_updated_at BEFORE UPDATE ON feature
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE account_feature (
  account_id   uuid NOT NULL REFERENCES account(id),
  feature_key  text NOT NULL REFERENCES feature(key),
  enabled      boolean,                            -- NULL = follow the default
  limits       jsonb,                              -- NULL = follow default_limits; keys override individually
  updated_by   uuid REFERENCES account(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, feature_key)
);
CREATE TRIGGER account_feature_set_updated_at BEFORE UPDATE ON account_feature
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
