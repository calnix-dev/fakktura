// Runtime configuration for the static site.
//
// PROXY_URL is where the Pages Functions in /functions/api are served.
// Some providers (Autopay/Onepark, Aimo/Q-Park, Apcoa) do not allow
// requests from other websites (CORS), so the browser asks our own /api to
// fetch on its behalf. Set to "" to run without it: those providers then
// show a "sjekk manuelt" button instead of a live result.
const PROXY_URL = "/api";
