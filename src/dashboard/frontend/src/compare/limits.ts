/**
 * Team-comparison bounds (Task 4.9). A rich side-by-side comparison holds at
 * least 2 and at most 4 teams — beyond 4, per-metric rows and overlaid lines get
 * unreadable (the large-org case is the sortable table in 4.10).
 *
 * These MIRROR the backend constants in src/dashboard/api/compare.ts
 * (MIN_COMPARE_TEAMS / MAX_COMPARE_TEAMS); the browser bundle can't import that
 * Node module, so keep the two in lock-step. The UI prevents selecting a 5th
 * team; the API rejects it regardless, so the cap holds even if they drift.
 */
export const MIN_COMPARE_TEAMS = 2;
export const MAX_COMPARE_TEAMS = 4;
