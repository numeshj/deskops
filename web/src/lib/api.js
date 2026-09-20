const BASE = "/api";

let token = null;
try {
  token = localStorage.getItem("deskops_token");
} catch {
  /* private window — cookie auth still works */
}

export function setToken(value) {
  token = value;
  try {
    if (value) localStorage.setItem("deskops_token", value);
    else localStorage.removeItem("deskops_token");
  } catch {
    /* ignore */
  }
}

async function request(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    credentials: "include",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 401) {
    setToken(null);
    throw Object.assign(new Error("not_authenticated"), { status: 401 });
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw Object.assign(new Error(data?.error || `http_${res.status}`), { status: res.status, data });
  }
  return data;
}

export const api = {
  get: (p) => request("GET", p),
  post: (p, b) => request("POST", p, b),
  patch: (p, b) => request("PATCH", p, b),

  // auth
  login: (email, password) => request("POST", "/auth/login", { email, password }),
  logout: () => request("POST", "/auth/logout"),
  me: () => request("GET", "/auth/me"),

  // vocabulary
  workTypes: () => request("GET", "/vocab/work-types"),
  unlisted: () => request("GET", "/vocab/unlisted"),
  promote: (id, body) => request("POST", `/vocab/unlisted/${id}/promote`, body),
  dismissCluster: (id) => request("POST", `/vocab/unlisted/${id}/dismiss`),

  // stores
  searchStores: (q, limit = 8) =>
    request("GET", `/stores?q=${encodeURIComponent(q || "")}&limit=${limit}`),
  store: (id) => request("GET", `/stores/${id}`),

  // activities
  save: (body) => request("POST", "/activities", body),
  today: () => request("GET", "/activities/today"),
  drafts: () => request("GET", "/activities/drafts"),
  open: () => request("GET", "/activities/open"),
  activity: (id) => request("GET", `/activities/${id}`),
  update: (id, body) => request("PATCH", `/activities/${id}`, body),
  resolve: (id, note) => request("POST", `/activities/${id}/resolve`, { note }),
  parsePaste: (text) => request("POST", "/activities/parse-paste", { text }),

  // orders
  order: (idOrNumber) => request("GET", `/orders/${encodeURIComponent(idOrNumber)}`),
  lookupOrder: (number) => request("GET", `/orders/lookup/${encodeURIComponent(number)}`),

  // products
  products: (q, limit = 12) =>
    request("GET", `/products?q=${encodeURIComponent(q || "")}&limit=${limit}`),

  // daily stock check
  stockToday: (date) => request("GET", `/stock/today${date ? `?date=${date}` : ""}`),
  saveStock: (out, date) => request("POST", "/stock", { out, date }),
  persistentOos: () => request("GET", "/stock/persistent"),

  // customer requests
  requests: (opts = {}) =>
    request("GET", `/requests?${new URLSearchParams(opts).toString()}`),
  requestOne: (id) => request("GET", `/requests/${id}`),
  addLine: (id, body) => request("POST", `/requests/${id}/lines`, body),
  updateLine: (id, lineId, body) => request("PATCH", `/requests/${id}/lines/${lineId}`, body),
  removeLine: (id, lineId) => request("DELETE", `/requests/${id}/lines/${lineId}`),
  setStage: (id, stage) => request("POST", `/requests/${id}/stage`, { stage }),

  // allocation campaigns
  campaigns: () => request("GET", "/campaigns"),
  campaign: (id) => request("GET", `/campaigns/${id}`),
  createCampaign: (body) => request("POST", "/campaigns", body),
  updateCampaign: (id, body) => request("PATCH", `/campaigns/${id}`, body),
  addCampaignLine: (id, body) => request("POST", `/campaigns/${id}/lines`, body),
  updateCampaignLine: (id, lineId, body) =>
    request("PATCH", `/campaigns/${id}/lines/${lineId}`, body),
  removeCampaignLine: (id, lineId) => request("DELETE", `/campaigns/${id}/lines/${lineId}`),
  callRound: (id) => request("GET", `/campaigns/${id}/call-round`),

  // dashboard and impact
  dashboard: (period, date) =>
    request("GET", `/dashboard/${period}${date ? `?date=${date}` : ""}`),
  impact: (minutes) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(minutes || {})) qs.set(`m_${k}`, String(v));
    const q = qs.toString();
    return request("GET", `/impact${q ? `?${q}` : ""}`);
  },

  // photos
  attachments: (activityId) => request("GET", `/activities/${activityId}/attachments`),
  removeAttachment: (id) => request("DELETE", `/attachments/${id}`),

  /**
   * Upload a photo. The body is the file itself with its type in the header —
   * no multipart, so there is no parser dependency on the server.
   */
  async upload(activityId, file, caption) {
    const qs = new URLSearchParams({ name: file.name || "photo" });
    if (caption) qs.set("caption", caption);
    const res = await fetch(`${BASE}/activities/${activityId}/attachments?${qs}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: file,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw Object.assign(new Error(data?.error || `http_${res.status}`), { status: res.status, data });
    return data;
  },
};
