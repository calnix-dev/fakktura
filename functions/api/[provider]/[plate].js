// GET /api/{provider}/{PLATE} – Cloudflare Pages Function.
//
// Some providers block cross-origin requests from browsers, so the page
// asks this function instead. It runs on the same domain as the site, so no
// CORS headers are needed. It is deliberately NOT a generic proxy: it only
// knows a fixed set of upstreams and validates the plate.

const PLATE = /^[A-ZÆØÅ0-9]{2,7}$/;
// Unpaid status can change once the user pays, so keep this short. It only
// exists to absorb repeat searches and refresh-spamming.
const CACHE_SECONDS = 60;

// Smaller operators, checked together in one call (GET /api/others/{PLATE})
// so a search costs one function invocation for all of them. Each returns
// the raw list of unpaid sessions. Ids match LOCAL_PROVIDERS in
// site/providers.js. Giantleap "Pay at home" tenants share one API; the
// base URLs are the ones each tenant's own payment page is configured with.
const GIANTLEAP_TENANTS = {
  "gl-asker": "https://asker-autopark.giantleap.net",
  "gl-baerum": "https://baerum-autopark.giantleap.net",
  "gl-bergen": "https://bergen.autopark.giantleap.net",
  "gl-fredrikstad": "https://fredrikstad.autopark.giantleap.net",
  "gl-hamar": "https://hamar-autopark.giantleap.net",
  "gl-kristiansand": "https://kristiansand.autopark.giantleap.net",
  "gl-lillestrom": "https://lillestrom-autopark.giantleap.net",
  "gl-molde": "https://molde-autopark.giantleap.net",
  "gl-porsgrunn": "https://porsgrunn.autopark.giantleap.net",
  "gl-trondheim": "https://trondheim-autopark.giantleap.net",
};
const LOCAL_TIMEOUT_MS = 8000;

const LOCAL = {
  ...Object.fromEntries(Object.entries(GIANTLEAP_TENANTS).map(([id, base]) => [id, async (plate, ua) => {
    const data = await getJson(ua, `${base}/public/rest/pah/license-plate/${plate}/lookup`);
    if (data.resultCode && data.resultCode !== "SUCCESS") throw new Error(data.resultCode);
    return data.results;
  }])),
  // unum.vestpark.no – Vestpark's own system.
  vestpark: (plate, ua) => getJson(ua, `https://unum.vestpark.no/Auth/SearchParkingSessionPayment?licensePlate=${plate}`),
};

const UPSTREAMS = {
  // Same request autopay.io's "betal uten app" page makes.
  autopay: (plate, env, ua) => fetchJson(ua, `https://selfservice-api-run.autopay.io/sessions/v2/unpaid/${plate}`),

  // qpark-betaling.giantleap.no (Aimo Park / Q-Park).
  aimo: (plate, env, ua) => fetchJson(ua, `https://qpark-autopark.giantleap.net/public/rest/pah/license-plate/${plate}/lookup`),

  // flow.apcoa.no "Søk opp parkering". Replies 404 + plain text when there
  // is nothing to pay, so normalise that to an empty list.
  apcoa: async (plate, env, ua) => {
    const res = await upstream(ua, `https://flow.apcoa.no/api/transactions/${plate}`);
    if (res.status === 404) return json([]);
    return passthrough(res);
  },

  // All smaller operators at once. Only hits and failures are returned, to
  // keep the response small: { hits: { id: [session...] }, failed: [id...] }.
  others: async (plate, env, ua) => {
    const entries = Object.entries(LOCAL);
    const settled = await Promise.allSettled(entries.map(([, check]) => check(plate, ua)));
    const hits = {};
    const failed = [];
    settled.forEach((r, i) => {
      const id = entries[i][0];
      if (r.status === "rejected" || !Array.isArray(r.value)) failed.push(id);
      else if (r.value.length) hits[id] = r.value;
    });
    // Partial answers are still useful, but don't cache them.
    return json({ hits, failed }, 200, failed.length ? 0 : CACHE_SECONDS);
  },

  // Statens vegvesen vehicle lookup. Needs the SVV_API_KEY secret.
  svv: async (plate, env, ua) => {
    if (!env.SVV_API_KEY) return json({ error: "SVV not configured" }, 501);
    const res = await upstream(
      ua,
      `https://akfell-datautlevering.atlas.vegvesen.no/enkeltoppslag/kjoretoydata?kjennemerke=${plate}`,
      { "SVV-Authorization": `Apikey ${env.SVV_API_KEY}` },
    );
    // SVV answers 204 (empty body) for plates it doesn't know.
    if (res.status === 204 || res.status === 404) return json({ error: "Ikke funnet" }, 404);
    if (!res.ok) return json({ error: "SVV unavailable" }, 502);
    const data = await res.json();
    const car = data.kjoretoydataListe?.[0];
    if (!car) return json({ error: "Ikke funnet" }, 404);

    const teknisk = car.godkjenning?.tekniskGodkjenning?.tekniskeData ?? {};
    return json({
      vehicle: {
        make: teknisk.generelt?.merke?.[0]?.merke,
        model: teknisk.generelt?.handelsbetegnelse?.[0],
        year: car.forstegangsregistrering?.registrertForstegangNorgeDato?.slice(0, 4),
        color: teknisk.karosseriOgLasteplan?.rFarge?.[0]?.kodeNavn,
      },
    }, 200, 86400); // vehicle data rarely changes
  },
};

export async function onRequestGet({ request, params, env, waitUntil }) {
  const provider = String(params.provider);
  const plate = String(params.plate).toUpperCase();
  const handler = Object.hasOwn(UPSTREAMS, provider) ? UPSTREAMS[provider] : null;

  if (!handler) return json({ error: "Unknown provider" }, 404);
  if (!PLATE.test(plate)) return json({ error: "Invalid plate" }, 400);

  // Edge cache keyed on the normalised URL. (The Cache API is a no-op on
  // *.pages.dev preview URLs, but works on the custom domain.)
  const cacheKey = new Request(new URL(`/api/${provider}/${plate}`, request.url));
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  // Identify ourselves to providers by the domain we're served on.
  const userAgent = `fakktura (+${new URL(request.url).origin})`;

  let res;
  try {
    res = await handler(plate, env, userAgent);
  } catch (err) {
    return json({ error: "Upstream failed", detail: String(err) }, 502);
  }
  if (res.status === 200 && !/max-age=0\b/.test(res.headers.get("Cache-Control"))) {
    waitUntil(cache.put(cacheKey, res.clone()));
  }
  return res;
}

function upstream(userAgent, url, headers = {}) {
  return fetch(url, { headers: { Accept: "application/json", "User-Agent": userAgent, ...headers } });
}

// For the batched lookups: throws on anything but a JSON 200, with a timeout
// so one slow operator can't hold up the rest.
async function getJson(userAgent, url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": userAgent },
    signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchJson(userAgent, url) {
  return passthrough(await upstream(userAgent, url));
}

// Re-wrap upstream JSON so we control headers (no upstream cookies etc.).
async function passthrough(res) {
  const status = res.status === 429 ? 429 : res.ok ? 200 : 502;
  const body = await res.text();
  try {
    return json(JSON.parse(body), status);
  } catch {
    return json({ error: "Unexpected upstream response", status: res.status }, 502);
  }
}

function json(data, status = 200, maxAge = CACHE_SECONDS) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // The answer is the same for anyone asking about the plate (the
      // upstreams are public), so a shared cache is fine. The Cache API
      // also refuses to store `private`. Errors are never cached.
      "Cache-Control": status === 200 ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}
