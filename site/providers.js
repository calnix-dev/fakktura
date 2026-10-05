// Registry of Norwegian "park now, pay later" providers.
//
// Each provider has a `check(plate, ctx)` that resolves to
//   { status: "clear" }                       nothing outstanding
//   { status: "found", items: [Session...] }  unpaid sessions
// or throws. Providers without `check` are link-only: we cannot query them
// (e.g. they require a per-location secret), so the UI offers a deep link.
//
// Only Norwegian portals are linked. Where a Norwegian portal runs on a
// foreign backend (ParkPay → logos.dk), that is noted next to the endpoint.

/** @typedef {{ title?: string, start?: string, end?: string, amount?: number, currency?: string, url?: string }} Session */

const PROVIDERS = [
  {
    id: "autopay",
    name: "Onepark / Autopay",
    hint: "Onepark, Autopay-skilt, mange kjøpesentre",
    payUrl: (plate) => `https://autopay.io/oneTimePayment/${encodeURIComponent(plate)}`,
    // Same endpoint autopay.io's own "betal uten app" page uses.
    async check(plate, { proxy }) {
      const data = await proxy("autopay", plate);
      return fromList(data.sessions);
    },
  },
  {
    id: "aimo",
    name: "Aimo Park / Q-Park",
    hint: "Tidligere Europark og Q-Park",
    payUrl: () => "https://qpark-betaling.giantleap.no/",
    async check(plate, { proxy }) {
      const data = await proxy("aimo", plate);
      if (data.resultCode && data.resultCode !== "SUCCESS") {
        throw new Error(data.errorMsg || data.resultCode);
      }
      return fromList(data.results);
    },
  },
  {
    id: "apcoa",
    name: "Apcoa Flow",
    hint: "Apcoa-anlegg med kameragjenkjenning",
    payUrl: () => "https://flow.apcoa.no/transaction-list-search",
    async check(plate, { proxy }) {
      // The function maps Apcoa's "nothing found" reply to an empty list.
      const data = await proxy("apcoa", plate);
      return fromList(data);
    },
  },
  {
    id: "parkpay",
    name: "ParkPay",
    hint: "betaling.parkpay.no / PassPay",
    payUrl: () => "https://betaling.parkpay.no/",
    // betaling.parkpay.no (Norwegian portal) is served by the Danish vendor
    // Logos; this is the API host its own config.js points to. It allows
    // cross-origin requests, so we call it directly. countryCode is the
    // plate's country, so this only looks up Norwegian plates.
    async check(plate) {
      const res = await fetch("https://parkpayapi.logos.dk/api/v1.0/parking/parkings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registration: plate, countryCode: "NO", vehicleTypeID: 0 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const locations = data.locations;
      if (!Array.isArray(locations)) throw new Error("Uventet svar");
      // A location may bundle several parkings; flatten when it does.
      const items = locations.flatMap((loc) => {
        const nested = loc.parkings || loc.registrations;
        return Array.isArray(nested) && nested.length
          ? nested.map((p) => ({ ...p, locationName: p.locationName || loc.name || loc.locationName }))
          : [loc];
      });
      return fromList(items);
    },
  },
  {
    id: "timepark",
    name: "TimePark / Parkly",
    hint: "pay.timepark.no og pay.parkly.no",
    // Both portals run the same app and search the same operator, and both
    // pre-fill the search from ?licensePlate=.
    payUrl: (plate) => `https://pay.timepark.no/?licensePlate=${encodeURIComponent(plate)}`,
    // The portals' own "søk på skilt" flow. The tenant id is the public value
    // from their app config; the API allows cross-origin requests, so it is
    // called directly. It only returns parkings from the last 48 hours.
    async check(plate) {
      const res = await fetch(`https://app-timepark-prd-consumer-api.azurewebsites.net/api/manualpayment/${encodeURIComponent(plate)}/1`, {
        headers: { "tenant-id": "d7c30b1b-252b-4d86-a1a6-38f3dcfb99d8" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.orderExists) return fromList(data.data);
      if (data.error?.errorCode === "PARKING_NOT_FOUND") return { status: "clear" };
      throw new Error(data.error?.errorTitle || "Ukjent svar");
    },
  },
];

// Smaller operators: checked in one batched call to /api/others, and only
// shown in the results when they actually find something. Most are
// municipal "Pay at home" sites on Giantleap (the same system as Aimo).
const payAtHome = (tenant) => () => `https://${tenant}-payathome.giantleap.net/`;
const LOCAL_PROVIDERS = [
  { id: "gl-asker", name: "Asker", hint: "Pay at home", payUrl: payAtHome("asker") },
  { id: "gl-baerum", name: "Bærum", hint: "Pay at home", payUrl: payAtHome("baerum") },
  { id: "gl-bergen", name: "Bergen", hint: "Pay at home", payUrl: payAtHome("bergen") },
  { id: "gl-fredrikstad", name: "Fredrikstad", hint: "Pay at home", payUrl: payAtHome("fredrikstad") },
  { id: "gl-hamar", name: "Hamar", hint: "Pay at home", payUrl: payAtHome("hamar") },
  { id: "gl-kristiansand", name: "Kristiansand", hint: "Pay at home", payUrl: payAtHome("kristiansand") },
  { id: "gl-lillestrom", name: "Lillestrøm", hint: "Pay at home", payUrl: payAtHome("lillestrom") },
  { id: "gl-molde", name: "Molde", hint: "Pay at home", payUrl: payAtHome("molde") },
  { id: "gl-porsgrunn", name: "Porsgrunn", hint: "Pay at home", payUrl: payAtHome("porsgrunn") },
  { id: "gl-trondheim", name: "Trondheim Parkering", hint: "Smarte P-anlegg", payUrl: () => "https://smarte-p-anlegg.trondheimparkering.no/" },
  {
    id: "vestpark",
    name: "Vestpark",
    hint: "UNUM-anlegg",
    payUrl: () => "https://unum.vestpark.no/",
    // UNUM returns { id, hash } per session; its own page links straight to it.
    sessionUrl: (raw) => raw.id != null && raw.hash
      ? `https://unum.vestpark.no/UserParking/SelectPaymentOption?id=${encodeURIComponent(raw.id)}&hash=${encodeURIComponent(raw.hash)}`
      : undefined,
  },
];

// Resolves to { hits: [{ provider, items }], failed: number }.
async function checkLocal(plate, { proxy }) {
  const data = await proxy("others", plate);
  if (!data.hits || typeof data.hits !== "object" || !Array.isArray(data.failed)) throw new Error("Uventet svar");
  const hits = LOCAL_PROVIDERS.flatMap((provider) => {
    const raw = data.hits?.[provider.id];
    if (!Array.isArray(raw) || !raw.length) return [];
    const items = raw.map((r) => ({ ...normalizeSession(r), url: provider.sessionUrl?.(r) }));
    return [{ provider, items }];
  });
  return { hits, failed: data.failed.length };
}

// A missing or non-array list means the provider changed its API. That must
// show as an error, never as "nothing found".
function fromList(list) {
  if (!Array.isArray(list)) throw new Error("Uventet svar fra selskapet");
  const items = list.map(normalizeSession);
  return items.length ? { status: "found", items } : { status: "clear" };
}

// Provider payloads differ and are undocumented, so pick the first field
// that looks right. Anything we can't read is simply not shown; the user
// still gets the count and a link to the provider.
const pick = (obj, keys) => {
  for (const k of keys) {
    const v = k.split(".").reduce((o, part) => (o == null ? o : o[part]), obj);
    if (v != null && v !== "") return v;
  }
};

/** @returns {Session} */
function normalizeSession(raw) {
  if (!raw || typeof raw !== "object") return {};
  let amount = pick(raw, [
    "amount", "amountInclusiveVat", "totalAmount", "price", "totalPrice", "sum", "total",
    "amountToPay", "amountIncVat", "fee", "price.amount", "cost",
  ]);
  if (typeof amount === "object") amount = pick(amount, ["amount", "value"]);
  amount = amount == null ? undefined : Number(amount);
  // Explicit minor-unit (øre) fields win over guessed ones.
  const inMinor = pick(raw, ["amountInCents", "amountMinor", "priceInOre"]);
  if (inMinor != null) amount = Number(inMinor) / 100;

  return {
    title: pick(raw, [
      "locationName", "zoneName", "facilityName", "parkingLotName", "areaName",
      "siteName", "name", "operatorName", "location.name", "facility.name", "zone.name", "address",
    ]),
    start: pick(raw, ["startTime", "start", "entranceDateTime", "entryTime", "entryDate", "arrivalTime", "startDate", "from", "checkIn"]),
    end: pick(raw, ["endTime", "end", "exitDateTime", "exitTime", "exitDate", "departureTime", "endDate", "to", "checkOut"]),
    amount: Number.isFinite(amount) ? amount : undefined,
    currency: pick(raw, ["currency", "currencyCode", "price.currency"]) || "NOK",
  };
}
