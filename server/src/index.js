import { app } from "./app.js";
import { migrate } from "./db/migrate.js";

/**
 * The Docker/Render entrypoint: a long-running process that owns its own
 * port. On Netlify there is no listening process — netlify/functions/api.js
 * imports { app } from ./app.js directly and wraps it with serverless-http,
 * so this file never runs there.
 */

const port = Number(process.env.PORT || 4000);

async function boot() {
  // free hosts give you no shell, so the schema is applied on start
  if (process.env.MIGRATE_ON_BOOT !== "0") {
    try {
      await migrate({ quiet: true });
    } catch (err) {
      console.error("Migration failed:", err.message);
      if (process.env.NODE_ENV === "production") process.exit(1);
    }
  }

  app.listen(port, "0.0.0.0", () => {
    console.log(`Desk Ops listening on :${port}`);
  });
}

boot();
