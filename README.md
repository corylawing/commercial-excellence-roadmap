# Revenue Operations · Tracker

A single-file tracker for the Revenue Operations team's initiatives, published with GitHub Pages
from `index.html`. Data lives in a Google Sheet behind a Google Apps Script web app; the page is
the only client.

## Views

- **Overview** — KPI tiles (click one to open that slice in the tracker), the *Needs attention*
  list (blocked, at risk, overdue, past target quarter, or no update in 30 days), quarter load,
  team cards, recent activity and what shipped this year.
- **Tracker** — one row per initiative. Sort any column, group by status / owner / workstream /
  quarter / priority, change status and priority in place, export CSV or JSON.
- **Board** — kanban by status; drag a card to change its status.
- **Timeline** — quarters by workstream, bars filled with progress; snapshots and compare live here.
- **Team** — a profile per person with photo, role and their work. *Who are you?* (top right)
  sets the author for updates and powers the *My work* filter.

## Item fields

`title · workstream · status · priority (P1–P3) · owner · effort · startQ/endQ (1–4 = 2026,
5–8 = 2027) · dueDate · progress (0–100) · nextStep · blocker · checklist · description ·
business value · notes (append-only)`. Status and owner changes post a line into the item's
activity automatically.

## Backend protocol

- `GET ?action=read` → `{ ok, initiatives, snapshots }`
- `POST { action: 'upsert', item }` · `{ action: 'delete', id }` · `{ action: 'addNote', id, author, text }`
  · `{ action: 'snapshot', name }` · `{ action: 'deleteSnapshot', id }`

The Sheet keeps every key an upsert sends, so new fields need no backend change. Team profiles are
stored as rows with `kind: 'profile'` (photo as a small data URL); the page filters them out of
every initiative view. Codes (`SLS-01`…) are assigned by the server from row order and shift when
rows are added or removed — the `id` is the stable key.

## Running locally

Serve the folder (`python3 -m http.server`) and open `index.html`. Opening the file directly works
for layout but the browser blocks the backend call from `file://`.
