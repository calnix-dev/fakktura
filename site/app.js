const $ = (sel) => document.querySelector(sel);
const form = $("#search");
const input = $("#plate");
const button = $("#go");
const hint = $("#hint");
const results = $("#results");
const summary = $("#summary");
const vehicle = $("#vehicle");
const recent = $("#recent");
const local = $("#local");
const manualNote = $("#manual");
const rowTemplate = $("#row");

const params = new URLSearchParams(location.search);
// ?demo=1 fakes provider answers so the UI can be tried without a proxy.
// ?demo=many shows a fixed case with hits at several providers.
const DEMO = params.has("demo");
const DEMO_MANY = params.get("demo") === "many";
const TIMEOUT_MS = 15000;
const RECENT_KEY = "fakktura:recent";

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
  },
};

// --- Plate handling -------------------------------------------------------

const cleanPlate = (s) => s.toUpperCase().replace(/[^A-ZÆØÅ0-9]/g, "");

// Standard plates are two letters + 4/5 digits; personalised plates are
// 2–7 letters/digits. Anything else is almost certainly a typo.
const STANDARD = /^[A-Z]{2}\d{4,5}$/;
const PERSONAL = /^[A-ZÆØÅ0-9]{2,7}$/;

const formatPlate = (p) => (STANDARD.test(p) ? `${p.slice(0, 2)} ${p.slice(2)}` : p);

input.addEventListener("input", () => {
  hint.textContent = "";
});

// --- Proxy ----------------------------------------------------------------

function withTimeout(promise, ms) {
  let id;
  const timeout = new Promise((_, reject) => {
    id = setTimeout(() => reject(new Error("Tidsavbrudd")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(id));
}

// Opened from disk (file://) there is no /api to talk to.
const HAS_PROXY = Boolean(PROXY_URL) && location.protocol !== "file:";

async function proxy(route, plate) {
  if (!HAS_PROXY) throw Object.assign(new Error("Ingen proxy konfigurert"), { manual: true });
  const url = `${PROXY_URL.replace(/\/$/, "")}/${route}/${encodeURIComponent(plate)}`;
  // X-Fakktura marks the request as coming from this page; /api rejects
  // requests without it (see functions/api/[provider]/[plate].js).
  const res = await fetch(url, { headers: { Accept: "application/json", "X-Fakktura": "1" } });
  if (res.status === 429) throw new Error("For mange søk – prøv igjen om litt");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const demoSession = (title, startH, durationH, amount) => ({
  title,
  start: hoursAgo(startH),
  end: hoursAgo(startH - durationH),
  amount,
  currency: "NOK",
});

// Fixed hits for ?demo=many, keyed by provider id.
const DEMO_MANY_HITS = {
  autopay: [
    demoSession("Storsenteret P-hus", 30, 2.5, 87),
    demoSession("Jernbanetorget P", 6, 1, 49),
  ],
  apcoa: [demoSession("Sykehuset parkering", 20, 4, 156)],
  // TimePark has a 48-hour deadline: one fresh, one about to run out.
  timepark: [
    demoSession("Kjøpesenteret P-hus", 3, 1, 38),
    demoSession("Stasjonen P-plass", 46, 1.5, 64.5),
  ],
  "gl-bergen": [demoSession("Bygarasjen", 40, 3, 120)],
};

function demoCheck(provider, plate) {
  // Deterministic per plate+provider so repeat searches look consistent.
  const seed = [...(plate + provider.id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const delay = 400 + (seed % 1200);
  return new Promise((resolve) => setTimeout(() => {
    if (DEMO_MANY) {
      const items = DEMO_MANY_HITS[provider.id];
      return resolve(items ? { status: "found", items } : { status: "clear" });
    }
    if (seed % 5 !== 0) return resolve({ status: "clear" });
    resolve({ status: "found", items: [demoSession("Storgata 12 – P-hus", 26, 2.5, 87)] });
  }, delay));
}

async function demoLocal(plate) {
  const results = await Promise.all(LOCAL_PROVIDERS.map(async (provider) => {
    // Outside ?demo=many, only let Vestpark (last) produce a hit.
    if (!DEMO_MANY && provider !== LOCAL_PROVIDERS.at(-1)) return null;
    const res = await demoCheck(provider, plate);
    return res.status === "found" ? { provider, items: res.items } : null;
  }));
  return { hits: results.filter(Boolean), failed: 0 };
}

// --- Rendering ------------------------------------------------------------

function money(n, cur = "NOK") {
  // "38 kr", but "38,50 kr".
  const minimumFractionDigits = Number.isInteger(n) ? 0 : 2;
  try {
    return new Intl.NumberFormat("nb-NO", { style: "currency", currency: cur, minimumFractionDigits, maximumFractionDigits: 2 }).format(n);
  } catch {
    // Unknown currency code from a provider (e.g. "kr"): show it as-is.
    return `${n.toLocaleString("nb-NO", { maximumFractionDigits: 2 })} ${cur}`;
  }
}

const toDate = (v) => {
  if (!v) return null;
  const date = new Date(v);
  return isNaN(date) ? null : date;
};
const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const RELATIVE_DAYS = new Map([[-1, "i går"], [0, "i dag"], [1, "i morgen"]]);
// "i går", "i dag" or "i morgen" when close, else "fre. 20. nov.".
function fmtDay(d) {
  const diff = Math.round((midnight(d) - midnight(new Date())) / 86_400_000);
  return RELATIVE_DAYS.get(diff) ?? d.toLocaleDateString("nb-NO", { weekday: "short", day: "numeric", month: "short" });
}
const fmtTime = (d) => d.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });

// "i dag 18:38–19:31", with both days when the parking spans midnight.
function when(start, end) {
  const s = toDate(start);
  const e = toDate(end);
  if (!s) return "";
  if (!e) return `${fmtDay(s)} kl. ${fmtTime(s)}`;
  return midnight(s).getTime() === midnight(e).getTime()
    ? `${fmtDay(s)} ${fmtTime(s)}–${fmtTime(e)}`
    : `${fmtDay(s)} ${fmtTime(s)} – ${fmtDay(e)} ${fmtTime(e)}`;
}

// When to pay by, counted from leaving: { at: "fre. 20. nov. kl. 19:31",
// left: "44 timer igjen" }, or { at, expired: true } once it has passed.
function deadline(item, hours) {
  const from = toDate(item.end) || toDate(item.start);
  if (!hours || !from) return null;
  const due = new Date(from.getTime() + hours * 3_600_000);
  const at = `${fmtDay(due)} kl. ${fmtTime(due)}`;
  const ms = due - Date.now();
  if (ms <= 0) return { at, expired: true };
  const h = Math.floor(ms / 3_600_000);
  return { at, left: h ? `${h} ${h === 1 ? "time" : "timer"} igjen` : `${Math.ceil(ms / 60_000)} min igjen` };
}

const el = (tag, className, text = "") => Object.assign(document.createElement(tag), { className, textContent: text });

function setRow(row, state, label) {
  row.dataset.state = state;
  row.querySelector(".row__label").textContent = label;
}

function renderRow(provider, plate) {
  const row = rowTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector(".row__name").textContent = provider.name;
  row.querySelector(".row__hint").textContent = provider.hint || "";
  const action = row.querySelector(".row__action");
  action.href = provider.payUrl(plate);
  return row;
}

function showAction(row, text, danger = false, href) {
  const action = row.querySelector(".row__action");
  if (href) action.href = href;
  action.textContent = `${text} ↗`;
  action.classList.toggle("btn--danger", danger);
  action.hidden = false;
}

// One box per session: place and amount on top, then when it was parked and
// when to pay by, each labelled so the times can't be mixed up.
function renderFound(row, items, payWithinHours) {
  const list = row.querySelector(".row__items");
  list.replaceChildren(...items.map((it) => {
    const li = document.createElement("li");
    li.append(el("strong", "item__title", it.title || "Ubetalt parkering"));
    if (it.amount != null) li.append(el("b", "item__amount", money(it.amount, it.currency)));

    const facts = el("dl", "item__facts");
    const parked = when(it.start, it.end);
    if (parked) facts.append(el("dt", "", "Parkert"), el("dd", "", parked));
    const due = deadline(it, payWithinHours);
    if (due) {
      const dd = el("dd", "item__due", due.expired ? `gikk ut ${due.at}` : due.at);
      if (due.left) dd.append(" ", el("span", "item__left", due.left));
      facts.append(el("dt", "", "Frist"), dd);
    }
    if (facts.childElementCount) li.append(facts);
    return li;
  }));
  list.hidden = false;
}

function renderSummary({ found, sessions, errors, manual }, plate) {
  const time = new Date().toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });
  let tone, icon, title, text;
  if (found) {
    tone = "bad";
    icon = "!";
    title = `${sessions} ubetalt${sessions === 1 ? "" : "e"} parkering${sessions === 1 ? "" : "er"} funnet`;
    text = `${found > 1 ? `Hos ${found} selskaper. ` : ""}Betal før fristen for å unngå fakturagebyr.`;
  } else if (errors) {
    tone = "warn";
    icon = "?";
    title = "Ingenting funnet – men ikke alle svarte";
    text = `${errors} selskap${errors === 1 ? "" : "er"} kunne ikke sjekkes. Prøv igjen, eller sjekk manuelt.`;
  } else {
    tone = "ok";
    icon = "✓";
    title = "Ingen ubetalte parkeringer funnet";
    text = manual ? `${manual} selskap${manual === 1 ? "" : "er"} må sjekkes manuelt, se under listen.` : "Du kan senke skuldrene.";
  }
  summary.dataset.tone = tone;
  summary.innerHTML = `<span class="summary__icon" aria-hidden="true"></span><div><h2></h2><p></p><p class="summary__stamp"></p></div>`;
  summary.querySelector(".summary__icon").textContent = icon;
  summary.querySelector("h2").textContent = title;
  summary.querySelector("p").textContent = text;
  // When the lookup ran, so it isn't mistaken for a parking time.
  summary.querySelector(".summary__stamp").textContent = `Sjekket ${formatPlate(plate)} kl. ${time}`;
  summary.hidden = false;
}

async function loadVehicle(plate, isStale) {
  vehicle.hidden = true;
  if (!HAS_PROXY || DEMO) return;
  try {
    const { vehicle: v } = await withTimeout(proxy("svv", plate), 6000);
    if (!v || isStale()) return;
    vehicle.innerHTML = `<div><small>Kjøretøy</small><strong></strong></div><div class="meta"></div>`;
    vehicle.querySelector("strong").textContent = [v.make, v.model].filter(Boolean).join(" ");
    vehicle.querySelector(".meta").textContent = [v.color, v.year].filter(Boolean).join(" · ");
    vehicle.hidden = false;
  } catch {
    // Vehicle info is a nice-to-have; never block the search on it.
  }
}

// Providers we can't query get one compact line of links instead of rows.
function renderManual(plate) {
  const links = PROVIDERS.filter((p) => !p.check).map((p) => {
    const a = document.createElement("a");
    a.href = p.payUrl(plate);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = `${p.name} ↗`;
    return a;
  });
  if (!links.length) return;
  const parts = ["Sjekk også manuelt: "];
  links.forEach((a, i) => parts.push(...(i ? [" · ", a] : [a])));
  parts.push(" (krever valg av parkeringsplass)");
  manualNote.replaceChildren(...parts);
  manualNote.hidden = false;
}

// --- Search ---------------------------------------------------------------

// Each search gets an id; results from an older search that finish late are
// dropped instead of landing in the newer search's list.
let searchId = 0;

async function search(plate) {
  const id = ++searchId;
  const isStale = () => id !== searchId;
  button.disabled = true;
  summary.hidden = true;
  results.replaceChildren();
  local.hidden = true;
  rememberPlate(plate);
  renderManual(plate);
  try {
    history.replaceState(null, "", `?${new URLSearchParams({ ...(DEMO && { demo: params.get("demo") || "1" }), plate })}`);
  } catch { /* some browsers refuse URL changes on file:// */ }

  loadVehicle(plate, isStale);

  const tally = { found: 0, sessions: 0, errors: 0, manual: 0 };
  const ctx = { proxy };

  const showFound = (row, provider, items) => {
    if (isStale()) return;
    tally.found++;
    tally.sessions += items.length;
    setRow(row, "found", `${items.length} ubetalt`);
    renderFound(row, items, provider.payWithinHours);
    // Link straight to the session when the provider gives us one.
    const direct = items.length === 1 ? items[0].url : undefined;
    showAction(row, `Betal hos ${provider.name.split(" /")[0]}`, true, direct);
    results.prepend(row); // surface hits at the top
  };

  // Smaller operators: one batched call, and only hits get a row.
  const localTask = (async () => {
    const names = LOCAL_PROVIDERS.map((p) => p.name).join(", ");
    if (!HAS_PROXY && !DEMO) {
      local.textContent = `${LOCAL_PROVIDERS.length} lokale selskaper kan ikke sjekkes uten /api.`;
      local.hidden = false;
      return;
    }
    try {
      const { hits, failed } = await withTimeout(DEMO ? demoLocal(plate) : checkLocal(plate, ctx), TIMEOUT_MS);
      if (isStale()) return;
      for (const { provider, items } of hits) {
        showFound(renderRow(provider, plate), provider, items);
      }
      // The names are only there for those who want them.
      const more = el("details");
      more.append(
        el("summary", "", `Også sjekket ${LOCAL_PROVIDERS.length} lokale selskaper` + (failed ? ` (${failed} svarte ikke)` : "")),
        `${names}.`,
      );
      local.replaceChildren(more);
    } catch {
      if (isStale()) return;
      tally.errors++;
      local.textContent = `Fikk ikke sjekket lokale selskaper (${names}). Prøv igjen om litt.`;
    }
    local.hidden = false;
  })();

  tally.manual = PROVIDERS.filter((p) => !p.check).length;

  await Promise.all([localTask, ...PROVIDERS.filter((p) => p.check).map(async (provider, i) => {
    const row = renderRow(provider, plate);
    row.style.animationDelay = `${i * 40}ms`;
    results.append(row);

    try {
      const res = await withTimeout(DEMO ? demoCheck(provider, plate) : provider.check(plate, ctx), TIMEOUT_MS);
      if (isStale()) return;
      if (res.status === "found") {
        showFound(row, provider, res.items);
      } else {
        setRow(row, "clear", "Ingenting");
      }
    } catch (err) {
      if (isStale()) return;
      if (err.manual) {
        tally.manual++;
        setRow(row, "manual", "Sjekk manuelt");
      } else {
        tally.errors++;
        setRow(row, "error", "Feil");
        row.title = err.message;
      }
      showAction(row, "Sjekk selv");
    }
  })]);

  if (isStale()) return;
  renderSummary(tally, plate);
  button.disabled = false;
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const plate = cleanPlate(input.value);
  if (!PERSONAL.test(plate)) {
    hint.textContent = "Skriv inn et gyldig norsk skiltnummer, f.eks. AB 12345.";
    input.focus();
    return;
  }
  hint.textContent = STANDARD.test(plate) ? "" : "Søker på personlig skilt.";
  input.value = formatPlate(plate);
  input.blur();
  search(plate);
});

// --- Recent plates (stored only in this browser) ----------------------------

function rememberPlate(plate) {
  const list = [plate, ...store.get(RECENT_KEY, []).filter((p) => p !== plate)].slice(0, 4);
  store.set(RECENT_KEY, list);
  renderRecent(plate);
}

// The plate on screen is left out; it's already in the search field.
function renderRecent(current) {
  recent.replaceChildren(...store.get(RECENT_KEY, []).filter((p) => p !== current).map((p) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = formatPlate(p);
    b.addEventListener("click", () => {
      input.value = formatPlate(p);
      form.requestSubmit();
    });
    li.append(b);
    return li;
  }));
}

// --- Theme ----------------------------------------------------------------

const THEME_KEY = "fakktura:theme";
const applyTheme = (t) => (t ? document.documentElement.setAttribute("data-theme", t) : document.documentElement.removeAttribute("data-theme"));
applyTheme(store.get(THEME_KEY, null));
$("#theme").addEventListener("click", () => {
  const current = document.documentElement.dataset.theme
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  store.set(THEME_KEY, next);
  applyTheme(next);
});

// --- Boot -----------------------------------------------------------------

renderRecent();
const initial = params.get("plate");
if (initial) {
  input.value = initial;
  form.requestSubmit();
} else {
  input.focus();
}

// Service worker: lets the app be installed and open offline. Not on file://.
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* not critical */ });
}
