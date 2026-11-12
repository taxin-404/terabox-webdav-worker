/**
 * Browser viewer for collection GETs — a WebDAV drive that reads in a tab.
 *
 * A browser navigating to a folder sends `Accept: text/html`; every WebDAV
 * client we serve (rclone, litmus, davfs, Mini-Redirector) sends the
 * wildcard Accept (or XML media types) and must keep the RFC 7231 §6.5.5
 * collection 405 with `Allow` (pinned in test/viewer.test.ts and litmus).
 * The two populations never overlap, so the Accept header is the whole
 * discriminator.
 *
 * Security posture:
 *   - Basic auth or a per-tab signed session (both fail-closed upstream
 *     in the fetch handler — nothing here re-implements auth). Browsers
 *     sign in through /.dav-login; the credential lives in sessionStorage
 *     (never a cookie) and every XHR/PUT carries it explicitly, so closing
 *     the tab ends the session.
 *   - The page carries its own CSP: inline script/style for itself,
 *     `connect-src 'self'` for same-origin XHR, `form-action 'self'` for
 *     the sign-out form, `frame-ancestors 'none'`. No img/media-src: the
 *     page has no previews (uploads and downloads only). File GETs keep
 *     their `sandbox; default-src 'none'` policy — uploaded HTML still
 *     cannot run script; the two policies never mix because a viewer
 *     response only ever comes from a *collection* GET.
 *   - The page builds every DOM node with textContent/createElement —
 *     listing data (display names, hrefs) is never concatenated into
 *     markup, so a hostile filename cannot inject script.
 *   - `Cache-Control: no-store` (the page version tracks the code) and
 *     `X-Content-Type-Options: nosniff` (added by the fetch handler).
 */

/** Test hook: the marker every viewer response carries. */
export const VIEWER_MARKER = 'data-viewer="1"';

const VIEWER_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * True when this request is a browser page navigation, not a WebDAV GET.
 *
 * The Accept header is negotiated, not substring-matched: `text/html;q=0`
 * is an explicit refusal (RFC 9110 §12.5.1) and must keep the collection
 * 405 — a `.includes()` here would happily serve the viewer to a client
 * that said it never wants HTML. The first `text/html` range governs (the
 * exact match's q wins over any later duplicate).
 */
export function wantsViewer(request: Request): boolean {
  if (request.method.toUpperCase() !== 'GET') return false;
  const accept = request.headers.get('Accept');
  if (!accept) return false;
  for (const part of accept.split(',')) {
    const fields = part.trim().split(';');
    if ((fields[0] || '').trim().toLowerCase() !== 'text/html') continue;
    let q = 1;
    for (const param of fields.slice(1)) {
      const eq = param.indexOf('=');
      if (eq === -1) continue;
      if (param.slice(0, eq).trim().toLowerCase() !== 'q') continue;
      const value = Number(param.slice(eq + 1).trim());
      q = Number.isNaN(value) ? 1 : value;
    }
    return q > 0;
  }
  return false;
}

/**
 * @param basePath The mount base (encoded, '' at the domain root) — the
 * page needs it to render a home crumb that always points at the WebDAV
 * root; it cannot derive that from location.pathname alone (the first
 * segment is the base only when a base exists).
 *
 * The shell is served without authentication these days: sessions are
 * per-tab (sessionStorage), so the document itself is public — it is
 * static and ships no data; every real request 401s without the
 * credential and the page shows its own sign-in card.
 */
export function viewerResponse(basePath: string): Response {
  const escaped = basePath.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const html = VIEWER_HTML.replace('data-base=""', `data-base="${escaped}"`);
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // The 200/405 pair below differs only by Accept (both no-store — but
      // state the dimension anyway so a cache that ignores no-store still
      // cannot serve the wrong variant).
      'Vary': 'Accept',
      'Content-Security-Policy': VIEWER_CSP,
    },
  });
}

/**
 * Canonical slash form. The page resolves child hrefs relative to its own
 * URL, so `/docs` (no slash) must land on `/docs/` before it renders, or a
 * click on `a.txt` would resolve to `/a.txt` at the wrong level.
 */
export function viewerRedirect(request: Request): Response {
  const target = new URL(request.url);
  target.pathname += '/';
  return Response.redirect(target.toString(), 301);
}

// The page: one self-contained document, zero third-party requests (no
// webfonts under CSP — system sans for UI, system mono for path/size/date).
export const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>davbox</title>
<style>
:root {
  --void: #0C1617;
  --petrol: #122123;
  --ridge: #173130;
  --line: #1E3638;
  --paper: #E6F0EE;
  --fog: #8CA5A2;
  --brass: #E3A857;
  --brass-ink: #171104;
  --jade: #6FBF8B;
  --coral: #E8705A;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--void);
  color: var(--paper);
  font: 13px/1.5 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
  display: flex;
  flex-direction: column;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
/* Sign-out is a page button: the per-tab credential lives in
   sessionStorage, so the page reveals it only when it actually holds
   credentials — a Basic client has nothing to sign out of. */
#signout { display: flex; margin: 0; margin-left: auto; }
#signout[hidden] { display: none; }

/* Per-tab sign-in card. The shell is public; the data is not. */
#authov {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: none;
  place-items: center;
  padding: 20px;
  background: color-mix(in srgb, var(--void) 78%, transparent);
}
#authov:not([hidden]) { display: grid; }
#authform {
  width: min(330px, 100%);
  background: var(--petrol);
  border: 1px solid var(--line);
  border-top: 3px solid var(--brass);
  border-radius: 12px;
  padding: 26px 24px 24px;
  box-shadow: 0 24px 70px rgb(0 0 0 / 0.5);
  animation: authIn 260ms var(--ease-out);
}
@keyframes authIn { from { opacity: 0; transform: translateY(14px) scale(.97); } }
#authform h1 { margin: 0 0 14px; font-size: 20px; font-weight: 600; letter-spacing: -0.015em; }
#authform h1 .dot { color: var(--brass); }
#authform label { display: block; margin-bottom: 13px; font-size: 12.5px; color: var(--fog); }
#authform input {
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 9px 11px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--void);
  color: var(--paper);
  font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  transition: border-color 120ms ease;
}
#authform input:focus { outline: 2px solid var(--brass); outline-offset: 1px; border-color: var(--brass); }
#authform button {
  width: 100%;
  margin-top: 4px;
  padding: 10px 12px;
  border: 1px solid var(--brass);
  border-radius: 8px;
  background: var(--brass);
  color: var(--brass-ink);
  font: 600 14px ui-sans-serif, system-ui, sans-serif;
  cursor: pointer;
  transition: filter 120ms ease;
}
#authform button:hover { filter: brightness(1.07); }
#authform button:active { filter: brightness(0.93); }
#authform button:focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; }
#autherr {
  margin: 0 0 14px;
  padding: 9px 11px;
  border: 1px solid color-mix(in srgb, var(--coral) 45%, var(--line));
  border-radius: 8px;
  background: color-mix(in srgb, var(--coral) 10%, var(--void));
  color: #F2A08D;
  font-size: 13px;
}

/* Path line — the signature: the current location, brass, in mono. */
.top {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--line);
  background: var(--petrol);
}
#crumbs {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  letter-spacing: -0.01em;
  overflow-x: auto;
  white-space: nowrap;
  scrollbar-width: thin;
  padding-bottom: 2px;
}
#crumbs a { color: var(--fog); text-decoration: none; transition: color 120ms var(--ease-out); }
#crumbs a:hover { color: var(--paper); text-decoration: underline; text-underline-offset: 3px; }
#crumbs .sep { color: #3A5654; padding: 0 7px; }
#crumbs .here { color: var(--brass); font-weight: 600; }
button, .btn {
  font: inherit;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--paper);
  border-radius: 8px;
  padding: 7px 14px;
  cursor: pointer;
  transition: background-color 120ms var(--ease-out), border-color 120ms var(--ease-out), filter 120ms var(--ease-out), transform 120ms var(--ease-out);
}
button:hover, .btn:hover { background: var(--ridge); border-color: #35555A; }
button.primary {
  background: var(--brass);
  border-color: var(--brass);
  color: var(--brass-ink);
  font-weight: 600;
  padding: 7px 16px;
}
button.primary:hover { background: var(--brass); filter: brightness(1.07); border-color: var(--brass); }
button:active { filter: brightness(0.93); transform: scale(.96); }
:focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; }

main { flex: 1; overflow: auto; position: relative; }
body.dropping main::before {
  content: "";
  position: absolute; inset: 8px;
  border-radius: 6px;
  z-index: 6;
  pointer-events: none;
  background:
    linear-gradient(90deg, var(--brass) 50%, transparent 0) repeat-x top / 16px 2px,
    linear-gradient(90deg, var(--brass) 50%, transparent 0) repeat-x bottom / 16px 2px,
    linear-gradient(0deg, var(--brass) 50%, transparent 0) repeat-y left / 2px 16px,
    linear-gradient(0deg, var(--brass) 50%, transparent 0) repeat-y right / 2px 16px;
  animation: ants 500ms linear infinite;
}
body.dropping main::after {
  content: "Drop files to upload";
  position: absolute; inset: 0;
  display: grid; place-items: center;
  background: color-mix(in srgb, var(--void) 86%, transparent);
  font: 600 15px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--brass);
  z-index: 5;
  pointer-events: none;
}
@keyframes ants {
  to { background-position: 16px 0, -16px 100%, 0 -16px, 100% 16px; }
}

table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th {
  text-align: left;
  font-weight: 500;
  font-size: 11px;
  letter-spacing: 0.05em;
  color: var(--fog);
  padding: 12px 20px 9px;
  border-bottom: 1px solid var(--line);
  position: sticky; top: 0;
  background: var(--void);
  z-index: 1;
}
th.num, td.num { text-align: right; }
td {
  padding: 10px 20px;
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
}
tbody tr {
  cursor: pointer;
  transition: background-color 140ms var(--ease-out);
  animation: rowIn .5s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  animation-delay: calc(var(--i, 0) * 38ms);
}
@keyframes rowIn {
  0% { opacity: 0; transform: translateX(-12px) scale(.985); }
  62% { opacity: 1; transform: translateX(2px) scale(1); }
  100% { opacity: 1; transform: none; }
}
@media (hover: hover) and (pointer: fine) {
  tbody tr:hover,
  tbody tr:focus-within {
    background: color-mix(in srgb, var(--brass) 7%, var(--void));
  }
}
.name { display: flex; align-items: center; gap: 11px; min-width: 0; }
/* Fixed layout: Size/Modified/Actions take set widths, Name absorbs the
   rest — auto layout lets long names min-content-expand past the viewport,
   pushing the actions column off-screen. */
th:nth-child(2), td.num { width: 76px; }
th:nth-child(3) { width: 160px; }
th:nth-child(4) { width: 132px; }
.name a {
  min-width: 0;
  color: var(--paper);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: linear-gradient(var(--brass), var(--brass)) left 100% / 0% 1px no-repeat;
  transition: color 120ms var(--ease-out), background-size 220ms var(--ease-out);
  padding-bottom: 1px;
}
@media (hover: hover) and (pointer: fine) {
  .name a:hover { color: var(--brass); text-decoration: none; background-size: 100% 1px; }
}
/* Name block: the link (+ a meta line phones show under it); badge after. */
.nmcol { display: block; min-width: 0; }
.m-meta { display: none; }
.m-meta b { color: var(--brass); font-weight: 600; }
/* Extension tags: plain mono text in the kind color — no pill boxes. */
.badge {
  flex: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  letter-spacing: 0.03em;
  text-transform: lowercase;
  animation: badgeIn .35s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  animation-delay: calc(var(--i, 0) * 38ms + 220ms);
}
@keyframes badgeIn {
  from { opacity: 0; transform: scale(.55); }
}
.badge.k-img { color: #7FC9A2; }
.badge.k-vid { color: #B9A6F0; }
.badge.k-aud { color: #E8A87C; }
.badge.k-txt { color: #86B6E8; }
.ic-dir { color: var(--brass); }
@media (hover: hover) and (pointer: fine) {
  .ic-dir { transition: transform .28s cubic-bezier(0.34, 1.56, 0.64, 1); transform-origin: 40% 60%; }
  tbody tr:hover .ic-dir { transform: rotate(-11deg) scale(1.22); }
}
.ic-file { color: var(--fog); }
.ic-up { color: #5E7A78; }
tr.up .name a { color: var(--fog); font-weight: 600; }
td.when { color: var(--fog); font-size: 12px; white-space: nowrap; }
td.size { color: var(--fog); font-size: 12px; white-space: nowrap; }
.row-actions { display: flex; gap: 4px; justify-content: flex-end; opacity: 1; transition: opacity 140ms var(--ease-out), transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1); }
@media (hover: hover) and (pointer: fine) {
  .row-actions { opacity: 0; transform: translateX(7px); }
  tbody tr:hover .row-actions, tbody tr:focus-within .row-actions { opacity: 1; transform: none; }
}
/* Row overflow button — opens the bottom action sheet on phones. */
.mmore { display: none; }
.row-actions a, .row-actions button {
  display: grid; place-items: center;
  width: 28px; height: 28px;
  padding: 0;
  color: var(--fog);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 7px;
  text-decoration: none;
  cursor: pointer;
  transition: color 120ms var(--ease-out), background-color 120ms var(--ease-out), border-color 120ms var(--ease-out);
}
.row-actions a:hover, .row-actions button:hover {
  color: var(--brass);
  background: var(--petrol);
  border-color: var(--line);
}

#empty {
  margin: 56px auto;
  max-width: 44ch;
  text-align: center;
  color: var(--fog);
  border: 1px dashed var(--line);
  border-radius: 12px;
  padding: 30px 26px;
}
#error {
  margin: 40px auto;
  max-width: 52ch;
  text-align: center;
  color: var(--coral);
}
#empty .btn, #empty button { margin-top: 14px; }

/* Toolbar progress chip — right where the eye already is. */
.upchip {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--paper);
  background: var(--void);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 5px 12px;
  white-space: nowrap;
  animation: chipPulse 1600ms ease-in-out infinite;
}
.upchip[hidden] { display: none; }
.upchip em {
  position: relative;
  display: block;
  width: 56px;
  height: 5px;
  background: #23413F;
  border-radius: 3px;
  overflow: hidden;
  flex: none;
}
.upchip em i {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 0;
  background: var(--brass);
  transition: width 160ms var(--ease-out), background-color 200ms var(--ease-out);
}
.upchip.done { border-color: #33563F; color: var(--jade); animation: none; }
.upchip.done em i { background: var(--jade); }
@keyframes chipPulse {
  0%, 100% { border-color: var(--line); }
  50% { border-color: var(--brass); }
}

/* Upload status lines — fixed to the viewport bottom so they can never be
   missed while a transfer is running; they append and never move rows. */
.uploads {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  z-index: 30;
  border-top: 1px solid var(--line);
  background: rgba(12, 22, 23, 0.96);
  box-shadow: 0 -12px 32px rgba(0, 0, 0, 0.45);
  padding: 10px 20px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  color: var(--paper);
  max-height: 120px;
  overflow: auto;
}
.uploads:empty { display: none; }
body.uploading main { padding-bottom: 68px; }
.uploads .ok { color: var(--jade); }
.uploads .bad { color: var(--coral); }
/* Upload progress lines: the bar sits behind the status text. */
.pline {
  position: relative;
  overflow: hidden;
  border-radius: 4px;
  padding: 2px 6px;
  margin: 2px -6px;
}
.pline i {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 0;
  background: color-mix(in srgb, var(--brass) 35%, transparent);
  transition: width 160ms var(--ease-out);
}
.pline.indet i { width: 30%; animation: pline-slide 900ms ease-in-out infinite alternate; }
.pline span { position: relative; }
.pline.ok { color: var(--jade); }
.pline.ok i { background: color-mix(in srgb, var(--jade) 30%, transparent); }
.pline.bad { color: var(--coral); }
@keyframes pline-slide { from { transform: translateX(-100%); } to { transform: translateX(320%); } }

/* ===== Mobile: the phone gets its own layout, not a shrunken table ===== */
@media (max-width: 640px) {
  .top { padding: 10px 12px; gap: 8px; }
  #upload { display: none; }
  #mkdir, #refresh, #signout {
    width: 34px; height: 34px;
    padding: 0;
    border-radius: 50%;
    font-size: 0;
    color: transparent;
    background-color: color-mix(in srgb, var(--ridge) 50%, transparent);
    background-repeat: no-repeat;
    background-position: center;
    background-size: 15px 15px;
  }
  #mkdir {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23E6F0EE' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M1.75 4.5c0-.97.78-1.75 1.75-1.75h2.6c.47 0 .92.19 1.26.53l.8.8h4.34c.97 0 1.75.78 1.75 1.75v5.42c0 .97-.78 1.75-1.75 1.75H3.5a1.75 1.75 0 0 1-1.75-1.75z'/%3E%3C/svg%3E");
  }
  #refresh {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23E6F0EE' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M13.2 8a5.2 5.2 0 1 1-1.6-3.75'/%3E%3Cpath d='M13.4 1.8v2.6h-2.6'/%3E%3C/svg%3E");
  }
  #signout {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23E6F0EE' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6.5 2.5h5a.8.8 0 0 1 .8.8v9.4a.8.8 0 0 1-.8.8h-5'/%3E%3Cpath d='M2.5 8h6.2M6.5 5.8 8.7 8l-2.2 2.2'/%3E%3C/svg%3E");
  }

  /* List rows: tile icon, wrapping name, meta line, overflow button. */
  thead { display: none; }
  table, tbody { display: block; }
  tbody tr { display: flex; align-items: center; border-bottom: 1px solid var(--ridge); }
  td { display: block; border-bottom: none; padding: 0; }
  td.nm { flex: 1; min-width: 0; padding: 10px 0 10px 14px; }
  td.acts { flex: none; padding: 10px 14px 10px 0; }
  td.num, td.when { display: none; }
  .name { gap: 11px; }
  .name svg { box-sizing: content-box; width: 17px; height: 17px; padding: 9px; background: var(--petrol); border: 1px solid var(--line); border-radius: 9px; }
  .name a {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    white-space: normal;
    word-break: break-word;
    background: none;
  }
  .m-meta { display: block; margin-top: 2px; }
  .badge { display: none; }
  .row-actions { display: none; }
  .mmore {
    display: grid; place-items: center;
    width: 34px; height: 34px;
    border: 1px solid var(--line);
    background: var(--petrol);
    color: var(--fog);
    border-radius: 8px;
    font: inherit;
    font-size: 15px;
    cursor: pointer;
    transition: transform 150ms var(--ease-out);
  }
  .mmore:active { transform: scale(.94); }
}

/* ===== Bottom action sheet + scrim (phones only) ===== */
.scrim {
  position: fixed; inset: 0;
  background: rgba(12, 22, 23, .72);
  opacity: 0;
  pointer-events: none;
  transition: opacity 240ms var(--ease-out);
  z-index: 40;
}
.sheet {
  position: fixed; left: 0; right: 0; bottom: 0;
  margin: 0 auto;
  max-width: 480px;
  background: var(--petrol);
  border: 1px solid var(--line);
  border-bottom: none;
  border-radius: 18px 18px 0 0;
  padding: 8px 16px 14px;
  transform: translateY(110%);
  transition: transform 320ms cubic-bezier(0.34, 1.4, 0.64, 1);
  box-shadow: 0 -8px 40px rgba(0, 0, 0, .5);
  z-index: 41;
}
body.sheeton .scrim { opacity: 1; pointer-events: auto; }
body.sheeton .sheet { transform: none; }
.sheet .handle { width: 36px; height: 4px; border-radius: 2px; background: #2A4648; margin: 2px auto 10px; }
.sheet .shname {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  color: var(--fog);
  margin: 0 2px 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sheet .shname b { color: var(--paper); font-weight: 500; }
.sbtn {
  display: flex; align-items: center; gap: 11px;
  width: 100%;
  text-align: left;
  font: inherit;
  font-size: 13.5px;
  color: var(--paper);
  background: rgba(23, 49, 48, .45);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 8px;
  cursor: pointer;
  text-decoration: none;
  transition: transform 150ms var(--ease-out), background-color 150ms var(--ease-out);
}
.sbtn:active { transform: scale(.98); background: var(--ridge); }
.sbtn .si { width: 16px; flex: none; display: grid; place-items: center; color: var(--fog); }
.sbtn.danger { color: var(--coral); border-color: color-mix(in srgb, var(--coral) 35%, transparent); }
.sbtn.danger .si { color: var(--coral); }
.sbtn[hidden] { display: none; }
.scancel {
  width: 100%;
  text-align: center;
  font: inherit;
  font-size: 13px;
  color: var(--fog);
  background: transparent;
  border: none;
  padding: 9px;
  cursor: pointer;
}
@media (min-width: 641px) {
  .scrim, .sheet { display: none; }
}

/* ===== Floating upload button (phones) ===== */
.fab {
  display: none;
  position: fixed; right: 18px; bottom: 26px;
  width: 54px; height: 54px;
  border-radius: 50%;
  border: none;
  background: var(--brass);
  color: var(--brass-ink);
  place-items: center;
  cursor: pointer;
  box-shadow: 0 4px 18px rgba(227, 168, 87, .4);
  transition: transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1), bottom 200ms var(--ease-out);
  animation: fabIn .45s .5s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  z-index: 7;
}
.fab:active { transform: scale(.9); }
@keyframes fabIn {
  from { opacity: 0; transform: scale(.4); }
}
@media (max-width: 640px) {
  .fab { display: grid; }
  body.uploading .fab { bottom: 140px; }
}

@media (prefers-reduced-motion: reduce) {
  tbody tr, .badge, .fab, .upchip { animation: none !important; }
  tbody tr, .row-actions, .name .ic-dir, .name a, .upchip, .sheet, .scrim, .mmore, .sbtn { transition: none !important; }
  body.dropping main::before { animation: none !important; }
  .pline.indet i { animation: none; }
  #authform { animation: none !important; }
}
</style>
</head>
<body data-viewer="1" data-base="">
<header class="top">
  <nav id="crumbs" class="mono" aria-label="Path"></nav>
  <button id="upload" class="primary">Upload files</button>
  <span id="upchip" class="upchip" hidden><em><i></i></em><span class="pct"></span></span>
  <button id="mkdir" aria-label="New folder">New folder</button>
  <button id="refresh" aria-label="Refresh listing">Refresh</button>
  <button id="signout" type="button" hidden>Sign out</button>
  <input id="picker" type="file" multiple hidden>
</header>
<main>
  <table aria-label="Files">
    <thead>
      <tr>
        <th>Name</th>
        <th class="num">Size</th>
        <th>Modified</th>
        <th aria-label="Actions"></th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <p id="empty" hidden></p>
  <p id="error" role="alert" hidden></p>
</main>
<button id="fab" class="fab" type="button" aria-label="Upload files"><svg viewBox="0 0 16 16" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg></button>
<div id="scrim" class="scrim"></div>
<div id="sheet" class="sheet" role="dialog" aria-modal="true" aria-label="File actions">
  <div class="handle" aria-hidden="true"></div>
  <p class="shname"><b id="sheetName"></b></p>
  <button class="sbtn" id="sheetOpen" type="button"><span class="si"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg></span>Open</button>
  <a class="sbtn" id="sheetDl" download><span class="si"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5V10m0 0 3-3m-3 3-3-3M3 12v1.2c0 .44.36.8.8.8h8.4c.44 0 .8-.36.8-.8V12"/></svg></span>Download</a>
  <button class="sbtn" id="sheetRen" type="button"><span class="si"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m11 2.6 2.4 2.4-7.4 7.4-3.2.8.8-3.2zM9.9 3.7l2.4 2.4"/></svg></span>Rename</button>
  <button class="sbtn danger" id="sheetDel" type="button"><span class="si"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.75 4.5h10.5M6.25 4.5v-.9a.9.9 0 0 1 .9-.9h1.7a.9.9 0 0 1 .9.9v.9M4.4 4.5l.55 8.2A1.15 1.15 0 0 0 6.09 13.75h3.82a1.15 1.15 0 0 0 1.14-1.05l.55-8.2M6.6 7v4.4M9.4 7v4.4"/></svg></span>Delete</button>
  <button class="scancel" id="sheetCancel" type="button">Cancel</button>
</div>
<div id="authov" hidden>
  <form id="authform" autocomplete="on">
    <h1>davbox<span class="dot">.</span></h1>
    <p id="autherr" hidden></p>
    <label>User <input id="authuser" name="user" autocomplete="username" required></label>
    <label>Password <input id="authpass" name="pass" type="password" autocomplete="current-password" required></label>
    <button type="submit">Sign in</button>
  </form>
</div>
<div id="uploads" class="uploads" aria-live="polite"></div>
<script>
(function () {
  'use strict';
  // Collapse any leading double slash first: a double-slash path still
  // reaches the root collection, and a base of '//' would make every fetch
  // a protocol-relative (cross-origin) URL.
  var base = location.pathname.replace(/^\\/+/, '/');
  if (base.charAt(base.length - 1) !== '/') base += '/';

  // Per-tab credential: sessionStorage dies with the tab — closing it
  // signs out, and nothing is saved anywhere. The server keeps no cookie
  // for the page; WebDAV clients still send Basic on every request.
  var AUTH_KEY = 'davbox_auth';
  var AUTH = null;
  try { AUTH = sessionStorage.getItem(AUTH_KEY); } catch (e) {}

  // Every data call rides the stored credential; a 401 opens the
  // sign-in card instead of a dead-end error.
  function api(url, opts) {
    opts = opts || {};
    if (AUTH) {
      var h = {};
      if (opts.headers) {
        for (var k in opts.headers) {
          if (Object.prototype.hasOwnProperty.call(opts.headers, k)) h[k] = opts.headers[k];
        }
      }
      h['Authorization'] = AUTH;
      opts = Object.assign({}, opts, { headers: h });
    }
    return fetch(url, opts);
  }

  var PROPFIND_BODY =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<D:propfind xmlns:D="DAV:"><D:prop>' +
    '<D:displayname/><D:resourcetype/><D:getcontentlength/><D:getlastmodified/>' +
    '</D:prop></D:propfind>';

  var IMG = ['png','jpg','jpeg','gif','webp','svg','avif','bmp','ico','heic'];
  var VID = ['mp4','webm','ogv','m4v','mkv','mov','avi','ts','mts','m2ts','flv','wmv','mpg','mpeg','3gp'];
  var AUD = ['mp3','m4a','aac','wav','flac','ogg','oga','opus','wma','aiff','aif'];
  var TXT = ['txt','md','markdown','json','js','mjs','cjs','ts','tsx','jsx','css','scss','less','html','htm','xml','yml','yaml','toml','ini','conf','cfg','sh','bash','zsh','py','rb','php','go','rs','java','c','h','cpp','hpp','cs','sql','log','csv','env','lock','properties','srt','vtt','tex','r','swift','kt','lua','pl','diff','patch'];

  var upchip = document.getElementById('upchip');
  var upchipPct = upchip.querySelector('.pct');
  var upchipBar = upchip.querySelector('em i');
  var ups = []; // in-flight uploads: { name, pct }
  var roundFails = 0;

  function upShow() {
    if (ups.length === 0) return;
    var sum = 0;
    for (var i = 0; i < ups.length; i++) sum += ups[i].pct;
    var pct = Math.round(sum / ups.length);
    upchipBar.style.width = pct + '%';
    if (ups.length > 1) {
      upchipPct.textContent = ups.length + ' files · ' + pct + '%';
    } else if (ups[0].pct >= 100) {
      upchipPct.textContent = ups[0].name + ' · finishing…';
    } else {
      upchipPct.textContent = ups[0].name + ' · ' + pct + '%';
    }
    upchip.classList.remove('done');
    upchip.hidden = false;
  }

  function upEnd(ok) {
    if (!ok) roundFails++;
    if (ups.length > 0) { upShow(); return; }
    if (ok && roundFails === 0) {
      upchipBar.style.width = '100%';
      upchipPct.textContent = '✓ uploaded';
      upchip.classList.add('done');
      upchip.hidden = false;
      setTimeout(function () {
        if (ups.length === 0) {
          upchip.hidden = true;
          upchip.classList.remove('done');
        }
      }, 2200);
    } else {
      upchip.hidden = true;
    }
  }

  // The strip is fixed to the viewport bottom; pad the page only while it
  // has content so it can never cover the last row.
  var upObs = document.getElementById('uploads');
  if (window.MutationObserver) {
    new MutationObserver(function () {
      document.body.classList.toggle('uploading', upObs.childNodes.length > 0);
    }).observe(upObs, { childList: true });
  }

  var crumbs = document.getElementById('crumbs');
  var rows = document.getElementById('rows');
  var empty = document.getElementById('empty');
  var errorEl = document.getElementById('error');
  var picker = document.getElementById('picker');
  var uploads = document.getElementById('uploads');
  var entries = [];

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }
  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  function decodeSeg(seg) {
    try { return decodeURIComponent(seg); } catch (e) { return seg; }
  }

  function renderCrumbs() {
    crumbs.textContent = '';
    var home = document.body.getAttribute('data-base') || '/';
    if (home.charAt(home.length - 1) !== '/') home += '/';
    var homeParts = home.split('/').filter(Boolean);
    var parts = base.split('/').filter(Boolean);
    var under = parts.slice(homeParts.length); // segments below the mount root
    var homeLabel = homeParts.length ? homeParts[homeParts.length - 1] : '/';
    if (under.length === 0) {
      crumbs.appendChild(el('span', 'here', homeLabel));
      return;
    }
    var homeA = document.createElement('a');
    homeA.href = home;
    homeA.textContent = homeLabel;
    crumbs.appendChild(homeA);
    var acc = home;
    for (var i = 0; i < under.length; i++) {
      acc += under[i] + '/';
      crumbs.appendChild(el('span', 'sep', '/'));
      if (i === under.length - 1) {
        crumbs.appendChild(el('span', 'here', decodeSeg(under[i])));
      } else {
        var a = document.createElement('a');
        a.href = acc;
        a.textContent = decodeSeg(under[i]);
        crumbs.appendChild(a);
      }
    }
  }

  function extOf(name) {
    // dot >= 0: a dotfile's extension is the part after its leading dot
    // ('.env' -> 'env') — dotfiles were unpreviewable when the dot had to
    // come after a prefix; no dot at all -> ''.
    var dot = name.lastIndexOf('.');
    return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  }

  var BARE = ['dockerfile', 'makefile', 'rakefile', 'gemfile', 'procfile', 'license', 'readme'];

  function kindOf(name) {
    var ext = extOf(name);
    if (IMG.indexOf(ext) >= 0) return 'img';
    if (VID.indexOf(ext) >= 0) return 'vid';
    if (AUD.indexOf(ext) >= 0) return 'aud';
    if (TXT.indexOf(ext) >= 0) return 'txt';
    if (ext === '' && BARE.indexOf(name.toLowerCase()) >= 0) return 'txt';
    return 'other';
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var v = bytes;
    for (var i = 0; i < units.length; i++) {
      v /= 1024;
      if (v < 1024 || i === units.length - 1) {
        return (Math.round(v * 10) / 10) + ' ' + units[i];
      }
    }
    return bytes + ' B';
  }

  function fmtWhen(str) {
    var d = new Date(str);
    if (isNaN(d.getTime())) return '';
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function icon(paths, cls, fill) {
    var NS = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('width', '14');
    s.setAttribute('height', '14');
    if (fill) {
      s.setAttribute('fill', 'currentColor');
      s.setAttribute('stroke', 'none');
    } else {
      s.setAttribute('fill', 'none');
      s.setAttribute('stroke', 'currentColor');
      s.setAttribute('stroke-width', '1.5');
      s.setAttribute('stroke-linecap', 'round');
      s.setAttribute('stroke-linejoin', 'round');
    }
    if (cls) s.setAttribute('class', cls);
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('d', paths);
    s.appendChild(p);
    return s;
  }
  function svg(paths, cls) { return icon(paths, cls, false); }
  function svgF(paths, cls) { return icon(paths, cls, true); }
  var ICON_DLO = 'M8 2.5V10m0 0 3-3m-3 3-3-3M3 12v1.2c0 .44.36.8.8.8h8.4c.44 0 .8-.36.8-.8V12';
  var ICON_DIR = 'M1.75 4.5c0-.97.78-1.75 1.75-1.75h2.6c.47 0 .92.19 1.26.53l.8.8h4.34c.97 0 1.75.78 1.75 1.75v5.42c0 .97-.78 1.75-1.75 1.75H3.5a1.75 1.75 0 0 1-1.75-1.75z';
  var ICON_FL = 'M4.5 2.25h4.4l3.1 3.1v8.4h-7.5zM8.9 2.25v3.1h3.1';
  var ICON_UP = 'M8 13V3.5M8 3.5 4.75 6.75M8 3.5l3.25 3.25';
  var ICON_EDT = 'm11 2.6 2.4 2.4-7.4 7.4-3.2.8.8-3.2zM9.9 3.7l2.4 2.4';
  var ICON_DEL = 'M2.75 4.5h10.5M6.25 4.5v-.9a.9.9 0 0 1 .9-.9h1.7a.9.9 0 0 1 .9.9v.9M4.4 4.5l.55 8.2A1.15 1.15 0 0 0 6.09 13.75h3.82a1.15 1.15 0 0 0 1.14-1.05l.55-8.2M6.6 7v4.4M9.4 7v4.4';

  function childHrefs(doc) {
    var out = [];
    var responses = doc.getElementsByTagName('D:response');
    for (var i = 0; i < responses.length; i++) {
      var hrefEl = responses[i].getElementsByTagName('D:href')[0];
      if (!hrefEl) continue;
      var href = (hrefEl.textContent || '').trim();
      // hrefs this page can use are absolute paths on this origin; anything
      // else (crafted upstream) is dropped rather than assigned to a link.
      if (href.charAt(0) !== '/') continue;
      var decoded;
      try { decoded = decodeURIComponent(href); } catch (e) { continue; }
      // The collection itself: compare BOTH forms — hrefs from the worker
      // are percent-encoded like location.pathname, but a mixed raw/decoded
      // comparison used to miss on every spaced/UTF-8 path and list the
      // folder as its own child.
      var selfDecoded;
      try { selfDecoded = decodeURIComponent(location.pathname); } catch (e2) { selfDecoded = location.pathname; }
      if (href === location.pathname || decoded === selfDecoded) continue;
      var props = {};
      var display = responses[i].getElementsByTagName('D:displayname');
      var lengths = responses[i].getElementsByTagName('D:getcontentlength');
      var mods = responses[i].getElementsByTagName('D:getlastmodified');
      var types = responses[i].getElementsByTagName('D:resourcetype');
      if (display[0]) props.name = display[0].textContent || '';
      if (lengths[0]) props.size = parseInt(lengths[0].textContent || '0', 10) || 0;
      if (mods[0]) props.when = mods[0].textContent || '';
      props.isDir = types[0] ? types[0].getElementsByTagName('D:collection').length > 0 : false;
      if (!props.name) {
        var tail = decoded.replace(/\\/$/, '').split('/').pop() || decoded;
        props.name = tail;
      }
      out.push({ href: href, decoded: decoded, name: props.name, size: props.size, when: props.when, isDir: props.isDir });
    }
    return out;
  }

  function mountHome() {
    var home = document.body.getAttribute('data-base') || '/';
    if (home.charAt(home.length - 1) !== '/') home += '/';
    return home;
  }

  function upRow() {
    // Classic FTP-style parent entry — one row above the listing.
    var tr = document.createElement('tr');
    tr.className = 'up';
    tr.style.setProperty('--i', '0');
    tr.setAttribute('data-href', base.slice(0, base.lastIndexOf('/', base.length - 2) + 1));
    tr.setAttribute('data-dir', '1');
    var tdName = document.createElement('td');
    tdName.className = 'nm';
    var wrap = el('div', 'name');
    var nmcol = el('div', 'nmcol');
    var link = document.createElement('a');
    link.href = tr.getAttribute('data-href');
    link.textContent = '..';
    link.title = 'Go to parent folder';
    link.setAttribute('aria-label', 'Parent folder');
    nmcol.appendChild(link);
    wrap.appendChild(svg(ICON_UP, 'ic-up'));
    wrap.appendChild(nmcol);
    tdName.appendChild(wrap);
    tr.appendChild(tdName);
    tr.appendChild(el('td', 'num size mono', '—'));
    tr.appendChild(el('td', 'when mono', ''));
    tr.appendChild(el('td', 'acts', ''));
    return tr;
  }

  function renderRows(list) {
    entries = list;
    rows.textContent = '';
    list.sort(function (a, b) {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    if (base !== mountHome()) rows.appendChild(upRow());
    for (var i = 0; i < list.length; i++) {
      rows.appendChild(rowFor(list[i], i));
    }
    if (list.length === 0) {
      empty.textContent = 'Nothing here yet. Drop files here or use Upload files.';
      empty.hidden = false;
    } else {
      empty.hidden = true;
    }
  }

  function rowFor(entry, i) {
    var tr = document.createElement('tr');
    tr.style.setProperty('--i', String(Math.min(i, 12)));
    tr.setAttribute('data-i', String(i));

    var tdName = document.createElement('td');
    tdName.className = 'nm';
    var wrap = el('div', 'name');
    var nmcol = el('div', 'nmcol');
    var link = document.createElement('a');
    link.className = entry.isDir ? '' : 'mono';
    link.href = entry.href + (entry.isDir && entry.href.charAt(entry.href.length - 1) !== '/' ? '/' : '');
    link.textContent = entry.name;
    link.title = entry.name;
    nmcol.appendChild(link);
    var meta = el('span', 'm-meta');
    var ext = '';
    if (entry.isDir) {
      meta.textContent = 'folder';
      wrap.appendChild(svgF(ICON_DIR, 'ic-dir'));
    } else {
      wrap.appendChild(svg(ICON_FL, 'ic-file'));
      ext = extOf(entry.name);
      meta.appendChild(el('b', '', fmtSize(entry.size)));
      var when = fmtWhen(entry.when);
      if (when) meta.appendChild(document.createTextNode(' · ' + when));
    }
    nmcol.appendChild(meta);
    wrap.appendChild(nmcol);
    if (!entry.isDir && ext) {
      wrap.appendChild(el('span', 'badge k-' + kindOf(entry.name), ext));
    }
    tdName.appendChild(wrap);
    tr.appendChild(tdName);
    tr.setAttribute('data-href', link.href);
    if (entry.isDir) tr.setAttribute('data-dir', '1');

    var tdSize = el('td', 'num size mono', entry.isDir ? '—' : fmtSize(entry.size));
    tr.appendChild(tdSize);
    tr.appendChild(el('td', 'when mono', fmtWhen(entry.when)));

    var tdAct = document.createElement('td');
    tdAct.className = 'acts';
    var mm = el('button', 'mmore');
    mm.type = 'button';
    mm.textContent = '⋮';
    mm.setAttribute('aria-label', 'Actions for ' + entry.name);
    tdAct.appendChild(mm);
    var acts = el('div', 'row-actions');
    var dl = document.createElement('a');
    dl.href = entry.href;
    dl.setAttribute('download', '');
    dl.title = 'Download ' + entry.name;
    dl.setAttribute('aria-label', 'Download ' + entry.name);
    dl.appendChild(svg(ICON_DLO));
    // A plain navigation to href can't carry the per-tab credential: sign
    // it first, like every other file open.
    dl.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      signAndOpen(entry.href);
    });
    acts.appendChild(dl);

    var ren = document.createElement('button');
    ren.type = 'button';
    ren.title = 'Rename ' + entry.name;
    ren.setAttribute('aria-label', 'Rename ' + entry.name);
    ren.appendChild(svg(ICON_EDT));
    ren.addEventListener('click', function (ev) { ev.stopPropagation(); renameEntry(entry); });
    acts.appendChild(ren);

    var del = document.createElement('button');
    del.type = 'button';
    del.title = 'Delete ' + entry.name;
    del.setAttribute('aria-label', 'Delete ' + entry.name);
    del.appendChild(svg(ICON_DEL));
    del.addEventListener('click', function (ev) { ev.stopPropagation(); deleteEntry(entry); });
    acts.appendChild(del);

    tdAct.appendChild(acts);
    tr.appendChild(tdAct);
    return tr;
  }

  function statusLine(name, cls, text) {
    var line = el('div', cls, name + ' — ' + text);
    uploads.appendChild(line);
    return line;
  }

  function progLine(name, text) {
    var line = el('div', 'pline indet');
    var bar = el('i');
    var span = el('span', '', name + ' — ' + text);
    line.appendChild(bar);
    line.appendChild(span);
    uploads.appendChild(line);
    return {
      pct: function (p) {
        line.classList.remove('indet');
        bar.style.width = p + '%';
        // Client finished sending; the worker is still pushing the bytes to
        // storage — say so, or 100% looks frozen.
        span.textContent = name + ' — ' + (p >= 100 ? '100% · finishing…' : p + '%');
      },
      restart: function (text) {
        line.className = 'pline indet';
        bar.style.width = '';
        span.textContent = name + ' — ' + text;
      },
      finish: function (cls, text) {
        line.className = 'pline ' + cls;
        bar.style.width = '100%';
        span.textContent = name + ' — ' + text;
        if (cls === 'ok') {
          setTimeout(function () {
            if (line.parentNode) line.parentNode.removeChild(line);
          }, 4000);
        }
      },
    };
  }

  // XHR, not fetch: fetch gives no upload progress events, and the bar IS
  // the indicator people wait on for big files.
  function putXhr(url, opts) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      xhr.open(opts.method || 'PUT', url);
      if (AUTH) xhr.setRequestHeader('Authorization', AUTH);
      if (opts.headers) {
        for (var key in opts.headers) {
          if (Object.prototype.hasOwnProperty.call(opts.headers, key)) {
            xhr.setRequestHeader(key, opts.headers[key]);
          }
        }
      }
      if (opts.ifNoneMatch) xhr.setRequestHeader('If-None-Match', '*');
      xhr.upload.onprogress = function (e) {
        if (opts.onProgress && e.lengthComputable && e.total) {
          opts.onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
        }
      };
      xhr.onload = function () { resolve({ status: xhr.status, text: xhr.responseText }); };
      xhr.onerror = function () { resolve({ status: 0, text: '' }); };
      xhr.onabort = function () { resolve({ status: 0, text: '' }); };
      xhr.send(opts.body);
    });
  }

  // Cloudflare's edge refuses any request body over ~100 MB before it ever
  // reaches this worker (413), so a single PUT can never carry a bigger
  // file — that is the platform cap users hit, not a Terabox limit. Above
  // RESUMABLE_LIMIT the page switches to the worker's resumable control
  // plane (begin -> chunk PUTs -> finalize): every body stays tiny, the
  // create-only/overwrite handshake is identical, and the same progress
  // chip reports per-chunk bytes. Mirrors the tbbig script that pushed
  // 4 GB through the same route.
  var RESUMABLE_LIMIT = 64 * 1024 * 1024;

  function putResumable(file, prog, track, endTrack) {
    var beginUrl = base + '.resumable';
    var sessionId = null;
    var replacing = false;
    var abortSession = function () {
      // best-effort cancel: an orphaned session would hold its chunks
      if (!sessionId) return;
      var id = sessionId;
      sessionId = null;
      putXhr(base + '.resumable/' + id, { method: 'DELETE' });
    };
    var begin = function (ifNoneMatch) {
      // The JSON path lives in davPath space (like the /.resumable route
      // itself): mount-relative, leading slash, NO mount prefix — sending
      // the URL path here makes toTera look for an upstream parent folder
      // named after the mount (e.g. root + /dav/...) and begin 409s.
      var rel = base.slice(mountHome().length);
      return putXhr(beginUrl, {
        method: 'POST',
        ifNoneMatch: ifNoneMatch,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/' + rel + file.name, size: file.size, mtimeMs: file.lastModified || Date.now() }),
      });
    };
    var fail = function (err) {
      abortSession();
      prog.finish('bad', err && err.message ? err.message : 'failed');
      endTrack(false);
    };
    var sendChunks = function (info) {
      var id = info && info.uploadId;
      var chunkSize = info && info.chunkSize;
      var chunkCount = info && info.chunkCount;
      if (!id || !chunkSize || !chunkCount) throw new Error('bad begin response');
      sessionId = id;
      var index = 0;
      var done = 0;
      var next = function () {
        if (index >= chunkCount) {
          prog.pct(100);
          track.pct = 100;
          upShow();
          return putXhr(base + '.resumable/' + id + '/finalize', { method: 'POST' }).then(function (res) {
            if (res.status === 0) throw new Error('network error at finalize');
            if (res.status < 200 || res.status >= 300) {
              throw new Error('finalize failed with HTTP ' + res.status);
            }
            sessionId = null;
            prog.finish('ok', replacing ? 'replaced' : 'uploaded');
            endTrack(true);
          });
        }
        var start = index * chunkSize;
        var end = Math.min(start + chunkSize, file.size);
        return putXhr(base + '.resumable/' + id + '/' + index, {
          method: 'PUT',
          body: file.slice(start, end),
          onProgress: function (p) {
            var pct = Math.floor(((done + (end - start) * (p / 100)) * 100) / file.size);
            if (pct > 99) pct = 99; // 100% means "finalizing" everywhere else too
            prog.pct(pct);
            track.pct = pct;
            upShow();
          },
        }).then(function (res) {
          if (res.status === 0) throw new Error('network error on chunk ' + (index + 1) + '/' + chunkCount);
          if (res.status < 200 || res.status >= 300) {
            throw new Error('chunk ' + (index + 1) + '/' + chunkCount + ' failed with HTTP ' + res.status);
          }
          done += end - start;
          index += 1;
          return next();
        });
      };
      return next();
    };
    // Same handshake as single PUT: create-only first, confirm to replace.
    return begin(true).then(function (res) {
      if (res.status !== 412) return res;
      if (!window.confirm(file.name + ' already exists. Replace it?')) {
        prog.finish('bad', 'cancelled (existing file kept)');
        endTrack(false);
        return null;
      }
      replacing = true;
      prog.restart('replacing…');
      return begin(false);
    }).then(function (res) {
      if (!res) return;
      if (res.status === 0) throw new Error('network error');
      if (res.status < 200 || res.status >= 300) throw new Error('begin failed with HTTP ' + res.status);
      var info;
      try {
        info = JSON.parse(res.text);
      } catch (e) {
        throw new Error('bad begin response');
      }
      return sendChunks(info);
    }).catch(fail);
  }

  function putFile(file) {
    var prog = progLine(file.name, 'uploading…');
    var track = { name: file.name, pct: 0 };
    ups.push(track);
    upShow();
    var endTrack = function (ok) {
      var i = ups.indexOf(track);
      if (i >= 0) ups.splice(i, 1);
      upEnd(ok);
    };
    var url = base + encodeURIComponent(file.name);
    // Over the edge's ~100 MB per-request cap a single PUT can only ever
    // 413 — hand the file to the chunked control plane instead.
    if (file.size > RESUMABLE_LIMIT) return putResumable(file, prog, track, endTrack);
    // Create-only first: a bare PUT over an existing file is a silent
    // overwrite server-side (WebDAV PUT default). If-None-Match: * asks for
    // 412 instead, and only an explicit confirm replaces the existing file.
    var send = function (ifNoneMatch) {
      return putXhr(url, {
        ifNoneMatch: ifNoneMatch,
        body: file,
        onProgress: function (p) { prog.pct(p); track.pct = p; upShow(); },
      });
    };
    var replacing = false;
    return send(true).then(function (res) {
      if (res.status !== 412) return res;
      if (!window.confirm(file.name + ' already exists. Replace it?')) {
        prog.finish('bad', 'cancelled (existing file kept)');
        endTrack(false);
        return null;
      }
      replacing = true;
      prog.restart('replacing…');
      return send(false);
    }).then(function (res) {
      if (!res) return;
      if (res.status === 0) throw new Error('network error');
      if (res.status === 413) throw new Error('too large (100 MB per-request edge limit)');
      if (res.status < 200 || res.status >= 300) throw new Error('failed with HTTP ' + res.status);
      prog.finish('ok', replacing ? 'replaced' : 'uploaded');
      endTrack(true);
    }).catch(function (err) {
      prog.finish('bad', err && err.message ? err.message : 'failed');
      endTrack(false);
    });
  }

  function renameEntry(entry) {
    var next = window.prompt('Rename to:', entry.name);
    if (next === null) return;
    next = next.trim();
    if (!next || next === entry.name) return;
    if (next.indexOf('/') >= 0) {
      statusLine(entry.name, 'bad', 'not renamed — names cannot contain "/"');
      return;
    }
    var line = statusLine(entry.name, '', 'renaming…');
    var dest = new URL(base + encodeURIComponent(next), location.origin).toString();
    api(entry.href, {
      method: 'MOVE',
      headers: { Destination: dest, Overwrite: 'F' },
    }).then(function (res) {
      if (res.status === 401) { needAuth(); throw new Error('sign in to continue'); }
      if (res.status === 412) throw new Error('a file with that name already exists');
      if (res.status === 409) throw new Error('folder missing or conflict');
      if (!res.ok) throw new Error('failed with HTTP ' + res.status);
      line.className = 'ok';
      line.textContent = entry.name + ' — renamed to ' + next;
      load();
    }).catch(function (err) {
      line.className = 'bad';
      line.textContent = entry.name + ' — ' + (err && err.message ? err.message : 'rename failed');
    });
  }

  function deleteEntry(entry) {
    if (!window.confirm('Delete ' + entry.name + (entry.isDir ? ' and everything inside it' : '') + '?')) return;
    var line = statusLine(entry.name, '', 'deleting…');
    api(entry.href, { method: 'DELETE' }).then(function (res) {
      if (res.status === 401) { needAuth(); throw new Error('sign in to continue'); }
      if (res.status === 409) throw new Error('locked or not empty — check LOCKs');
      if (!res.ok && res.status !== 204) throw new Error('failed with HTTP ' + res.status);
      line.className = 'ok';
      line.textContent = entry.name + ' — deleted';
      load();
    }).catch(function (err) {
      line.className = 'bad';
      line.textContent = entry.name + ' — ' + (err && err.message ? err.message : 'delete failed');
    });
  }

  function mkdir() {
    var name = window.prompt('Folder name:');
    if (name === null) return;
    name = name.trim();
    if (!name) return;
    if (name.indexOf('/') >= 0) {
      statusLine(name, 'bad', 'not created — names cannot contain "/"');
      return;
    }
    var line = statusLine(name, '', 'creating…');
    api(base + encodeURIComponent(name), { method: 'MKCOL' }).then(function (res) {
      if (res.status === 401) { needAuth(); throw new Error('sign in to continue'); }
      if (res.status === 405) throw new Error('that name is taken (405)');
      if (res.status === 409) throw new Error('parent folder missing (409)');
      if (!res.ok && res.status !== 201) throw new Error('failed with HTTP ' + res.status);
      line.className = 'ok';
      line.textContent = name + ' — folder created';
      load();
    }).catch(function (err) {
      line.className = 'bad';
      line.textContent = name + ' — ' + (err && err.message ? err.message : 'create failed');
    });
  }

  function uploadFiles(fileList) {
    var files = [];
    for (var i = 0; i < fileList.length; i++) files.push(fileList[i]);
    if (files.length === 0) return;
    clearError();
    roundFails = 0;
    Promise.all(files.map(putFile)).then(function () { load(); });
  }

  document.getElementById('upload').addEventListener('click', function () { picker.click(); });
  document.getElementById('mkdir').addEventListener('click', mkdir);
  document.getElementById('refresh').addEventListener('click', function () { load(); });
  picker.addEventListener('change', function () {
    uploadFiles(picker.files);
    picker.value = '';
  });

  // ===== Per-tab navigation + full-row activation + action sheet =====
  // Folders stay inside this document (a full page load could never
  // re-authenticate with a sessionStorage credential); files mint a
  // one-minute signed URL and navigate to it. The name link and the
  // sheet buttons route through the same two paths, and an in-progress
  // text selection is never hijacked.

  function navTo(href) {
    var u = new URL(href, location);
    base = u.pathname.replace(/^\\/+/, '/');
    if (base.charAt(base.length - 1) !== '/') base += '/';
    history.pushState(null, '', base);
    load();
  }

  function signAndOpen(href) {
    // The browser asks for files as a plain navigation, which can never
    // carry the per-tab credential — get a 60 s signed URL first.
    var path = new URL(href, location).pathname;
    api('/.dav-sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path }),
    }).then(function (res) {
      if (res.status === 401) { needAuth(); return; }
      if (!res.ok) throw new Error('could not open — HTTP ' + res.status);
      return res.json();
    }).then(function (info) {
      if (info && info.url) window.location.href = info.url;
    }).catch(function (err) {
      showError(err && err.message ? err.message : 'could not open');
    });
  }

  window.addEventListener('popstate', function () {
    base = location.pathname.replace(/^\\/+/, '/');
    if (base.charAt(base.length - 1) !== '/') base += '/';
    load();
  });

  crumbs.addEventListener('click', function (ev) {
    var a = ev.target.closest('a');
    if (!a) return;
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    ev.preventDefault();
    navTo(a.getAttribute('href'));
  });

  var sheetOpenBtn = document.getElementById('sheetOpen');
  var sheetDl = document.getElementById('sheetDl');
  var sheetRenBtn = document.getElementById('sheetRen');
  var sheetDelBtn = document.getElementById('sheetDel');
  var sheetCancelBtn = document.getElementById('sheetCancel');
  var sheetNameEl = document.getElementById('sheetName');
  var currentEntry = null;
  var lpFired = false;

  function rowEntry(tr) {
    if (!tr || !tr.hasAttribute('data-i')) return null;
    return entries[+tr.getAttribute('data-i')] || null;
  }
  function openSheet(entry) {
    if (!entry) return;
    currentEntry = entry;
    sheetNameEl.textContent = entry.name;
    sheetDl.href = entry.href;
    sheetDl.hidden = entry.isDir;
    document.body.classList.add('sheeton');
    sheetOpenBtn.focus();
  }
  function closeSheet() {
    document.body.classList.remove('sheeton');
  }

  rows.addEventListener('click', function (ev) {
    var tr = ev.target.closest('tr');
    if (!tr) return;
    if (ev.target.closest('.mmore')) {
      openSheet(rowEntry(tr));
      return;
    }
    if (lpFired) { lpFired = false; return; }
    var link = ev.target.closest('a');
    if (ev.target.closest('button') || (link && link.closest('.row-actions'))) return;
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    var href = link ? link.getAttribute('href') : tr.getAttribute('data-href');
    if (!href) return;
    ev.preventDefault();
    if (tr.getAttribute('data-dir') === '1') navTo(href);
    else signAndOpen(href);
  });

  sheetOpenBtn.addEventListener('click', function () {
    if (!currentEntry) return;
    var href = currentEntry.href;
    if (currentEntry.isDir && href.charAt(href.length - 1) !== '/') href += '/';
    closeSheet();
    if (currentEntry.isDir) navTo(href);
    else signAndOpen(href);
  });
  sheetDl.addEventListener('click', function (ev) {
    ev.preventDefault();
    closeSheet();
    if (currentEntry) signAndOpen(currentEntry.href);
  });
  sheetRenBtn.addEventListener('click', function () {
    var entry = currentEntry;
    closeSheet();
    if (entry) renameEntry(entry);
  });
  sheetDelBtn.addEventListener('click', function () {
    var entry = currentEntry;
    closeSheet();
    if (entry) deleteEntry(entry);
  });
  sheetCancelBtn.addEventListener('click', closeSheet);
  document.getElementById('scrim').addEventListener('click', function () {
    if (lpFired) { lpFired = false; return; }
    closeSheet();
  });
  document.getElementById('fab').addEventListener('click', function () { picker.click(); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { closeSheet(); authov.hidden = true; }
  });

  // Long-press (touch) and right-click open the sheet on phones only — a
  // desktop right-click keeps the browser's own menu.
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
    var lp = null;
    var lpClear = function () {
      if (lp) { clearTimeout(lp.t); lp = null; }
    };
    rows.addEventListener('touchstart', function (ev) {
      if (ev.touches.length !== 1) return;
      var tr = ev.target.closest('tr');
      if (!tr || !tr.hasAttribute('data-i')) return;
      lpClear();
      lp = { tr: tr, x: ev.touches[0].clientX, y: ev.touches[0].clientY, t: null };
      lp.t = setTimeout(function () {
        lp = null;
        lpFired = true;
        openSheet(rowEntry(tr));
        setTimeout(function () { lpFired = false; }, 400);
      }, 500);
    }, { passive: true });
    rows.addEventListener('touchmove', function (ev) {
      if (!lp) return;
      var dx = ev.touches[0].clientX - lp.x, dy = ev.touches[0].clientY - lp.y;
      if (dx * dx + dy * dy > 144) lpClear(); // moved — it's a scroll, not a press
    }, { passive: true });
    rows.addEventListener('touchend', lpClear, { passive: true });
    rows.addEventListener('touchcancel', lpClear, { passive: true });
    rows.addEventListener('contextmenu', function (ev) {
      var tr = ev.target.closest('tr');
      if (!tr || !tr.hasAttribute('data-i')) return;
      ev.preventDefault();
      openSheet(rowEntry(tr));
    });
  }

  document.addEventListener('dragover', function (ev) {
    // Always suppress the default: dropping selected text or a URL without
    // preventDefault navigates the page and destroys the viewer state.
    ev.preventDefault();
    if (ev.dataTransfer && Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'Files') >= 0) {
      document.body.classList.add('dropping');
    }
  });
  document.addEventListener('dragleave', function (ev) {
    if (ev.relatedTarget === null) document.body.classList.remove('dropping');
  });
  document.addEventListener('drop', function (ev) {
    ev.preventDefault();
    document.body.classList.remove('dropping');
    if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) {
      uploadFiles(ev.dataTransfer.files);
    }
  });

  function load() {
    clearError();
    renderCrumbs();
    api(base, {
      method: 'PROPFIND',
      headers: { Depth: '1', 'Content-Type': 'text/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    }).then(function (res) {
      if (res.status === 401) { needAuth(); throw new Error('sign in to view this folder'); }
      if (res.status === 500) throw new Error('server error — check the worker logs');
      if (!res.ok) throw new Error('listing failed (HTTP ' + res.status + ')');
      return res.text();
    }).then(function (xml) {
      var doc = new DOMParser().parseFromString(xml, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) throw new Error('listing was not valid XML');
      renderRows(childHrefs(doc));
    }).catch(function (err) {
      showError(err && err.message ? err.message : 'listing failed');
    });
  }

  // ===== Per-tab sign-in card =====
  var authov = document.getElementById('authov');
  var authform = document.getElementById('authform');
  var authuser = document.getElementById('authuser');
  var authpass = document.getElementById('authpass');
  var autherr = document.getElementById('autherr');
  var signoutBtn = document.getElementById('signout');

  function needAuth() {
    autherr.hidden = true;
    authov.hidden = false;
    try { authuser.focus(); } catch (e) {}
  }

  // btoa throws on chars > 0xFF: credentials may be unicode ('üser'), so
  // base64 the UTF-8 bytes (the RFC 7617 charset="UTF-8" form the server
  // decodes).
  function b64utf8(s) {
    var bytes = new TextEncoder().encode(s), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  authform.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var user = authuser.value;
    var pass = authpass.value;
    autherr.hidden = true;
    api('/.dav-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user: user, pass: pass }).toString(),
    }).then(function (res) {
      if (res.status === 401) throw new Error('Wrong user or password.');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      AUTH = 'Basic ' + b64utf8(user + ':' + pass);
      try { sessionStorage.setItem(AUTH_KEY, AUTH); } catch (e) {}
      authov.hidden = true;
      signoutBtn.hidden = false;
      load();
    }).catch(function (err) {
      autherr.textContent = err && err.message === 'Wrong user or password.'
        ? err.message
        : 'Sign-in failed — try again';
      autherr.hidden = false;
    });
  });

  signoutBtn.addEventListener('click', function () {
    try { sessionStorage.removeItem(AUTH_KEY); } catch (e) {}
    // also wipe any legacy cookie from the pre-per-tab era
    try { navigator.sendBeacon('/.dav-logout', ''); } catch (e) {}
    location.reload();
  });

  if (AUTH) signoutBtn.hidden = false;

  try { document.title = decodeURIComponent(base); } catch (e) { document.title = base; }
  load();
})();
</script>
</body>
</html>
`;
