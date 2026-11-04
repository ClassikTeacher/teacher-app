-- M1-07 review: prefix cancellation (`starts_with(dedupe_key, …)`) and reconciliation of stuck rows need indexes.
CREATE INDEX notification_dedupe_prefix_idx ON notification (dedupe_key text_pattern_ops);
CREATE INDEX notification_stuck_idx ON notification (status, updated_at) WHERE status IN ('queued', 'sending');
