/**
 * T5 — two accounts, nothing elaborate.
 *   node src/db/seedUsers.js
 *
 * Two behaviours, deliberately different.
 *
 * On a development machine it creates yashoda@example.com / desk1234 and
 * admin@example.com / admin1234 and prints them, because a local run should
 * cost nobody a password reset.
 *
 * With NODE_ENV=production it REFUSES to do that. The deployed app answers on
 * a public URL that anyone who finds it can try, and the whole of the order
 * desk's history — every store, every contact, every phone number — sits
 * behind that login. A four-word password that is written in a README and in
 * a git history is not a login, it is a formality. So in production the
 * passwords must be supplied, and the defaults are rejected even if someone
 * passes them in on purpose.
 *
 * Supplied passwords are never printed. They came from the environment; the
 * person who set them already knows them, and echoing them into a build log
 * that free hosts keep for weeks would undo the point of asking.
 */
import { pool, query } from "./pool.js";
import { hashPassword } from "../lib/auth.js";
import { rid } from "../lib/domain.js";

const DEV_PASSWORDS = { user: "desk1234", admin: "admin1234" };
const MIN_LENGTH = 12;

const isProduction = process.env.NODE_ENV === "production";

const USERS = [
  {
    role: "user",
    name: "Yashoda",
    email: process.env.SEED_USER_EMAIL || "yashoda@example.com",
    password: process.env.SEED_USER_PASSWORD || null,
  },
  {
    role: "admin",
    name: "Supervisor",
    email: process.env.SEED_ADMIN_EMAIL || "admin@example.com",
    password: process.env.SEED_ADMIN_PASSWORD || null,
  },
];

const ENV_VAR = { user: "SEED_USER_PASSWORD", admin: "SEED_ADMIN_PASSWORD" };

function stop(lines) {
  console.error("");
  console.error("  Refusing to create these accounts.");
  console.error("");
  for (const l of lines) console.error(`  ${l}`);
  console.error("");
  process.exit(1);
}

/** Everything that would be wrong, not just the first thing. */
function check(users) {
  const problems = [];
  for (const u of users) {
    const name = ENV_VAR[u.role];
    if (!u.password) {
      problems.push(`${name} is not set. This is production, so there is no default.`);
      continue;
    }
    if (u.password === DEV_PASSWORDS[u.role]) {
      problems.push(`${name} is still the development password. Pick a real one.`);
      continue;
    }
    if (u.password.length < MIN_LENGTH) {
      problems.push(`${name} is ${u.password.length} characters. ${MIN_LENGTH} is the minimum.`);
    }
  }
  // Two accounts sharing a password means the admin/user split buys nothing.
  if (users[0].password && users[0].password === users[1].password) {
    problems.push("Both accounts have the same password, which makes the admin split pointless.");
  }
  return problems;
}

const main = async () => {
  if (isProduction) {
    const problems = check(USERS);
    if (problems.length) {
      stop([
        ...problems,
        "",
        "Set them where the app's other settings live - on Render that is the",
        "service's Environment tab - and run this again:",
        "",
        "  SEED_USER_PASSWORD=...      (Yashoda)",
        "  SEED_ADMIN_PASSWORD=...     (the supervisor account)",
        "",
        "Optional, if the example.com addresses will not do:",
        "  SEED_USER_EMAIL=...   SEED_ADMIN_EMAIL=...",
      ]);
    }
  }

  for (const u of USERS) {
    const supplied = Boolean(u.password);
    const password = u.password || DEV_PASSWORDS[u.role];
    const id = rid("user", u.email);
    const hash = await hashPassword(password);
    await query(
      // password_hash is deliberately absent from the UPDATE list: re-running
      // the seeder must never quietly reset a password she has since changed.
      `INSERT INTO app_user (user_id, email, display_name, password_hash, role)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), role = VALUES(role)`,
      [id, u.email, u.name, hash, u.role]
    );
    console.log(`  ${u.role.padEnd(6)} ${u.email}  /  ${supplied ? "(the password you supplied)" : password}`);
  }

  if (!isProduction) console.log("\nChange these before anything leaves your network.");
  await pool.end();
};

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
