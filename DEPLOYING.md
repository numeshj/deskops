# Deploying for £0

No card, no trial, no monthly bill. Every service named here has a free tier
that is perpetual, not a 30-day countdown.

The honest part is stated plainly too: free hosting has real costs, they are
just not financial. The app is built so those costs do not reach Yashoda.

---

## Part 1 — Running locally, nothing installed

Docker Desktop and nothing else. No MySQL, no Node.

```bash
docker compose up --build                      # ~2 minutes the first time
docker compose --profile tools run --rm seed   # users + the workbook data
```

Open **http://localhost:4000**. Sign in as `yashoda@example.com` / `desk1234`.

```bash
docker compose down        # stop
docker compose down -v     # stop and wipe the database
```

The database is on host port **3307**, not 3306, so it cannot clash with a
MySQL someone already has installed.

---

## Part 2 — The shape that makes free work

**One container, not two services.** Express serves the built React app from
its own process. One free web service instead of two, no CORS, no second cold
start, no separate frontend deploy to keep in sync.

**The whole system is tiny.** 13 months of her history is **5.3 MB**. Her
volume is roughly 40 records a day. Nothing here is close to any free limit —
this is not a case of squeezing into a free tier, it genuinely fits.

---

## Part 3 — The cold start, and why it does not matter

This is the one thing that could have killed the project, so it is worth being
precise about.

Free hosts are slow to respond after a period of nobody using them — a
container spinning back up after sleeping, or (on Netlify, where this
actually deploys) a serverless function's first invocation in a while. We
designed this entire app around a five-second save. A fifty-second wait
while a store manager waits on the phone would be indefensible.

Three things fix it, in order of importance.

### The offline queue — the real answer

**A save never waits for the network.** If the request fails for any reason
that is not the server rejecting the data — offline, cold start, a 502 from a
waking container — the record is written to the browser and retried until it
lands. She sees *"Saved on this device — will sync"* and carries on typing.

The queue survives a page reload and a browser restart. A sync indicator in
the top bar shows how many records are waiting, and clicking it retries
immediately. Anything the server actively rejects with a 4xx is dropped rather
than retried forever; everything else is held.

This is tested, not theoretical — see `web/src/lib/queue.js`. With the backend
made unreachable mid-session: the record queued, survived a reload, and synced
by itself the moment the backend returned.

The practical effect: **the worst a cold start can do is delay a record by a
minute. It can never lose one, and it never blocks her.**

### Warm-up on page load

The app pings `/api/health` the instant it opens, before the login form is
even filled in. Whatever is cold starts waking while she types her password,
so by her first save it is usually up.

### Keep it warm — free, two minutes to set up

Point [cron-job.org](https://cron-job.org) or UptimeRobot (both free) at:

```
https://<your-site>.netlify.app/api/health
```

Every 10 minutes, weekdays 07:00–19:00 her time. About 72 pings a day, well
inside any free plan. `/api/health` is deliberately cheap — one `SELECT 1` —
and returns `uptime_s` so you can see whether it has restarted.

Do not ping overnight or at weekends. Letting it sleep when nobody is working
is part of what keeps you inside the free allowance.

---

## Part 4 — Where to put it

*Free tiers move fast enough that a section written that morning was wrong
by the afternoon. This was originally written for Render, checked 20
September 2026 against Render's own blog post claiming no card required —
then actually trying to deploy that same day hit a card prompt anyway, on
both the Blueprint flow and a plain Web Service. What follows is what was
actually confirmed working, not what a provider's marketing page claimed.*

### Database — Aiven free MySQL

[Aiven's free plan](https://aiven.io/free-mysql-database) is the one this
deploys against: **1 GB, no card, real MySQL, daily backups.** That last part
is the deciding factor. Once this goes live the spreadsheet gets retired, and
this database becomes the only copy of 20 months of the order desk's history —
every store, every contact, every issue. A free tier with no backup story is
not somewhere to put that.

It is also plain MySQL, not a wire-compatible cousin, so the foreign keys stay
on. The database itself catches a bad reference instead of the app having to
be trusted to — one less class of thing that can go wrong on a system nobody
is watching daily.

1 GB against 5.3 MB of data is a limit you can see coming, unlike a monthly
request-unit meter you can only watch. Running out of disk gets you a warning;
running out of an opaque quota gets you a dead connection mid-month.

The honest costs, stated plainly: 1 GB instead of 5, no SLA, one service per
account, and Aiven powers off free services with no continuing activity. That
last one sounds worse than it is — a desk used every weekday counts as
continuing activity, Aiven warns before deactivating, and the service comes
back on request.

Sign up at aiven.io/free-mysql-database and create a free MySQL service — pick
an EU region if the client is in the UK/EU. Netlify's free-tier functions run
in the US regardless of where you are, so this deploy is already cross-region
by necessity; at 40 records a day the extra latency is not something anyone
will notice. Take the connection details from the service overview page:

```
DB_HOST=<service>-<project>.aivencloud.com
DB_PORT=<given>
DB_USER=avnadmin
DB_PASSWORD=<generated>
DB_NAME=defaultdb        # every Aiven service ships this database regardless
                          # of what you named the service itself
DB_SSL=1
```

**TLS needs Aiven's own CA, not the public trust store.** Aiven signs with a
per-project CA, so a strict client rejects it as "self-signed certificate in
certificate chain" by default. `server/certs/aiven-ca.pem` is committed for
this deployment's project — `pool.js` and `load-remote.ps1` both pick it up
automatically whenever `DB_SSL=1`, verifying the connection properly rather
than disabling verification. `load-remote.bat` fetches this file itself the
first time it talks to an `aivencloud.com` host, if it isn't already there.

### Alternative — TiDB Cloud Starter

[TiDB Cloud Starter](https://docs.pingcap.com/tidbcloud/select-cluster-tier/)
is bigger — 5 GiB storage, 50 million request units a month — but two things
push it to second choice: its free-tier docs don't mention backups anywhere,
and it's only MySQL *wire-compatible*, which meant dropping foreign keys
(`db/002_tidb_compat.sql`, via `MIGRATE_INCLUDE=tidb_compat`) rather than
having the database enforce them. `load-remote.bat` still handles it — it
sets that flag automatically when the host matches `tidbcloud.com`.

```
DB_HOST=gateway01.<region>.prod.aws.tidbcloud.com
DB_PORT=4000
DB_USER=<prefix>.root          # the prefix is part of the username
DB_PASSWORD=<generated>
DB_NAME=deskops
DB_SSL=1
```

**If you hit the monthly quota**, TiDB denies new connections until the month
resets — the order desk down mid-month with nothing to do but wait. At 40
records a day this is unlikely, but it's the failure mode to know.

Avoid `db4free` and similar — unreliable, no backups.

### App — Netlify free tier

*Updated after actually trying to deploy.* This section originally recommended
Render. In practice, as of the date above, **every free container host
checked now demands a card before it will provision anything, $0 or not** —
Render's Blueprint flow, Render's plain Web Service flow, and Northflank's
own docs all confirmed this directly; Fly.io, Railway and Koyeb's card-free
tiers are reportedly gone too. `render.yaml` is left in the repo in case that
ever reverses, but it is not the path this app is actually deployed on.

[Netlify's free tier](https://www.netlify.com/pricing/) is the one that
still works without a card: permanent, and — unlike Vercel's Hobby plan,
which its terms restrict to personal non-commercial use — its terms
explicitly allow this kind of commercial use.

The trade-off is architectural, not financial. Netlify has no long-running
container to keep a port open, so the Express app is wrapped as a single
serverless function instead of listening on one:

- `netlify/functions/api.js` imports the same `app` from `server/src/app.js`
  and wraps it with `serverless-http` — every route, every piece of
  middleware, unchanged.
- `netlify.toml` builds the React app and serves it straight from Netlify's
  CDN, and redirects `/api/*` to the function while everything else falls
  through to `index.html` for client-side routing.
- `server/src/index.js` (the `app.listen` entrypoint) still exists unchanged
  for local dev and `docker compose` — Netlify never runs it.

This was verified end-to-end against the live Aiven database before writing
this — health check, login, the JWT cookie, and an authenticated query all
worked through the function wrapper exactly as they do under Docker.
Attachments (photos/PDFs) already live as blobs in MySQL rather than on
disk, which is what makes this portable to a stateless function at all — a
disk-based upload store would have been a hard blocker here.

To deploy: sign up at netlify.com (no card), **Add new site → Import an
existing project**, connect `github.com/numeshj/deskops`. Netlify reads
`netlify.toml` automatically. Add the environment variables below in
**Site configuration → Environment variables**, then deploy:

```
NODE_ENV=production
SERVE_WEB=0                # Netlify's CDN serves web/dist; the function only handles /api/*
JWT_SECRET=<a long random string — see Part 4b>
DB_HOST=<from Aiven>
DB_PORT=<from Aiven>
DB_USER=avnadmin
DB_PASSWORD=<from Aiven>
DB_NAME=defaultdb
DB_SSL=1
```

There is no `MIGRATE_ON_BOOT` step here — a function has no "boot", so the
schema is applied once, up front, from your machine via `load-remote.bat`
(Part 5), not by the deployed app.

**One real limit to know:** Netlify's synchronous function responses cap
around 6 MB. Attachments are capped at 8 MB in the app (`MAX_BYTES` in
`server/src/routes/attachments.js`), so a large photo or PDF near that
ceiling could fail on Netlify where it would have succeeded on Render. Worth
lowering that cap if it ever bites, but 40 records a day of mostly phone
photos is unlikely to hit it soon.

### CI — GitHub Actions

`.github/workflows/ci.yml` runs on every push: installs both packages, builds
the web app, applies the schema against a real MariaDB service container, then
boots the app and checks health, login, an authenticated call and the SPA.
About one minute per push against a free account's 2,000 monthly minutes.

---

## Part 4b — The passwords, before anything else

This is the one step that is not optional.

On localhost, `desk1234` and `admin1234` are a convenience. On a public URL
they are an open door, and behind that door is every store, every contact
name and every phone number the wholesaler has. The URL does not need to be
advertised for this to matter; it needs only to be guessable or logged.

So `seedUsers.js` behaves differently under `NODE_ENV=production`. It refuses
to create an account unless a password is supplied, refuses the two
development passwords even if you pass them deliberately, refuses anything
under twelve characters, and refuses to give both accounts the same one. It
also never prints a supplied password — build logs on free hosts are kept for
weeks.

```
SEED_USER_PASSWORD=...     # Yashoda
SEED_ADMIN_PASSWORD=...    # the supervisor account
SEED_USER_EMAIL=...        # optional, if example.com will not do
SEED_ADMIN_EMAIL=...
```

`load-remote.bat` asks for both, twice each, without echoing them.

---

## Part 5 — Loading her history

Free hosts give you no shell, so the import cannot run on the server. It runs
from the machine that already holds the CSVs, straight into the hosted
database.

On Windows, double-click **`load-remote.bat`**. It asks for the connection
details, fetches and pins Aiven's CA certificate on first use, tests the
connection before changing anything, creates the database if it is not there,
applies the schema (adding the TiDB step only when the host is TiDB), asks for
the two account passwords without echoing them, and loads the workbook. It
uses the portable Node in `runtime\`, so nothing needs installing, and it
writes no passwords to disk.

Or by hand, if you have Node — on Aiven:

```bash
cd server
DB_HOST=<host> DB_PORT=<port> DB_USER=avnadmin DB_PASSWORD=<pw> \
DB_NAME=defaultdb DB_SSL=1 DB_POOL=3 NODE_ENV=production \
SEED_USER_PASSWORD=<pw> SEED_ADMIN_PASSWORD=<pw> \
  node src/db/migrate.js && node src/db/seedUsers.js && node src/import.js ../migrated
```

On TiDB, add `MIGRATE_INCLUDE=tidb_compat` and use `DB_NAME=deskops`.

13,000 rows over the internet — a couple of minutes. The import is idempotent:
ids are a hash of each row's source identity, so running it twice updates
rather than duplicates. If it fails halfway, run it again.

**`migrated/` is gitignored, and should stay that way.** It is 579 named shops,
286 contact names and their phone numbers. A private repository is one settings
change away from not being private, and git keeps a file long after it is
deleted. The deployed app never needs those CSVs — only this one-time load
does, from your machine.

---

## Part 6 — Things that bite on a free tier

**Connection limits.** Free databases cap these hard. `DB_POOL` defaults to
**5** for exactly that reason. Do not raise it. `ER_CON_COUNT_ERROR` means
lower it, not upgrade.

**TLS is not optional.** Without `DB_SSL=1` the connection is refused, usually
with a misleading handshake error.

**Proxies.** Every free host terminates TLS at a proxy. `trust proxy` is set —
without it secure cookies never set and login silently fails in production
while working perfectly on localhost.

**SIGTERM.** Sent on every redeploy and spin-down. The pool closes cleanly on
it, which matters more on a small free database than a big paid one.

**Region.** Put app and database in the same region. Cross-region adds
100–200 ms to every query and a save makes several.

**Migration failure exits in production.** Deliberate — a container running
against a database it could not migrate would corrupt data quietly. It is
better to fail loudly and not start.

---

## Part 7 — Backups

Free tiers do occasionally disappear. Once a week, from any machine:

```bash
docker compose run --rm --entrypoint sh app -c \
  "mariadb-dump -h $DB_HOST -P $DB_PORT -u $DB_USER -p$DB_PASSWORD \
   --ssl --single-transaction --skip-lock-tables $DB_NAME" > backup-$(date +%F).sql
```

A few megabytes. Keep them somewhere that is not the same free account — a
private repo works and is also free.

**Archive the original workbook read-only** rather than deleting it, at least
for the first few months.

---

## Part 8 — Staying free

Nothing here needs to change as the app is used. The two things that would
eventually push past a free tier are more concurrent users (free databases cap
connections) and someone deciding the business cannot tolerate a morning cold
start. Neither applies to one person logging 40 records a day.

If that ever changes, the cheapest step is a paid database while the app stays
on free hosting — the data is what needs reliability; the app process rebuilds
from git in minutes. But that is a decision for a different year, not a
prerequisite for launching.

---

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4000` | Free hosts set this — never hard-code it |
| `NODE_ENV` | — | `production` when deployed |
| `DB_HOST` `DB_PORT` `DB_USER` `DB_PASSWORD` `DB_NAME` | — | From your provider. On Aiven, `DB_NAME` is `defaultdb` |
| `DB_SSL` | off | **`1` on any hosted database** |
| `DB_SSL_CA` | `server/certs/aiven-ca.pem` if present | Path to a pinned CA cert; only needed if Aiven ever rotates its project CA |
| `DB_POOL` | `5` | Leave alone on a free tier |
| `JWT_SECRET` | dev value | **Must change.** Generate one yourself for Netlify — nothing auto-generates it there |
| `SERVE_WEB` | `1` | `0` on Netlify (its CDN serves web/dist) and for local Vite dev |
| `MIGRATE_ON_BOOT` | `1` | Applies the schema at startup. Irrelevant on Netlify — a function has no boot; run `load-remote.bat` instead |
| `MIGRATE_INCLUDE` | — | `tidb_compat` to include the TiDB-only migration |
| `SEED_USER_PASSWORD` | — | **Required in production.** Min 12 chars |
| `SEED_ADMIN_PASSWORD` | — | **Required in production.** Must differ from the above |
| `SEED_USER_EMAIL` `SEED_ADMIN_EMAIL` | `*@example.com` | Optional |
| `WEB_ORIGIN` | — | Only if the web app is deployed separately |

---

## Sources

Checked 20 September 2026. The Render/Northflank/Vercel card findings below
are firsthand — actually hitting the card prompt, and actually reading their
own docs/ToS — not secondhand blog claims, several of which turned out to be
stale or wrong on this exact question the same week.

[TiDB Cloud plans](https://docs.pingcap.com/tidbcloud/select-cluster-tier/) ·
[Aiven free MySQL](https://aiven.io/free-mysql-database) ·
[Netlify pricing](https://www.netlify.com/pricing/) ·
[Netlify commercial-use free-plan discussion](https://answers.netlify.com/t/can-we-use-netlify-free-plan-for-commercial-purposes/41545) ·
[Vercel Hobby plan terms (personal, non-commercial)](https://vercel.com/docs/plans/hobby) ·
[Northflank pricing docs — payment method required on every plan](https://northflank.com/docs/v1/application/billing/pricing-on-northflank)
