-- Anomaly Slack notification tracking (Task 4.8 / #103).
--
-- `notified_at` records when a notable/high anomaly was pushed to its Slack
-- alert channel(s), so the surfacing notifier fires EXACTLY ONCE per anomaly and
-- a scheduled re-scan of the same week never re-spams the manager. It is left
-- NULL on insert and deliberately preserved across the idempotent upsert in
-- src/anomaly/store.ts (the conflict-update never touches it), so a re-detected
-- anomaly that was already announced stays announced. A genuinely new occurrence
-- — one that cleared and later re-fired — is a fresh row with notified_at NULL
-- and so is announced again, which is correct.
ALTER TABLE anomalies ADD COLUMN notified_at TEXT;

-- The notifier scans for open, surfaceable, not-yet-announced anomalies.
CREATE INDEX idx_anomalies_notified ON anomalies (status, notified_at);
