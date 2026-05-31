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
```
