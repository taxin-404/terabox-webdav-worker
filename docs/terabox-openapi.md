# TeraBox Open Platform (official API) — extracted reference

Source: `https://dm.terabox.com/integrations/docs` (redirects to
`www.terabox.com/integrations/docs`; content extracted from the SPA bundle
`fe-static/fe-v5-web-index/js/index.06613082.js`, i18n dictionary `Ia`).
Extracted 2026-10-09.

This is the **official vendor API** — distinct from the private web API our
Worker uses. Recorded here because its docs confirm semantics we rely on and
hint at fixes for our upload path.

## Endpoints observed in the docs bundle

| Purpose | URL |
|---|---|
| Device code (QR login) | `https://www.terabox.com/oauth/devicecode` |
| Token exchange | `https://www.terabox.com/oauth/gettoken` |
| Token refresh | `https://www.terabox.com/oauth/refreshtoken` |
| Token info (domains!) | `https://www.terabox.com/oauth/tokeninfo` |
| Pre-upload (precreate) | `https://www.terabox.com/openapi/api/precreate` |
| File creation | `https://www.terabox.com/openapi/api/create` |
| File management | `https://www.terabox.com/openapi/api/filemanager` |
| File list | `https://www.terabox.com/openapi/api/list` |
| File metadata | `https://www.terabox.com/openapi/api/filemetas` |
| Download | `https://www.terabox.com/openapi/api/download` |
| Quota | `https://www.terabox.com/openapi/api/quota` |
| Search | `https://www.terabox.com/openapi/api/search` |
| Share APIs | `https://www.terabox.app/openapi/share/{download,list,mediameta,transfer}` |
| Shard upload (example host) | `https://c-jp.terabox.com/rest/2.0/pcs/superfile2` |

## Facts that matter for this project

1. **Upload host discovery.** The official flow gets the `superfile2` domain
   from the `upload_domain` field of `/oauth/tokeninfo` (all other APIs use
   `api_domain`). Recommended cache ≤ 1 h. The web-API equivalent we use,
   `/rest/2.0/pcs/file?method=locateupload`, is **not** covered by the docs —
   it is the browser flow and currently answers `400141` from Cloudflare egress
   IPs (see `docs/live-testing.md`).
2. **`app_id` = `250528`** — docs: shard-upload param "Fixed to 250528".
3. **Sharding rules.** Multi-shard uploads require each shard **> 4 MB**;
   shard order must match the `block_list` returned to precreate; `partseq`
   starts at 0. Response of superfile2: per-shard MD5 + uploadid + partseq.
4. **`rtype` semantics confirmed**: 0 = fail on conflict, 1 = rename on
   conflict, 2 = rename only if block_list differs, 3 = overwrite. Our
   `createFile()` maps `overwriteMode > 3 → rtype 1` like bclone.
5. **OAuth available**: `authorization_code` and `device_code` (QR) flows;
   `access_token` valid 2 days, refreshable via `refresh_token`. Requires a
   registered app (`client_id`/`client_secret`, optional `private_secret`).
6. **Official API namespace constraint**: file paths are confined to
   `/From: Other Applications/Application Name-{client_id}/` — the official API
   cannot see or serve the account's real drive tree. **Our cookie-based
   approach remains the right design for a full-drive WebDAV mirror.**
7. **No documented rate limits.** The only frequency-related error is
   "The frequency of exchanging the code for the access_token is too high."
   Empirical probing of the web API (see `docs/live-testing.md`) found no
   429 up to 32 rps.
8. Error hints from token endpoints: invalid `client_id`/`client_secret`,
   invalid/expired `access_token`, unsupported `grant_type`, user has not
   yet completed device_code authorization.

## Why we keep the private web API

| | Private web API (ours) | Official OpenAPI |
|---|---|---|
| Auth | session `ndus` cookie + `jsToken` | OAuth `access_token` |
| Drive visibility | full account tree | app sandbox folder only |
| Setup | paste a cookie | app registration + user consent |
| Stability risk | API drift, verification (400141) | documented, versioned |

Fallback idea if cookie auth collapses long-term: register an app, OAuth the
account, serve WebDAV rooted at the app sandbox folder.
