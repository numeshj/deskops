# Desk Ops

Work capture and history for the order desk. Replaces the twelve-sheet
spreadsheet described in `Yashoda-Workbook-Analysis.md`.

**Stack:** Node 20+ / Express (API) · React 18 + Vite (web) · MySQL 8 or MariaDB 10.5+

---

## Running it — Windows, nothing installed, no Docker

Double-click **`run-local.bat`**. Then http://localhost:4000.

It downloads portable Node and portable MariaDB into a `runtime\` folder beside
it, loads the workbook history, and starts the app. Nothing is installed, no
admin rights are needed, and no hardware virtualisation is required — which
matters, because Docker Desktop needs virtualisation and a managed work laptop
usually has it locked off in the BIOS.

`stop-local.bat` stops it. `check-local.bat` writes a diagnostics file worth
sending when something breaks. `reset-data.bat` erases the database and reloads
only `migrated\`, which is how you get testing's leftovers back out. Details in
**RUN-WITHOUT-DOCKER.md**.

## Running it — with Docker, if virtualisation is available

```bash
docker compose up --build                      # http://localhost:4000
docker compose --profile tools run --rm seed   # users + the workbook data
```

No MySQL install, no Node install. Full deployment notes, including free
hosting, are in **DEPLOYING.md**.

---

## Running it — natively

### 1. Database

```bash
mysql -u root -p -e "
CREATE DATABASE deskops CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'deskops'@'localhost' IDENTIFIED BY 'deskops';
GRANT ALL PRIVILEGES ON deskops.* TO 'deskops'@'localhost';"

mysql -u deskops -p deskops < db/001_schema.sql
```

### 2. API

```bash
cd server
cp .env.example .env          # set DB_PASSWORD and JWT_SECRET
npm install
npm run seed:users            # creates the two dev accounts
npm run import ../../migrated # loads the migrated workbook CSVs
npm run dev                   # http://localhost:4000
```

### 3. Web

```bash
cd web
npm install
npm run dev                   # http://localhost:5173
```

Vite proxies `/api` to port 4000, so there is nothing else to configure.

**Dev accounts** — change before this leaves your network.

| Role  | Email                 | Password   |
|-------|-----------------------|------------|
| user  | yashoda@example.com   | `desk1234` |
| admin | admin@example.com     | `admin1234`|

---

## Loading the historical data

`migrate_workbook.py` (shipped with the spec) converts the workbook into CSVs;
`npm run import` loads them. The import is **idempotent** — ids are a sha1 of
each row's source identity, so re-running updates rather than duplicating.

After importing, the counts must match `migrated/reconciliation.txt` exactly:

```
store            579     activity        3,633     stock_oos    4,134
store_contact    286     order_ref       2,072     reason          42
product          289     campaign_line      53     clusters       668
```

`clusters` reads 668, not the 672 rows in `unmapped_reasons.csv`: four pairs of
phrases normalise to the same text and correctly merge. The import prints both
numbers when they differ.

Activities break down as 1,523 calls · 954 orders · 608 delivery issues ·
270 2p · 169 stands · 71 replacements · 25 credits · 13 requests.

**Store coverage will read 51.3% after import.** That is not a bug — it is the
compact-layout gap from the source spreadsheet showing through. It should climb
towards 100% for records created in the app, and it is worth tracking as a
launch metric.

---

## Two decisions not to undo

**`order_ref.number` is a string.** It holds both the legacy 7-digit numbers
(`1853706`) and the current 8-digit ones (`11043984`). Making it an integer
breaks the June 2026 platform cut-over and silently eats leading zeros.

**`activity.detail` is JSON, and there are no per-type subtype tables.** A new
work type must not require a migration. The whole "handle work we didn't think
of" design (spec section 6) depends on this single choice.

---

## How the capture screen is meant to behave

The benchmark is a spreadsheet row: type, tab, tab, Enter. Anything slower gets
abandoned. So:

- A normal record is **three interactions** — store, chip, Enter.
- Defaults are applied **server-side** (status `done`, no follow-up, `occurred_at`
  = now), so no client has to choose them and no date is ever hand-typed.
- The store stays **held for 60 seconds** after a save, because one phone call
  often produces two or three records.
- **Other** is on every work type and always saves a valid record. It is not an
  error state.
- A record saved **without a store becomes a draft**, not a failure. That is how
  the missing store codes finally get captured — by asking when she has ten free
  seconds, never mid-call.

Keyboard: `/` focus store · `1`–`9` work type · `Enter` save · `Esc` clear ·
`Alt`+`S` same again.

`activity.capture_seconds` is recorded on every save. Do not let it get cut as
scope — it is how the project proves it worked.

---

## Unlisted work

When she saves an "Other" record the free text is folded into a cluster. MySQL
has no `pg_trgm`, so matching is done in `server/src/lib/domain.js` with token
overlap at a 0.6 threshold — enough to put "pringle labels missing" and
"Pringles label chase" together.

At three occurrences a cluster is offered for promotion to a real chip.
Promotion **adds** a `reason_id` and never overwrites `reason_freetext`, so if a
promotion turns out to be wrong nothing has been lost.

The import seeds 672 clusters from the free text the migration could not map.
The top entries are real recurring jobs with no chip yet — "to request the
picture of zyn" (8×), "did not answer the phone" (7×), "to ask about zyn
scanning price" (6×).

**Watch the Other rate on the capture screen.** Under 5% is healthy. Over 10%
means the vocabulary has drifted from the work and something new is happening.

---

## Layout

```
db/001_schema.sql            16 tables
db/002_phase2.sql            attachment bytes + two indexes
db/002_tidb_compat.sql       optional, TiDB only — never runs automatically
server/
  src/index.js               express app, auth, error handling
  src/db/pool.js             mysql2 pool (dateStrings: true — see the comment)
  src/db/seedUsers.js        T5
  src/import.js              T2, idempotent CSV loader
  src/lib/auth.js            JWT, bcrypt, cookie + bearer
  src/lib/domain.js          FS normalisation, order generations, clustering
  src/routes/activities.js   save, today, drafts, open, resolve, paste parsing
  src/routes/stores.js       picker search, store view, contacts
  src/routes/orders.js       lookup, order timeline
  src/routes/vocab.js        work types, chips, unlisted work, reason admin
  src/routes/stock.js        daily stock check (spec 4.4)
  src/routes/requests.js     line items + the four-stage workflow (spec 4.7)
  src/routes/campaigns.js    allocations, the grid, call round (spec 4.8)
  src/routes/products.js     product lookup, shared by all three
  src/routes/attachments.js  photos, stored as bytes in the database
  src/routes/dashboard.js    day/week/month, done and pending (spec 8)
  src/routes/impact.js       the contribution case, with open assumptions
web/
  src/components/CaptureBar.jsx    T7–T14 — the screen the project stands on
  src/components/StorePicker.jsx   T6
  src/components/ActivityRow.jsx
  src/pages/Capture.jsx            T15 + unlisted panel
  src/pages/OpenItems.jsx          T17
  src/pages/Drafts.jsx             T16
  src/pages/StoreView.jsx          T18
  src/pages/OrderView.jsx          T19
  src/pages/Stock.jsx              daily stock check
  src/pages/Requests.jsx           requests + line items
  src/pages/Campaigns.jsx          allocation list
  src/pages/CampaignView.jsx       the grid and the call round
  src/components/ProductPicker.jsx same stale-list guard as StorePicker
  src/components/Photos.jsx        upload and view attachments
  src/components/Charts.jsx        chart primitives, one set of mark rules
  src/pages/Dashboard.jsx          day / week / month
  src/pages/Impact.jsx             the page she shows her company
  src/lib/queue.js                 offline capture queue — free hosting insurance
  src/styles.css                   design tokens, light + dark
```

---

## Phase 3 status

Done: the Day / Week / Month dashboard and the impact page.

Every dashboard tab answers the same two questions in the same order — what got
done, and what is still waiting. The pending half is deliberately "as of now"
rather than scoped to the period: a backlog is a present-tense fact, and
"items that were open during week 34" is not a number anyone can act on.

**The impact page has no full-time-equivalent figure, on purpose.** The obvious
calculation — hours over calendar weeks over a working week — lands near 0.13
against this data. That is not what Yashoda works; it is what the old
spreadsheet happened to record, on 302 days out of roughly 600. Putting it at
the top of a page she shows her employer would lose the argument in ten
seconds. The page leads with counts instead, labels hours as a floor, and
states the coverage gap in its own section — because "the record undercounts
her, and here is by how much" is the stronger argument and the true one.

Charts follow one set of rules: the categorical hues are the app's own
`--s1..--s5`, validated for colourblind separation and contrast in both light
and dark; bars cap at 24px with a 4px rounded data-end; marks are separated by
a 2px surface gap, never a stroke; axis ticks always divide whole; and every
figure has a table view, which is the relief the contrast check obliges for the
lighter series colours.

---

## Phase 2 status

Done: the daily stock check (sparse `stock_oos`, yesterday pre-ticked, days-out
per SKU), customer requests with returned/requested line items and the
logged → items received → order placed → restocked workflow, photo attachments
on any record, and allocation campaigns with the store x SKU grid, Booker and
invoice flags, and call-round mode.

Three decisions worth keeping:

**The request workflow stage lives in `activity.detail.stage`, not in
`activity.status`.** Status is a fixed enum shared by every work type; putting a
stage in it makes every process change a schema migration. Adding a fifth stage
is now a deploy.

**Photo bytes are in the database, not on disk.** Free hosting wipes the
filesystem on every redeploy and spin-down, so a photo written to disk would be
gone within the week — and this feature exists precisely because the workbook's
"Pictures" column never held anything.

**A campaign line's id is a hash of campaign + store + SKU.** Adding the same
store and SKU twice updates the row instead of silently creating a second one
that double-counts the units.

Not started: the work type builder (spec 6.5) and projects (6.6). Both belong
with Phase 4, once the Unlisted panel shows whether they are needed.

---

## Phase 1 status

Done: T1 schema · T2 import · T5 users · T6 store picker · T7 type chips ·
T8 reason chips and Other · T9 contextual fields · T10 defaults · T11 sticky
store and Same again · T12 paste detection · T13 keyboard · T14 capture timing ·
T15 today's log · T16 drafts · T17 open items · T18 store view · T19 order view.

T20 reason admin: API is complete (`/api/vocab/reasons`, merge, retire); the
admin screen is not built yet.

T3 and T4 are data review tasks, not code — work through
`migrated/flagged_dates.csv` (20 rows) and the 275 single-mention stores before
go-live.

**Deployment — £0, no card.** Dockerfile, `docker-compose.yml`, a Render
blueprint and a GitHub Actions workflow are included. The app runs as a single
container: Express serves the built React app from its own process, so a free
deploy needs one web service, not two, and there is no CORS to configure.

Free hosting sleeps, so **a save never waits for the network** — if the request
cannot reach the server it is written to the browser and retried until it
lands, surviving reloads and browser restarts. The worst a cold start can do is
delay a record by a minute; it can never lose one. See `web/src/lib/queue.js`
and `DEPLOYING.md`.

## Tests

```
node --test tests/api.test.mjs      # 75 - Phase 1: auth, capture, drafts,
                                    #      open items, clustering, orders, admin
node --test tests/phase2.test.mjs   # 55 - stock, requests, photos, allocations
node --test tests/phase3.test.mjs   # 29 - dashboard arithmetic, impact honesty
cd tests && npx playwright test     # 54 - all three phases, in a real browser
```

289 tests against a database loaded from the real workbook, because a suite that
only sees rows it made itself never meets the shapes the spreadsheet produces.
The Phase 3 suite checks arithmetic against the database rather than trusting
the endpoint: the work-type mix has to add up to the headline total, the
open-item buckets to their total, and hours to the sum of count x minutes. The
hardening suite adds validation, role-based access and auth integrity — full
account in **FULL-TEST-REPORT.md**.

On Windows, `test-local.bat` runs all four API suites — 218 tests — against your
own instance. It adds a few hundred records dated today and deletes nothing, so
run `reset-data.bat` afterwards if you want her history back on its own.

---

**Not started, and deliberately so:** the dashboards. They show empty charts
until the capture screen is in daily use, and building them first tempts you to
design capture around what the charts need rather than around what she can do in
five seconds while holding a phone.
