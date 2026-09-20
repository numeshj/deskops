import serverless from "serverless-http";
import { app } from "../../server/src/app.js";

/**
 * Netlify has no long-running process, so index.js (which calls app.listen)
 * never runs here — this wraps the same Express app from app.js directly.
 * Photo/PDF attachments are real binary bytes (see server/src/routes/
 * attachments.js), so responses matching these types are base64-encoded for
 * the Lambda-style envelope Netlify expects; everything else passes through
 * as text/JSON exactly as it does under Docker.
 */
export const handler = serverless(app, {
  binary: ["image/*", "application/pdf", "application/octet-stream"],
});
