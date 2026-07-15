# Shared dashboard components (Task 2.10)

The reusable building blocks every dashboard screen composes from. Import from
`components/` (UI primitives) and `charts/` (Recharts wrappers). All components
are themed via the design tokens in `index.css` — they render correctly in light
and dark mode with no per-component theming.

Time-range helpers live in `timeRange/range.ts`; the `useTimeRange` hook lives in
`hooks/`.

---

## Layout & navigation

### `AppShell`
Header + role-aware sidebar + routed content area. Screens render into the
`<Outlet />`. Already wired into the router; new screens just add a `<Route>`.

### `Sidebar` / `navConfig`
Role-aware navigation. `navSectionsForRole(role)` returns the sections for a
role: an **admin** (the platform's "manager") sees Manager + Admin + Account; a
**developer** sees Developer + Account. With an unknown role (component rendered
outside an `AuthProvider`) both non-admin areas show. Add new destinations by
extending the section catalog in `navConfig.ts`.

### `Header` / `DarkModeToggle`
`DarkModeToggle` flips the live theme optimistically and persists `dark_mode` to
`/api/me/preferences`, rolling back if the write fails. Drop it anywhere; it
needs a `ThemeProvider` and a React Query client in the tree.

---

## Metric display

### `StatCard`
```tsx
<StatCard
  label="Monthly waste"
  value="$1,200"                       // caller pre-formats the value
  hint="3 active alerts"
  trend={{value: -150, goodWhen: 'down'}}  // optional change indicator
  sparkline={[10, 8, 6, 4]}            // optional mini trend (oldest → newest)
/>
```
| Prop | Type | Notes |
|------|------|-------|
| `label` | `string` | Upper-case caption |
| `value` | `string` | Headline metric, pre-formatted |
| `hint?` | `string` | Sub-caption |
| `trend?` | `TrendIndicatorProps` | See below |
| `sparkline?` | `number[]` | Needs ≥2 points to draw |
| `sparklineColor?` | `string` | Defaults to the accent token |

### `TrendIndicator`
`{ value, goodWhen?, format?, suffix? }`. The sign of `value` drives the arrow;
`goodWhen` (`'up'` default, `'down'` for cost/waste) drives the color. A zero
value renders neutral with no arrow.

### `Sparkline`
`{ data: number[], width?, height?, color?, area?, className? }`. Lightweight
inline-SVG trend line (no axes/tooltip). Returns `null` for `< 2` points.

### `Badge` / `CoverageBadge`
`Badge` is the tone pill primitive (`neutral | accent | success | warning |
danger`). `CoverageBadge` reports how many real data-days back a view:
```tsx
<CoverageBadge dataDays={9} spanDays={30} />  // "9 of 30 days", medium confidence
<CoverageBadge dataDays={20} />               // "20 days of data", high confidence
```
Tiers: 0 = none, `< 7` = low, `< 14` = medium, `≥ 14` = high (14 days is the
platform's significance threshold).

---

## Time range

### `TimeRangeSelector`
Controlled selector with preset chips (30d / 90d / Year / All) + a Custom mode
with a from/to date picker. Custom validates `from ≤ to` and only emits a change
once both dates are valid.
```tsx
const {range, setRange} = useTimeRange({earliest: coverage.earliest});
<TimeRangeSelector value={range} onChange={setRange} earliest={coverage.earliest} />
```
| Prop | Type | Notes |
|------|------|-------|
| `value` | `TimeRangeValue` | `{ kind, from, to }` |
| `onChange` | `(v: TimeRangeValue) => void` | Receives a fully resolved window |
| `earliest?` | `string \| null` | Earliest data date — drives `lifetime` |
| `now?` | `Date` | Test override |

### `useTimeRange({ earliest?, now? })`
Owns a screen's range state and reconciles three things:
1. **Smart default** — until anything is known, the smallest preset that
   contains the scope's history (`smartDefaultPreset`).
2. **Remembered choice** — once preferences load, an explicit stored preset
   (anything ≠ the registry default `30d`) wins, persisting across sessions.
3. **Live interaction** — once the user picks here, that wins for the session;
   preset picks are persisted to `/api/me/preferences` (custom ranges, which
   carry dates, stay session-local).

Returns `{ range, setRange, isPending }`.

### `timeRange/range.ts` helpers
Pure, mirror the backend parser (`src/dashboard/api/range.ts`):
`resolvePreset`, `presetValue`, `smartDefaultPreset`, `inclusiveDayCount`,
`isValidDateString`, plus `PRESET_ORDER` / `PRESET_LABELS` / `PRESET_SHORT_LABELS`.

---

## Charts (`charts/`)

All take a `height` (default 256), render a themed tooltip, fall back to a shared
empty state, and read colors from `useChartTheme()` (token-driven, light/dark).
A `ChartSeries` is `{ key, label?, color? }`.

### `TrendChart` — line/area for time series
```tsx
<TrendChart data={points} xKey="date" series={[{key: 'commits', label: 'Commits'}]}
            variant="area" valueFormatter={fmt} />
```

### `ComparisonChart` — bars across categories
```tsx
<ComparisonChart data={teams} categoryKey="team" series={[{key: 'cost'}]}
                 layout="horizontal" />
```
Single-series charts may pass `categoryColors` to color each bar (e.g. quality
tiers).

### `DistributionChart` — donut for a mix
```tsx
<DistributionChart data={[{label: 'Copilot', value: 6}, {label: 'Claude', value: 4}]}
                   centerLabel={{value: '10', caption: 'tools'}} />
```
Slices with value 0 are dropped. Legend shown by default.

### `useChartTheme()`
Resolves the design tokens to concrete `rgb()` strings for the active theme
(Recharts can't use CSS `var()` in SVG attributes). Production reads the live CSS
variables; a fallback map keeps tests deterministic. Use it for any custom chart.

---

## Loading states (`Skeleton`)

`Skeleton` (primitive shimmer) plus `SkeletonText`, `SkeletonStatCard`,
`SkeletonChart`, `SkeletonTable` — match the footprint of the content they stand
in for so layouts don't jump when data arrives.

---

## Tables (`DataTable<T>`)

Generic, client-side sortable table.
```tsx
const columns: Column<Team>[] = [
  {key: 'name', header: 'Team', accessor: (t) => t.name},
  {key: 'cost', header: 'Cost', accessor: (t) => t.cost, align: 'right',
   render: (t) => formatCurrency(t.cost)},
];
<DataTable columns={columns} rows={teams} getRowKey={(t) => t.id}
           initialSort={{key: 'cost', direction: 'desc'}} />
```
Columns with an `accessor` are sortable (clicking the header toggles asc/desc);
add `sortable: false` to opt out. Sorting copies the array — the caller's `rows`
are never mutated. `render` supplies rich cells; `accessor` supplies the sort key
and default text.

**Controlled sort (#215).** Pass `sort` + `onSortChange` together and the parent
owns the ordering: header clicks report the next `{key, direction}` through the
callback, `sort` drives the indicators/aria-sort, and `rows` render AS GIVEN
(pre-sorted by the parent). Use it when sorting must compose with parent-side
pagination or a comparator accessors can't express (e.g. the repo-scope modal's
grouped selection sort). In controlled mode `sortable: true` force-enables a
render-only column; in self-sorting mode that flag is ignored (fail-closed — the
table can't sort without an accessor). Passing `sort` without `onSortChange` is a
mistake and warns in dev (an `onSortChange` with no `sort` yet is the legitimate
"start unsorted" state).

**Opt-in pagination (#221).** Pass `pageSize` and the table paginates its
POST-SORT rows via `usePagination` and renders a `<Pagination>` footer:
```tsx
<DataTable columns={columns} rows={teams} getRowKey={(t) => t.id} pageSize={25} />
```
Sorting reorders the full list first, then the current page is sliced; a sort
change (or any new `rows` identity — a filter/search) resets to page 1. Omit
`pageSize` and every existing consumer renders the same table with all rows and no
footer. `paginationLabel` overrides the pager's `<nav aria-label>`.

**Stability requirement.** When `pageSize` is set, the page holds only while BOTH
`rows` and `columns` are stable references — the table's post-sort rows identity
(which the pager keys off) depends on `columns`, so an inline `columns` array
(fresh each render) snaps the pager back to page 1 on any re-render. Use a
module-level or `useMemo`'d `columns` (as TeamsList / TeamDetail / Leaderboard do).

---

## Pagination (`Pagination`, `paginationRange`, `usePagination`)

One reusable, accessible pager used everywhere the app renders a large
collection — no view hand-rolls prev/next, page math, or slicing.

### `paginationRange({page, pageCount, siblingCount = 1, boundaryCount = 1})`
Pure function returning the visible tokens `(number | 'ellipsis')[]`.
`boundaryCount` pages pinned at each end, `siblingCount` on each side of `page`,
an `'ellipsis'` for every gap wider than one page — and the hidden page's number
when a gap hides exactly one (never `… 4 …`). `page` is clamped; `pageCount <= 1`
→ `[1]`. Tested independently of the markup.
```ts
paginationRange({page: 7, pageCount: 20, siblingCount: 2})
// → [1, 'ellipsis', 5, 6, 7, 8, 9, 'ellipsis', 20]
```

### `<Pagination>`
Presentational, owns no state. Props: `page`, `pageCount`, `onPageChange`,
`siblingCount?`, `boundaryCount?`, `disabled?`, `showFirstLast?` (default true),
`ariaLabel?`. Renders First / Previous / numbered+ellipsis / Next / Last;
First+Previous disabled on page 1, Next+Last on the last page; `aria-current="page"`
on the active number; `<nav aria-label>`; ellipses are inert `<span>`s. Renders
nothing when `pageCount <= 1`.

### `usePagination(items, pageSize)`
Client-side page state for an already-fetched list — the single home for the
epic's page-state hygiene: it **clamps** `page` into range when `items` shrinks
(the `safePage` lesson) and **resets to page 1** when the `items` REFERENCE
changes (a new array from a filter/sort/search). Returns
`{page, setPage, pageCount, pageItems}`. Pass a STABLE reference (memoize derived
lists with `useMemo`) so an unrelated re-render doesn't reset the page. Non-table
card/gallery lists use this hook + `<Pagination>`; every `DataTable` consumer gets
it for free via `pageSize`.

---

## Modals (`Modal`, `FormModal`, `useModalState`)

One shared dialog pattern. **Target state for epic #236:** every admin
create/edit form becomes a `FormModal` opened from an explicit affordance — a
primary "＋ New …" button in the screen header (`aria-haspopup="dialog"`) for
create, a per-row "Edit" action for edit — so no screen hand-rolls a dialog, a
footer, or a close-guard.

**Adoption — epic #236 is complete; every admin form is on `FormModal`.**
#237 landed the foundation. `AdminGitProviders` is the motivating consumer
(#238) — its add/edit form opens from the header's "＋ Add git provider" button
or a row's "Edit". `AdminUsers` (#239) is create-only, opened from "＋ New user",
with per-row role / deactivate / reset-password left inline as single actions.
`AdminSubscriptions` (#240) is create-only from "＋ Assign subscription", the
per-row "End" left inline. `AdminTeams` (#241) is the one screen with both modes:
a create modal plus a per-row Edit modal — team `name` is the key, so it is
create-only within the form and read-only when editing. `AdminIdentities` (#242)
opens the editor from a per-row "Edit"; its `pending` is `save.isPending ||
move.isPending`, because the dialog drives TWO writes and a dismiss must be inert
for both. `AdminReconciliation` (#243) proves the wrapper is not create/edit-only
— it triggers a job with `submitLabel="Run"`, and the page (not the dialog) owns
the run summary so the result outlives the modal; its per-row resolve stays inline.

`RepoScopeModal` is also a `FormModal` (`submitLabel="Save scope"`). It was the
donor of the close-guard, and for one epic it kept a private copy of it — which
is exactly the drift this component exists to prevent. There is now **no**
raw-`<Modal>` consumer in product code outside `FormModal` itself: if you reach
for `<Modal>` directly, you are almost certainly re-implementing a footer and a
guard that already exist.

A create-only screen (`AdminUsers`, `AdminSubscriptions`) needs no `key` on the
`FormModal`: with no edit mode there is no row to switch between, and the
open-gated render already remounts clean fields on every reopen. Side effects that
must OUTLIVE the dialog (the users temp-password reveal) belong to the page's
state, not the modal's — hand them up in `onSuccess` before closing.

"Create-only" is about the FORM, not the write: `AdminSubscriptions` assigns *and
changes* a subscription through one dialog, because a change IS an assign (the
backend revokes the old seat and opens a new one). A screen only needs edit mode
when a row's existing values must pre-fill the fields.

A screen whose options come from a second query (the developer list on
`AdminUsers` / `AdminSubscriptions`, the team list on `AdminIdentities`) loads
them when the DIALOG opens, not with the page. Gate that control with
`optionsGate(query, labels)` from `pages/admin/adminUi` — **not** a hand-rolled
`isPending` check. Gating on `isPending` alone covers only half of it: a FAILED
query settles to `isPending === false` with no data, so the select would flip
from a disabled "Loading…" to an enabled list holding nothing but its
placeholder, which reads as "there are none" rather than "this never loaded".
Both non-ready states must keep the control inert and say which one it is.

The screen's primary affordance goes in `PageHeader`'s optional `actions` slot,
as a `PrimaryButton` with `ariaHasPopup="dialog"`.

### `<Modal>`
The accessible primitive: portal-rendered, focus moved in on open and restored
to the opener on close, Tab trapped behind `aria-modal`, Escape closing the
topmost dialog only, ref-counted body scroll-lock, and a backdrop click that
closes only when press AND release both land on the backdrop (a drag that
crosses the dialog edge never discards unsaved state). Props: `title`,
`onClose`, `children`, `testId?`. The caller owns open state — render it only
while open. Use it directly only for a non-form dialog; forms use `FormModal`.

### `<FormModal>`
`Modal` + the footer every admin form repeats: primary Save, Cancel, inline
`ErrorText`.
```tsx
// The mutation hook is called INSIDE this component, not on the page — see below.
{modal.mode !== 'closed' ? (
  <FormModal
    key={modal.editing?.id ?? 'new'}      // remount clean between rows
    title={modal.mode === 'edit' ? 'Edit provider' : 'Add git provider'}
    onClose={modal.close}
    onSubmit={save}
    submitLabel={modal.mode === 'edit' ? 'Save changes' : 'Add provider'}
    pendingLabel="Saving…"
    pending={mutation.isPending}
    submitDisabled={!container}
    error={mutation.isError ? mutation.error : null}
    testId="git-provider-modal"
  >
    {/* fields only — the footer is the modal's */}
  </FormModal>
) : null}
```
| Prop | Type | Notes |
|------|------|-------|
| `title` | `string` | Dialog header + accessible name |
| `onClose` | `() => void` | Called only when no write is in flight |
| `onSubmit` | `() => void` | Called only when Save is actually enabled |
| `submitLabel?` | `string` | Save's label (default `'Save'`) |
| `pendingLabel?` | `string` | Save's label while `pending` (default `'Saving…'`) |
| `pending?` | `boolean` | Write in flight: disables Save, inhibits every close |
| `submitDisabled?` | `boolean` | Caller's validation gate on Save |
| `error?` | `Error \| null` | Rendered inline via `ErrorText` |
| `testId?` | `string` | Also ids the backdrop as `${testId}-backdrop` |

**Own the mutation inside the modal component**, as every screen does: call
`useCreateX()` / `useUpdateX()` in the body that `FormModal` wraps, so closing
the dialog unmounts it and its error/pending state dies with it. That is why no
consumer needs a `mutation.reset()` on close. Hoisting the mutation to the page
is the mistake this note exists to prevent: its last failed error would then
outlive the dialog and render on the next clean open.

**The close guard is the point.** While `pending`, Cancel / Esc / × / backdrop
are all inert (the `RepoScopeModal.requestClose` lesson) — a dismiss mid-write
can't let the mutation land, or fail, invisibly. Don't re-implement it in a
screen. `pending` must cover EVERY write the dialog can start, not just the
primary one (see `AdminIdentities`: `save.isPending || move.isPending`), and
`submitDisabled` is validation ONLY — never mix the in-flight state into it, as
`FormModal` already folds `pending` into Save's disabled state.

### `useModalState<T>()`
Open / which-row / reset state for a create-or-edit `FormModal`. Returns
`{mode: 'closed' | 'create' | 'edit', editing: T | null, openCreate(), openEdit(row), close()}`.
`mode` and `editing` live in one state object, so they can never disagree — a
`'create'` never carries the last edited row. Render the modal while
`mode !== 'closed'`, and remount its body on `key={editing?.id ?? 'new'}` so
fields reset between different rows. Callbacks are stable across renders.
