// GET / – serves the static page, with og:url and og:image rewritten to
// absolute URLs on whatever domain the site is served from. Link previews
// in Messenger, Slack etc. need absolute URLs, and this keeps the domain
// out of the repo. Only "/" runs through here; other files are served as
// plain static assets.

export async function onRequestGet({ request, next }) {
  const res = await next();
  if (!res.headers.get("Content-Type")?.includes("text/html")) return res;

  const origin = new URL(request.url).origin;
  const absolute = (el) => {
    const value = el.getAttribute("content");
    if (value?.startsWith("/")) el.setAttribute("content", origin + value);
  };
  return new HTMLRewriter()
    .on('meta[property="og:url"]', { element: absolute })
    .on('meta[property="og:image"]', { element: absolute })
    .transform(res);
}
