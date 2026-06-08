-- Data-prompted surveys (Task 4.3 / #98).
--
-- Turns the platform's own observations into targeted, respectful questions
-- ("we see your Copilot usage dropped 40% — did you switch tools, reduce AI
-- use, or something else?"). A survey is created from a trigger condition
-- detected in the data, queued, then either auto-sent or held for a manager to
-- review and send (manager-configurable per trigger type via the 4.12 settings).
-- Responses are stored and surfaced to the manager as context alongside the
-- triggering data point — never used punitively.
--
-- `choices` is an extension over the bare issue schema: the exact tap-to-answer
-- options presented to the developer are persisted as a JSON array at creation
-- time, so a survey is a faithful audit record of what was actually asked (and
-- so manual surveys can carry custom choices without re-deriving them).
CREATE TABLE surveys (
    id TEXT PRIMARY KEY,
    developer_id TEXT NOT NULL REFERENCES developers(id),
    trigger_type TEXT NOT NULL,           -- usage_drop | unused_new_seat |
                                          -- plan_change | anomaly | manual
    trigger_context TEXT,                 -- JSON: what was observed
    question_text TEXT NOT NULL,
    choices TEXT,                         -- JSON array of {value,label} tap-to-answer options
    status TEXT NOT NULL,                 -- queued | sent | answered | declined | dismissed
    delivery TEXT,                        -- slack | email (set when sent)
    created_at TEXT NOT NULL,
    sent_at TEXT
);

CREATE TABLE survey_responses (
    id TEXT PRIMARY KEY,
    survey_id TEXT NOT NULL REFERENCES surveys(id),
    response_text TEXT,
    response_choice TEXT,                 -- if a multiple-choice answer
    answered_at TEXT NOT NULL
);

-- Manager queue (filter by status/trigger) and the developer's own-surveys view
-- both read by developer + recency.
CREATE INDEX idx_surveys_developer ON surveys(developer_id, created_at);
CREATE INDEX idx_surveys_status ON surveys(status);
CREATE INDEX idx_survey_responses_survey ON survey_responses(survey_id);
