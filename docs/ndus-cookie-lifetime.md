# `ndus` session-cookie lifetime (measured)

How long the TeraBox session cookie actually lives, and what the web app rewrites
on an ordinary visit. Everything below was observed live against
`https://dm.terabox.com` on a logged-in account.

## TL;DR

- **`ndus` is the session auth cookie.** It carries a **~1 year** expiry
  (`expires = last-set + ~365d`), is `HttpOnly`, and is **not** re-issued on
  normal page views.
- The **device/anti-bot cookies rotate on every load** (`ndut_fmv`, `ndut_fmt`,
  `browserid`, `lang`) with 30/60-day windows. Those are the values that "change
  every visit" — not `ndus`.
- `ndus` only refreshes on an **auth event** (login, or a `/passport` /
  `/api/check/login` token renewal), not on a plain reload.

## Observed values (single logged-in session)

| Cookie | Role | HttpOnly | Value | Expiry (UTC) | Window |
|---|---|---|---|---|---|
| `ndus` | **session auth** | yes | 40 chars | 2027-10-09 06:57:19 | ~1 year |
| `ndut_fmv` | device fingerprint | — | 256 hex | 2026-11-09 | 30 d |
| `ndut_fmt` | device fingerprint | — | — | 2026-11-09 | 30 d |
| `browserid` | device id | — | — | 2026-12-08 | 60 d |
| `lang` | locale | no | `en` | 2026-11-09 | 30 d |
| `csrfToken` | CSRF | — | — | session | — |
| `g_state` / `__stripe_mid` | Google One-Tap / payments | — | — | — | not session cookies |

The `ndus` raw expiry was `expires=1823065039.78` → 2027-10-09 06:57:19 UTC
(checked 2026-10-10).

## What actually gets rewritten on a visit

Driving the real browser and capturing every `Set-Cookie` across **3 hard
reloads** (`ignoreCache: true`) of `/main?category=all`:

- `ndut_fmv` → **new value every reload** (all three loads emitted a fresh
  `Set-Cookie: ndut_fmv=...`).
- `lang` → set to `en`, 30-day window.
- `ndut_fmt` → appears on first visit, 30-day window.
- **`ndus` → no `Set-Cookie` emitted at all.** Value and `expires` unchanged
  across every reload.

The page issued ~19 authenticated API calls on load (`/api/check/login`,
`/api/user/getinfo`, `/api/quota`, `/passport/get_info`, `/api/list`,
`/rest/2.0/...`, membership, analytics). **None** returned a `Set-Cookie` for
`ndus`.

## Model

```
first login / passport renewal  ──►  Set-Cookie: ndus=…; expires=now + ~1y
                                              │
                                              ▼   (value fixed until next auth event)
        ordinary page loads  ──►  rotate ndut_fmv / ndut_fmt / browserid only
        no refresh of ndus
```

So `ndus` expiry is a **fixed ~1-year deadline anchored to the last auth event**,
not a sliding window. As long as the account performs *some* auth event within a
year it stays alive; a full year of silence lets it lapse and the user is logged
out.

> Note: an earlier working hypothesis was that `ndus` uses a sliding expiration
> that resets on every request. The capture **disproves** that — the moving
> 30/60-day device cookies were mistaken for the session cookie.

## Implication for this worker

The worker holds `COOKIE` as a static Secret (`src/sign.ts:valuedCookie`,
`src/terabox.ts` constructor) and never re-mints `ndus` — there is no auth event
on the worker side, only reads/writes. Consequences:

- A pasted `ndus` is good for **~1 year** from when the operator copied it.
- When it lapses, upstream returns `errno -6` / auth failure and the worker
  surfaces **HTTP 401** (`src/index.ts` — "Terabox session expired or invalid").
  Recovery is a manual `wrangler secret put COOKIE` with a freshly-copied cookie.
- **No amount of worker traffic extends the deadline**, because page/API loads
  do not re-issue `ndus`. Refresh requires logging in again in a browser.

## Repro

1. Attach a browser (CDP) to a logged-in `dm.terabox.com`.
2. `Network.enable`, then listen on `Network.responseReceivedExtraInfo`;
   inspect `headersText` for `Set-Cookie`.
3. `Page.reload({ ignoreCache: true })` a few times; diff the `ndus` line — it
   won't move, while `ndut_fmv` changes each time.
