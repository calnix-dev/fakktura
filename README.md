# fakktura

Tired of surprise invoices landing in your mailbox after a drive, because the parking signs were too small and the operator names too alike?

Many Norwegian car parks use "park now, pay later": cameras register your plate on entry and exit, and you have a short window (often 48 hours) to pay online. Miss it and you get an invoice with a hefty fee on top. With so many operators, it's easy to lose track of who runs which car park.

**fakktura** checks your licence plate against the major Norwegian operators at once and links you straight to the right payment page, before the invoice fee kicks in. The name is a mash-up of *fakk* (slang for, well, you know) and *faktura* (invoice).

The site itself is in Norwegian.

## Coverage

| Operator | How | Needs `/api` |
|---|---|---|
| Onepark / Autopay | Live lookup | Yes |
| Aimo Park / Q-Park | Live lookup | Yes |
| Apcoa Flow | Live lookup | Yes |
| ParkPay / PassPay | Live lookup, straight from the browser | No |
| TimePark / Parkly | Live lookup, straight from the browser (one search covers both portals) | No |
| Municipal "Pay at home" sites: Asker, Bærum, Bergen, Fredrikstad, Hamar, Kristiansand, Lillestrøm, Molde, Porsgrunn, Trondheim | Live lookup, shown only on a hit | Yes (batched) |
| Vestpark (UNUM) | Live lookup, shown only on a hit | Yes (batched) |

The smaller operators at the bottom are checked in a single batched call (`/api/others/{PLATE}`) that queries them all in parallel on the server, and they only get a row in the results when something is found. A full search therefore costs five function calls regardless of how many smaller operators are added. Most of the municipal sites run on Giantleap, the same system as Aimo/Q-Park, so adding another one is usually just a new tenant URL.

Lookups use the same public endpoints as each operator's own "pay without the app" page. They are undocumented and may change without notice. ParkPay's Norwegian portal (`betaling.parkpay.no`) runs on a Danish vendor's backend (Logos), hence the API host `parkpayapi.logos.dk`; it is only queried for Norwegian plates (`countryCode: "NO"`).

To add an operator, add an entry to [`site/providers.js`](site/providers.js) and, if it blocks cross-origin requests, an upstream in [`functions/api/[provider]/[plate].js`](functions/api/%5Bprovider%5D/%5Bplate%5D.js).

## Architecture

Hosted for free on [Cloudflare Pages](https://pages.cloudflare.com/).

```
site/                                 Static site, no build step (installable as an app)
functions/api/[provider]/[plate].js   Pages Function: GET /api/{provider}/{PLATE}
functions/index.js                    Makes link-preview URLs absolute on "/"
wrangler.toml                         Pages configuration
```

The browser does all the lookups. Operators that allow cross-origin requests (ParkPay) are called directly. The rest go through `/api` on the same domain, which forwards the request to the operator. `/api` is not an open proxy: it only knows a fixed set of operators and validates the plate. Responses are cached at the edge for 60 seconds (vehicle data for a day) to go easy on the operators.

Optionally, `/api/svv/{PLATE}` looks up make, model, colour and year from the Norwegian Public Roads Administration (Statens vegvesen), shown as a confirmation card. This requires an API key from Statens vegvesen.

## Running locally

```sh
npx wrangler pages dev            # http://localhost:8788, including /api
# http://localhost:8788/?demo=1     fake results, for trying the UI
# http://localhost:8788/?demo=many  fake hits at several operators
```

Wrangler reads secrets such as `SVV_API_KEY` from `.dev.vars` or `.env` (both git-ignored). You can also open `site/index.html` directly from disk, but operators behind `/api` will then show as "check manually".

## Deploying (free)

**1. Create the Pages project**

1. Push the repo to GitHub.
2. Cloudflare dashboard → *Workers & Pages* → *Create* → *Pages* → *Connect to Git*, and pick the repo.
3. Build settings: framework preset *None*, build command empty, build output directory `site`. The `functions/` folder is picked up automatically.
4. Production branch: the branch you push to.
5. Optional: *Settings → Variables and Secrets* → add `SVV_API_KEY` as a **secret**, then redeploy.

The site is now live at `https://<project>.pages.dev`, and every push deploys automatically. Alternatively, skip Git and deploy by hand with `npx wrangler login && npx wrangler pages deploy`.

**2. Custom domain (optional)**

1. In the Pages project: *Custom domains* → *Set up a custom domain* → e.g. `fakktura.example.com`. Do this **before** changing DNS.
2. At your DNS provider, add:

   | Type | Name | Target |
   |---|---|---|
   | CNAME | `fakktura` | `<project>.pages.dev` |

   Remove any existing records (A, AAAA, ALIAS, URL forwarding) for the same name first. If the domain's DNS is already on Cloudflare, the record is created for you.
3. Wait for Cloudflare to show the domain as *Active*, usually a few minutes. The HTTPS certificate is issued automatically.

## Costs

Cloudflare Pages' free plan covers this comfortably: static requests are unlimited, and Pages Functions get 100,000 requests a day (each search uses five, so roughly 20,000 searches a day). Going over the limit doesn't incur charges on the free plan; `/api` simply fails until the next day, and the site falls back to manual links.

**3. Web Analytics (optional)**

In the Pages project: *Metrics* → *Web Analytics* → *Enable*. Cloudflare injects its cookieless analytics script on the next deployment; the content security policy in `site/_headers` already allows it.

## Privacy

Plates are only sent to the parking operators (and Statens vegvesen, if enabled), via the site's own `/api`. Nothing is stored or logged by the site. Recent searches are remembered only in your own browser. Fonts are self-hosted, so no requests go to Google. If Web Analytics is enabled, Cloudflare counts page views without cookies.

Not affiliated with any of the parking operators.

## License

[MIT](LICENSE). The bundled fonts, Inter and JetBrains Mono, are under the SIL Open Font License; see `site/fonts/`.
