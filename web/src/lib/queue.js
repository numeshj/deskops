/**
 * Offline capture queue.
 *
 * This exists because the app is deployed on free hosting, and free hosting
 * sleeps. A cold start can take up to a minute — and the one moment that must
 * never fail is her pressing Enter while a store manager is on the phone.
 *
 * So a save never blocks on the network. If the request fails for any reason
 * that isn't the server rejecting the data (offline, cold start, 502 from a
 * waking container), the record goes into this queue and is retried until it
 * lands. She sees "Saved — syncing", not an error, and carries on.
 *
 * The queue survives a page reload and a browser restart. It is per-device by
 * nature, which is correct: an unsent record belongs to the machine it was
 * typed on.
 */

const KEY = "deskops_queue_v1";
const MAX = 500;

let listeners = new Set();
let flushing = false;
let timer = null;

/* ----------------------------------------------------------------- storage */

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    // private window, blocked storage, or corrupt JSON — an empty queue is the
    // safe answer; we must never throw out of here
    return [];
  }
}

function write(items) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items.slice(-MAX)));
  } catch {
    /* quota or blocked storage — the in-memory attempt still runs */
  }
  notify();
}

function notify() {
  const n = size();
  for (const fn of listeners) {
    try {
      fn(n);
    } catch {
      /* a broken listener must not break the queue */
    }
  }
}

export function size() {
  return read().length;
}

export function subscribe(fn) {
  listeners.add(fn);
  fn(size());
  return () => listeners.delete(fn);
}

/* ------------------------------------------------------------------ enqueue */

export function enqueue(body) {
  const items = read();
  items.push({
    id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    body,
    queued_at: new Date().toISOString(),
    attempts: 0,
  });
  write(items);
  schedule(1500);
}

/* -------------------------------------------------------------------- flush */

/**
 * A 4xx means the server understood and refused — retrying will never help, so
 * the item is dropped rather than looping forever. Anything else is treated as
 * "not yet" and stays queued.
 */
async function send(item, post) {
  try {
    await post("/activities", { ...item.body, queued_at: item.queued_at });
    return "sent";
  } catch (err) {
    const status = err?.status;
    if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      return "rejected";
    }
    return "retry";
  }
}

export async function flush(post) {
  if (flushing) return { sent: 0, left: size() };
  const items = read();
  if (!items.length) return { sent: 0, left: 0 };

  flushing = true;
  let sent = 0;
  const keep = [];

  try {
    for (const item of items) {
      const result = await send(item, post);
      if (result === "sent") {
        sent += 1;
      } else if (result === "rejected") {
        // dropped on purpose — it can never succeed
        console.warn("Queued record rejected by the server, discarding", item.id);
      } else {
        keep.push({ ...item, attempts: item.attempts + 1 });
        // one failure means the server is down or waking; stop and retry later
        // rather than hammering a cold container with the whole queue
        const rest = items.slice(items.indexOf(item) + 1);
        keep.push(...rest);
        break;
      }
    }
  } finally {
    write(keep);
    flushing = false;
  }

  if (keep.length) schedule(backoff(keep[0].attempts));
  return { sent, left: keep.length };
}

/** 5s, 10s, 20s, 40s … capped at 2 minutes. */
function backoff(attempts) {
  return Math.min(120_000, 5_000 * 2 ** Math.min(attempts, 5));
}

let poster = null;

export function schedule(delay = 5000) {
  if (!poster) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    flush(poster);
  }, delay);
}

/**
 * Wire the queue up once, at app start. Retries when the browser comes back
 * online, when the tab is focused again, and on a slow heartbeat.
 */
export function start(post) {
  poster = post;
  const kick = () => flush(poster);

  window.addEventListener("online", kick);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") kick();
  });
  const heartbeat = setInterval(kick, 30_000);

  if (size()) kick();

  return () => {
    window.removeEventListener("online", kick);
    clearInterval(heartbeat);
    clearTimeout(timer);
  };
}
