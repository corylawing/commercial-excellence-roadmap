# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

This repo contains a single file: `index.html` (~2,940 lines). It is a self-contained
static web app — all HTML, CSS, and JavaScript live in that one file. There is no
build step, package manager, framework, bundler, test runner, or linter. Edits go
straight into `index.html`.

Commits historically use the message `Update index.html` — keep changes scoped so
that pattern stays meaningful, or write a more descriptive message when a change
spans multiple concerns.

## Running locally

Open `index.html` directly in a browser, or serve it from any static server, e.g.
`python3 -m http.server` from the repo root. There are no commands to "build",
"lint", or "test" — verify changes by loading the page and exercising the UI.

## Backend (Google Apps Script)

Data persistence is delegated to a Google Apps Script Web App. The URL is hardcoded
in `index.html` at the `APPS_SCRIPT_URL` constant (search for it — currently around
line 1276, in a banner-commented block at the top of the `<script>`). If
`APPS_SCRIPT_URL` is unset or doesn't start with `https://`, the page renders a
"Backend not connected" setup banner and falls back to the localStorage cache.

The Apps Script endpoint speaks a tiny JSON protocol over GET/POST:

- `GET ?action=read` → `{ ok, initiatives, snapshots }`
- `POST` body `{ action: 'upsert', item }` → returns updated `initiatives`
- `POST` body `{ action: 'delete', id }` → returns updated `initiatives`
- `POST` body `{ action: 'addNote', id, author, text }` → returns the new `note`
- `POST` body `{ action: 'snapshot', name }` → returns updated `snapshots`
- `POST` body `{ action: 'deleteSnapshot', id }` → returns updated `snapshots`
- `POST` body `{ action: 'reset' }` → restores seed data

POSTs use `Content-Type: text/plain;charset=utf-8` deliberately, to dodge the CORS
preflight that Apps Script can't answer. `apiPost()` (around line 1409) defensively
re-reads after fetch/JSON failures because Apps Script can return HTML error pages
or redirects on partial success. Don't "simplify" away the `_maybe` re-read path —
it covers the case where a write succeeded but the response was unreadable.

Note: `index.html` references a `SETUP.md` (in the setup banner and a code comment),
but that file does not currently exist in the repo. If you need to explain backend
setup to a user, either add `SETUP.md` or update the references.

## Domain model

Initiatives are the core entity. Each has roughly this shape:

```
{ id: 'i_…', code, title, ws, status, owner, effort, startQ, endQ, target,
  desc, value, h, notes: [{ ts, author, text }, …], updatedAt }
```

Domain constants are declared near the top of the `<script>` (look for
`WORKSTREAMS`, `HORIZONS`, `STATUSES`, `STATUS_STYLES`):

- **Workstreams** (`ws`): `sales`, `marketing`, `finance`, `service`, `optimization`.
- **Horizons** (`h`, used by the Board view): `now` (0–3 mo), `next` (3–9 mo), `later` (9+ mo).
- **Statuses**: `complete`, `on_track`, `at_risk`, `blocked`, `not_started`, `killed`.
- **Quarters**: integers `1`–`8`. `1–4` = Q1–Q4 2026; `5–8` = Q1–Q4 2027. `startQ` and
  `endQ` define an inclusive range. `quarterLabel(q)` and `quarterRangeLabel(s,e)`
  convert to display strings. `touchesQuarter(i, q)` checks overlap.

`killed` items are filtered out of KPIs, workload, timeline, board, and quarter
strip unless the user has explicitly enabled the `killed` status filter. Don't
treat killed as just-another-status when adding views.

Sort order is intentionally different between the Timeline (`STATUS_PRIORITY_TIMELINE`
+ `compareTimeline`, sorted by start quarter then status) and the Board
(`STATUS_PRIORITY_BOARD` + `compareBoard`, sorted with blockers first). Reuse the
existing comparators when adding new lists.

## Architecture: state → filter → render

There is no framework. Rendering is a one-way pipeline driven by a global `state`
object (around line 1349):

- `INITIATIVES` and `SNAPSHOTS` are module-level arrays holding the server's data.
- `state` holds UI state: `wsFilter`, `statusFilter`, `ownerFilter`, `quarterFilter`
  (all `Set`s), `search`, `timelineYears` (`'2026' | '2027' | 'both'`), and
  drawer-mode flags (`editMode`, `currentId`, `isNew`).
- `matches(i)` is the single source of truth for "does this initiative pass the
  current filters?" Every section calls it. If you add a new filter dimension,
  thread it through `matches`, `anyFiltersActive`, `renderFilters`, and the filter
  badge logic — don't fork the predicate.
- `renderAll()` (around line 2226) calls each section renderer in order:
  `renderKpis`, `renderQuarterStrip`, `renderShipped`, `renderTimeline`,
  `renderWorkload`, `renderFilters`, `renderBoard`, `renderSnapshots`. After any
  data or filter change, call `renderAll()` (or the specific renderer if you know
  it's the only one affected, as `search` does).
- The **Owner workload** chart and **Quarter strip** intentionally ignore one of
  the filter dimensions (owner and quarter respectively) so the visualization
  doesn't collapse to a single bar/cell. See `renderWorkload` and
  `renderQuarterStrip` for the pattern — preserve it.

Event wiring uses delegation set up once at init: `setupFilterDelegation`,
`setupQuarterStripDelegation`, `setupTimelineHeaderDelegation`,
`setupOwnerComboboxDelegation`, `setupDrawerSwipe`. Add new interactive lists by
delegating from a stable parent rather than per-element listeners.

## Drawer (view/edit) and the new-initiative flow

The right-side drawer is one DOM element with two bodies: `#drawer-view` (read-only)
and `#drawer-edit` (form). `openDrawer(id)` fills the view body; `openNewDrawer()`
opens straight into edit mode with `state.isNew = true`. `saveInitiative()` upserts
through `apiPost` and then re-locates the saved item by `(title, ws)` for new items
or by `id` for edits, because the server assigns ids.

## Offline & resilience

- `loadCache()` / `saveCache()` mirror `INITIATIVES` and `SNAPSHOTS` to
  `localStorage['roadmap.cache.v1']`. On API failure the page falls back to the
  cache and flips the connection pill to "Offline".
- **Pending notes**: `addNote()` is optimistic. It appends a `_pending: true` note
  to the in-memory initiative, renders immediately, and queues the note to
  `localStorage['roadmap.pendingNotes.v1']`. On next page load, `replayPendingNotes()`
  retries each queued note. Don't introduce in-memory-only "draft" notes that bypass
  this queue, or a tab reload mid-save will lose them.
- Author name for notes is remembered in `localStorage['roadmap.author.v1']`.

## Conventions worth preserving

- The 5-workstream / 6-status / Now-Next-Later / 2026–2027 quarter structure is
  baked into the UI copy, color tokens (`--ws-*`), and KPI tiles. Changing these
  enums requires touching constants, CSS variables, the quarter math, and KPI
  layout in concert — don't extend halfway.
- CSS is hand-written with a small design-token palette declared in `:root`
  (`--bg`, `--text`, `--ws-*`, `--shadow-*`, `--r*`). Reuse the tokens instead of
  introducing one-off colors.
- The page is intentionally print-friendly (`@media print` rules near the end of
  the `<style>` block hide chrome and let the timeline/board flow). Test print
  preview when you change layout-affecting CSS.
- Mobile breakpoint is `<= 640px`; the timeline swaps to a vertical layout
  (`renderTimelineMobile`) and the board collapses headers. Mobile drawer is
  bottom-sheet with swipe-to-dismiss (`setupDrawerSwipe`).
- Keyboard: `Esc` closes drawer/diff; `⌘K` / `Ctrl+K` focuses search. Preserve
  these shortcuts when refactoring the global keydown handler near the bottom of
  the script.
