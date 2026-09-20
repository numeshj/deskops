# Running it without Docker

Docker Desktop needs hardware virtualisation. On a managed work laptop that is
usually turned off in the BIOS and locked there by IT, which is exactly the
error you hit: *"Virtualization support not detected."* It is not a licensing
problem and not something a setting in Windows will fix.

So this route does not use Docker at all. It also does not install anything.

---

## What to do

Double-click **`run-local.bat`**.

That is the whole instruction. The first run downloads about 150 MB and takes
five to ten minutes on a normal office connection. Every run after that takes
about fifteen seconds. When it finishes, your browser opens at
**http://localhost:4000** and you sign in as `yashoda@example.com` /
`desk1234`.

When you are done for the day, double-click **`stop-local.bat`**. Your data
stays exactly as it was.

If the data ever looks wrong — test records mixed in with hers, counts that do
not match the workbook — double-click **`reset-data.bat`**. It asks you to type
`ERASE`, then throws the whole database away and rebuilds it from the CSVs in
`migrated\`. It finishes by printing the row counts so you can see for yourself
what went back in. The line to look at is **`not from the workbook`**: every row
the import writes carries the sheet it came from, and nothing else does, so
straight after a reload that number must read `0`.

If something goes wrong, double-click **`check-local.bat`**. It writes one file,
`runtime\logs\diagnostics.txt`, and opens it in Notepad. Send me that file and I
can see what happened without playing twenty questions. It contains no
passwords and nothing about the business — versions, file sizes, ports and
error lines only.

---

## What it actually does

Everything lands in a single `runtime` folder next to `run-local.bat`:

```
runtime\node\      Node.js       — a zip, extracted. Not installed.
runtime\mariadb\   MariaDB       — a zip, extracted. Not installed.
runtime\data\      the database files
runtime\logs\      app and database logs
```

Nothing is written outside that folder. No Windows service is registered, no
registry key is touched, no PATH is changed, and no administrator prompt
appears. Deleting `runtime\` undoes all of it and costs you nothing but the
download.

The database listens on port **3307**, not the usual 3306, so it cannot collide
with anything already on the machine, and it is bound to `127.0.0.1` so nothing
else on the office network can reach it.

Node's dependencies and the built web app are not downloaded — they ship in
`deskops-offline-deps.zip` and are unpacked on the first run. That is
deliberate: `npm install` reaches out to a package registry, and a package
registry is the single most likely thing for a corporate firewall to block.
This way the only two things that have to come over the network are two files
from `nodejs.org` and `archive.mariadb.org`.

---

## If a download is blocked

The script tells you which URL failed and where to save the file. Open the link
in your browser, save it to the path it names, and run `run-local.bat` again —
it finds the file and carries on. Your browser goes through the company proxy
with your own credentials, so it usually succeeds where a script does not.

---

## Starting the database over

If the database ever gets into a state you cannot explain, it is disposable:
run `stop-local.bat`, delete `runtime\data`, then run `run-local.bat` again. The
schema is recreated and all thirteen months reload from the CSVs in `migrated\`,
which are never touched. That takes under a minute.

---

## This is not the deployment

This is for developing and for showing Yashoda. The live version still goes to
the free hosting described in `DEPLOYING.md` — TiDB Cloud for the database,
Render for the app, no card and no monthly bill. Nothing you do here has to be
redone there: the same schema, the same code, the same import.

The one difference worth knowing is that a free host sleeps after about fifteen
minutes of no traffic and takes up to a minute to wake. That is handled — a
save never waits for the network, it goes into the browser's own queue and syncs
itself — but it is why the local run is the better place to demo from.

---

## Docker, for the record

Docker Desktop is free for a company this size. Cost was never the issue; it
simply cannot run on a machine with virtualisation disabled. If IT ever does
enable it, `docker-compose.yml` and the original `start.bat` still work and are
worth using — but nothing depends on that happening.
