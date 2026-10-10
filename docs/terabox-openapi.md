# TeraBox Open Platform (official API) — full extracted reference

Source: `https://dm.terabox.com/integrations/docs` (SPA; content extracted from
the rendered page, 2026-10-10). Copyright notice in the page reads
"©2026 Flextech Inc."

This is the **official vendor API** — distinct from the private web API our
Worker uses. Recorded in full here because its docs confirm semantics we rely on
and hint at fixes for our upload path. See the "why we keep the private web API"
section at the end.

> Quirk to watch: the docs name the auth param `access_token`, but almost every
> example query string passes `access_tokens` (plural) — usually twice. Treat the
> correct name as `access_token`; the examples are copy-paste-broken.

---

## 1. Authorization Code Mode

### 1.0 Overall process

- Vendor provides: application name, product logo, and URL schemes for the
  Android and iOS clients.
- Vendor **applies for** `client_id`, `client_secret`, and a `private_secret`
  (the private key used in the token `sign`).
- Guide the user to TeraBox's hosted login/authorization page (1.1–1.3).
- On success the callback returns an authorization **`code`**; exchange it
  server-side (1.4) for `access_token` + `refresh_token`.

### 1.1 Web / Wap integration

Open the auth page in an `<iframe>`:

```
https://www.terabox.com/wap/outside/login?clientId=XXX
```

Receive the code via `postMessage`; the payload is JSON with
`event === "teraboxOauth"`:

```html
<iframe src="https://www.terabox.com/wap/outside/login?clientId=XXX"
        style="width:375px;height:667px;position:fixed;top:10px;left:50%;transform:translateX(-50%)"></iframe>
```

```js
window.addEventListener('message', function (e) {
  try {
    const postData = JSON.parse(e.data);
    if (postData.event === 'teraboxOauth') {
      // authorization code is in postData
      finishAuth();
    }
  } catch (err) { console.log('postmessage error', err); }
});
```

### 1.2 Android integration

Browser Intent to:

```
https://www.terabox.com/wap/outside/login?clientId=XXX&isFromApp=1
```

```java
Intent browserIntent = new Intent(Intent.ACTION_VIEW,
    Uri.parse("https://www.terabox.com/wap/outside/login?clientId=XXX&isFromApp=1"));
startActivity(browserIntent);
```

Manifest intent-filter — scheme `yourAppName`, host `teraboxOauth`:

```xml
<data android:scheme="yourAppName" android:host="teraboxOauth" />
```

Handle the returned URI in the Activity's `onNewIntent` → `handleIntent`.

### 1.3 iOS integration

- Add a URL Scheme `appname://teraboxOauth` (Xcode → target → Info → URL Types).
- Open the auth page with `SFSafariViewController`:
  `https://www.terabox.com/wap/outside/login?clientId=XXX&isFromApp=1`
- In `application(_:open:options:)` (Swift) / `application:openURL:options:`
  (ObjC): if `url.host == "teraboxOauth"`, dismiss the Safari VC and read the
  `code` query item.

### 1.4 Server integration

`code` → `access_token` → **domain discovery** (`/oauth/tokeninfo`) →
call basic-capability services (section 3). When the `access_token` expires,
refresh with the `refresh_token`.

#### 1.4.2.1 Exchange code for access_token — `POST /oauth/gettoken`

Also used by **device code mode**: poll continuously with `device_code`; once the
user scans the QR in the TeraBox app, it returns an `access_token`.

| Param | Type | Required | Description |
|---|---|---|---|
| `client_id` | string | yes | AppKey (applied in advance) |
| `client_secret` | string | yes | SecretKey (applied in advance) |
| `grant_type` | string | yes | `authorization_code` (code mode) or `device_code` (device mode) |
| `code` | string | yes | code-mode: the callback `code`; device-mode: the `device_code` |
| `timestamp` | int64 | yes | current Unix seconds |
| `sign` | string | yes | `md5("client_id"+"timestamp"+"client_secret"+"private_secret")` |

```bash
curl -X POST 'https://www.terabox.com/oauth/gettoken' \
  --form 'client_id="WjY6kfSKgwKB3Ow7jdalGmB"' \
  --form 'client_secret="VPgfmrat8UBM5kgUemwRVmr5AjhFuEV"' \
  --form 'grant_type="authorization_code"' \
  --form 'code="57mYYcfS9f"' \
  --form 'timestamp=1705570481' \
  --form 'sign="asdkkk711UAAK"'
```

Response: `data.access_token`, `data.refresh_token`, `data.expires_in` (seconds).
`expires_in` = `172800` (2 days).

| Error | Meaning |
|---|---|
| `2` | required parameters missing |
| `100001` | invalid `client_id` or `client_secret` |
| `100002` | invalid / expired `code` |
| `200001` | unsupported `grant_type` |
| `300001` | exchanging code→token too frequently |
| `400001` | device_code not yet authorized (device mode) |
| `500001` | internal service exception |

#### 1.4.2.2 Token info — `POST /oauth/tokeninfo`

Different users may be served by **different domains**, so after getting the
token you must resolve its domains. Cache the result **≤ 1 h**; domains rarely
change.

| Param | Type | Required | Description |
|---|---|---|---|
| `access_token` | string | yes | the token |

Response:

| Field | Type | Description |
|---|---|---|
| `data.client_id` | string | API key the token belongs to |
| `data.api_domain` | string | domain for **all** basic-capability APIs **except** `superfile2` |
| `data.upload_domain` | string | domain for the shard-upload API `/rest/2.0/pcs/superfile2` |
| `data.expires_in` | int | token lifetime (seconds) |
| `data.create_time` | int64 | token creation (Unix seconds) |
| `data.user_id` | int64 | the authorized user's unique id |

| Error | Meaning |
|---|---|
| `2` | missing params |
| `100001` | invalid `client_id`/`client_secret` |
| `200002` | invalid `access_token` |
| `200003` | expired `access_token` |

#### 1.4.2.3 Refresh — `POST /oauth/refreshtoken`

Both modes support refresh. Returns a new `access_token` **and** a new
`refresh_token`.

- Each `refresh_token` is **single-use** (refresh consumes it; you must keep the
  newly returned one).
- After a successful refresh, the **previous `access_token` expires in 15 s**.
- The new `refresh_token` keeps the same expiry as the old one.

| Param | Type | Required | Description |
|---|---|---|---|
| `client_id` | string | yes | AppKey |
| `client_secret` | string | yes | SecretKey |
| `refresh_token` | string | yes | the current refresh_token |
| `timestamp` | int64 | yes | current Unix seconds |
| `sign` | string | yes | same rule as `gettoken` |

| Error | Meaning |
|---|---|
| `2` | missing params |
| `100001` | invalid `client_id`/`client_secret` |
| `200004` | invalid `refresh_token` |
| `200005` | expired `refresh_token` |

### Token lifetimes (summary)

| Item | Lifetime |
|---|---|
| `access_token` | **2 days** (`expires_in` 172800) |
| `refresh_token` | **30 days** |
| authorization `code` | **5 minutes**, single-use (code mode) |
| `refresh_token` | single-use per refresh |

---

## 2. Device Code Mode

Host: `www.terabox.com`. Users must log in on the TeraBox **app** and scan the
QR; a **VPN is required** to log in to the app.

### Flow

1. `GET /oauth/devicecode` → device code + QR.
2. User scans the QR in the app.
3. Poll `POST /oauth/gettoken` with `grant_type=device_code` and the
   `device_code` until it returns an `access_token`.
4. Resolve domains via `/oauth/tokeninfo`; then call basic capabilities.
5. Refresh via `refresh_token` when needed.

### `GET /oauth/devicecode`

| Param | Type | Required | Description |
|---|---|---|---|
| `client_id` | string | yes | AppKey |

```bash
curl -L -X GET 'https://www.terabox.com/oauth/devicecode?client_id=WjY6kfSKwKB3alGmB'
```

Response:

| Field | Type | Description |
|---|---|---|
| `data.device_code` | string | device code; exchanges for a one-time access_token |
| `data.qrcode_url` | string | QR code as a base64 PNG data-URI |
| `data.expires_in` | int | device_code lifetime (e.g. `300`); cannot exchange after |
| `data.interval` | int | polling interval (e.g. `2` s); attempts should be < expires_in/interval |
| `data.user_code` | string | **currently not available** |
| `data.verification_url` | string | **currently not available** |

| Error | Meaning |
|---|---|
| `2` | missing params |
| `100001` | invalid `client_id` |

---

## 3. Basic Capability Integration

### 3.1 Description

1. Offline environment uses HTTP; online uses HTTPS.
2. Request domain comes from `/oauth/tokeninfo`: `upload_domain` for the
   sharded-upload API `/rest/2.0/pcs/superfile2`; **`api_domain` for everything
   else**.
3. File paths are confined to a fixed sandbox prefix. Docs state two variants:
   - `/From: Other Applications/Application Name-/`
   - (list API) `/From: Other Device/Application Name - Assigned Application ID/`

### 3.2 User basic information

#### 3.2.1 `GET /openapi/uinfo?access_tokens=...`

| Field | Type | Description |
|---|---|---|
| `uname` | string | nickname |
| `avatar_url` | string | avatar URL |
| `vip_type` | int | `0` regular, `1` Premium, `2` Super Premium |
| `uk` | int | user id |
| `use_type` | int | external-link activation: `0` not activated, `1` activated |
| `user_type` | int | `0` new user, `1` old user |

#### 3.2.2 External link share activation — `GET /openapi/active?access_tokens=...`

Response on success: `errno=0` and `order_id` (numeric string).

### 3.3 Capacity

#### `GET /openapi/api/quota?access_tokens=...`

| Field | Type | Description |
|---|---|---|
| `total` | uint64 | total space, bytes |
| `used` | uint64 | used space, bytes |

### 3.4 File related

Upload is **3 steps**: pre-upload (precreate) → shard upload (superfile2) →
create (merge).

#### 3.4.1 Pre-upload — `POST /openapi/api/precreate`

| Param (body) | Type | Required | Description |
|---|---|---|---|
| `autoinit` | int | yes | fixed `1` |
| `block_list` | string | yes | JSON array of per-shard MD5s |
| `path` | string | yes | absolute target path after upload |

Response:

| Field | Type | Description |
|---|---|---|
| `path` | string | absolute path |
| `uploadid` | string | upload id |
| `return_type` | int | `1` = not present in cloud; `2` = already present (upload done) |
| `block_list` | []string | indices of shards still to upload (0-based); empty ⇒ `[0]` |

#### 3.4.2 Shard upload — `POST /rest/2.0/pcs/superfile2`

Host from `upload_domain`. Notes:

- Each shard must be **> 4 MB**, else error.
- Shard order must match `block_list` from precreate (for correct merge).
- `partseq` starts at 0.

| Param | Type | Required | Description |
|---|---|---|---|
| `method` | string | yes | fixed `upload` |
| `app_id` | int | yes | fixed **`250528`** |
| `path` | string | yes | absolute path |
| `uploadid` | string | yes | upload id |
| `partseq` | int | yes | shard index, from 0 |
| `file` (body) | binary | yes | shard bytes |

Response: `md5` (this shard), `uploadid`, `partseq`.

#### 3.4.3 File creation — `POST /openapi/api/create`

| Param (body) | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | absolute path |
| `size` | int64 | yes | file size |
| `uploadid` | string | yes | upload id |
| `block_list` | []string | yes | JSON array of shard MD5s (must match precreate) |
| `rtype` | int | yes | naming policy: `0` fail on conflict; `1` rename on conflict (default); `2` rename only if block_list differs; `3` overwrite |

Response: `fs_id`, `md5` (files only), `server_filename`, `category`
(`1` video, `2` audio, `3` image, `4` document, `5` application, `6` other,
`7` seed), `path`, `size`, `ctime`, `mtime`, `isdir`, `from_type`.

#### 3.4.4 File management — `POST /openapi/api/filemanager`

| Param | Type | Required | Description |
|---|---|---|---|
| `access_tokens` | string | yes | auth credential |
| `opera` | string | yes | `copy` / `move` / `rename` / `delete` |
| `async` | int | no | `0` sync (default), `1` adaptive, `2` async |

Body `filelist`:

```
copy:   [{"path":"/hello/test.mp4","dest":"","newname":"test.mp4"}]
move:   [{"path":"/test.mp4","dest":"/test_dir","newname":"test.mp4"}]
rename: [{"path":"/hello/test.mp4","newname":"test_one.mp4"}]
delete: ["/test.mp4"]
```

Response: `info[]` (empty when `async=2`), `taskid` (only when `async=2`).

Errors: `-7` invalid file name, `-8` file already exists, `-9` file doesn't exist.

#### 3.4.5 File list — `GET /openapi/api/list`

| Param | Type | Required | Description |
|---|---|---|---|
| `access_tokens` | string | yes | auth credential |
| `path` | int | yes | **pagination number** (per docs) |
| `num` | int | yes | items per page |
| `dir` | string | yes | absolute path under the sandbox prefix |
| `order` | string | no | `time` / `name` / `size` (dirs have no size) |
| `desc` | int | no | `1` desc, `0` asc |
| `web` | int | no | `1` includes `thumbs` |

Response `list[]` items: `category`, `fs_id`, `md5`, `local_ctime`,
`local_mtime`, `server_ctime`, `server_mtime`, `server_filename`, `size`,
`isdir`, `path`, and (when `web=1`) `thumbs.{url1(140x90),url2(360x270),url3(850x580),icon}`.

#### 3.4.6 File information — `GET /openapi/api/filemetas`

| Param | Type | Required | Description |
|---|---|---|---|
| `access_tokens` | string | yes | auth credential |
| `target` | []string | yes | absolute paths, comma-separated; `/` URL-encoded (e.g. `%2FFrom%EF%BC%9A...`) |
| `dlink` | int | no | `0` no (default), `1` include download address (URL-decode it) |

Response `info[]`: `category`, `fs_id`, `md5`, `local_ctime`, `local_mtime`,
`server_ctime`, `server_mtime`, `filename`/`server_filename`, `size`,
`duration`, `height`, `width` (video), `isdir`, `path`, `extra_info`,
`dlink`, `thumbs.*`.

#### 3.4.7 File search — `GET /openapi/api/search`

| Param | Type | Required | Description |
|---|---|---|---|
| `access_tokens` | string | yes | auth credential |
| `key` | string | yes | filename to search |
| `order` | string | no | sort by time |
| `page` | int | no | page, from `1` |
| `num` | int | no | per page, default `100`, max `10000` |
| `desc` | int | no | `0` asc, `1` desc |
| `recursion` | int | yes | pass `1` |

Response: `has_more` (0/1), `list[]` (`fs_id`, `path`, `server_filename`,
`size`, `server_mtime`, `server_ctime`, `local_mtime`, `local_ctime`, `isdir`,
`category`, `md5`).

#### 3.4.8 File download — `GET /openapi/api/download`

| Param | Type | Required | Description |
|---|---|---|---|
| `access_tokens` | string | yes | auth credential |
| `fidlist` | []uint64 | yes | file IDs, comma-separated, e.g. `[868541097022780,641518032743348]` |
| `type` | string | yes | fixed `dlink` |

Response `dlink[]`: `{ fs_id, dlink }`. **To download, append
`access_tokens=...` to the returned dlink** (it already carries `expires=1h`).

#### 3.4.9 Online playback — `GET /openapi/api/streaming`

| Param | Type | Required | Description |
|---|---|---|---|
| `access_tokens` | string | yes | auth credential |
| `path` | string | yes | absolute path |
| `type` | string | yes | video: `M3U8_AUTO_480` / `720` / `1080`; audio: `M3U8_MP3_128` |

Response: an M3U8 playlist of CDN shard URLs.

### 3.5 Share related

#### 3.5.1 Verify extraction code — `POST /openapi/share/verify`

| Param | Type | Required | Description |
|---|---|---|---|
| `access_tokens` | string | yes | auth credential |
| `surl` | string | yes | the `-xxx` part after `/s/1` |
| `pwd` (body) | string | yes | 4 chars, digits + lowercase |

On success the response sets **`Set-Cookie: BOXCLND`** — save it (used later as
`spd`/`sekey`). Body also returns `randsk` (encrypted extraction code).

Errors: `-12` wrong extraction code, `105` external link error.

#### 3.5.2 Share details — `GET /openapi/api/shorturlinfo`

| Param | Type | Required | Description |
|---|---|---|---|
| `access_tokens` | string | yes | auth credential |
| `shorturl` | string | yes | the part after `/s/` |
| `root` | int | yes | fixed `1` |
| `spd` | string | yes | the `BOXCLND` value from `share/verify` |

Response: `shareid`, `uk`, `fcount`, `vip_type`, `share_username`,
`head_url`, `expiredtype`, `list[]` (files). Error `-9`: bad `spd`.

#### 3.5.3 Query share file list — `GET /openapi/share/list`

Either `dir` or `root` must be passed. `root=1` ⇒ root dir (omit `dir`).

| Param | Type | Required | Description |
|---|---|---|---|
| `access_tokens` | string | yes | auth credential |
| `shorturl` | string | yes | the `xxx` part after `/s/1` |
| `page` | int | yes | page (effective only when `dir` is not root) |
| `num` | int | yes | items per page |
| `sekey` | string | yes | the `BOXCLND` value |
| `root` | int | no | `1` for root |
| `dir` | string | no | share subdirectory (empty = first level) |
| `order` | string | no | `asc` / `desc` (default desc) |
| `by` | string | no | `time` / `name` / `size` (default name) |

Response: `share_id`, `uk`, `list[]` (same fields as §3.4.5).

#### 3.5.4 Copy share files — `POST /openapi/share/transfer`

| Param | Type | Required | Description |
|---|---|---|---|
| `access_tokens` | string | yes | auth credential |
| `shareid` | uint64 | yes | share ID |
| `from` | uint64 | yes | the sharer's UK |
| `async` | int | yes | `0` sync, `1` intelligent async, `2` async (recommended) |
| `ondup` | string | no | conflict action: `fail` or `newcopy` |
| `sekey` | string | yes | the `BOXCLND` value |
| `fsidlist` (body) | text | no | JSON list of fsids **or** `filelist` |
| `filelist` (body) | text | no | JSON list of paths **or** `fsidlist` |
| `path` (body) | text | no | destination dir (default root) |

Response: `data.task_id` (0 for sync), `data.tkbind_errno`, `info[]`,
`quantity_limit`.

#### 3.5.5 Share playback — `GET /openapi/share/streaming`

| Param | Type | Required | Description |
|---|---|---|---|
| `access_token` | string | yes | auth credential |
| `shareid` | uint64 | yes | share ID |
| `type` | string | yes | same stream types as §3.4.9 |
| `fid` | uint64 | yes | file ID |
| `channel` | string | yes | fixed `dubox` |
| `uk` | uint64 | yes | user encrypted uid |
| `clienttype` | int | yes | fixed `0` |
| `sekey` | string | yes | the `BOXCLND` value |

Response: M3U8.

#### 3.5.6 Share video metadata — `GET /openapi/share/mediameta`

| Param | Type | Required | Description |
|---|---|---|---|
| `access_token` | string | yes | auth credential |
| `clienttype` | string | yes | fixed `0` |
| `uk` | string | yes | user encrypted uid |
| `shareid` | uint64 | yes | share ID |
| `fid` | uint64 | yes | share file ID |
| `sekey` | string | yes | the `BOXCLND` value |

Response: `duration`, `height`, `width`, `rotate`.

#### 3.5.7 Share file download — `GET /openapi/share/download`

| Param | Type | Required | Description |
|---|---|---|---|
| `access_token` | string | yes | auth credential |
| `shareid` | uint64 | yes | share ID |
| `fid_list` | []uint64 | yes | file IDs to download |
| `uk` | uint64 | yes | user UK |
| `sekey` | string | yes | the `BOXCLND` value |

Response: `shareid`, `uk`, `sign`, `list[]` (fields as §3.4.5 plus `dlink`).

---

## Endpoint index

| Purpose | Method | URL |
|---|---|---|
| Device code (QR login) | GET | `https://www.terabox.com/oauth/devicecode` |
| Token exchange | POST | `https://www.terabox.com/oauth/gettoken` |
| Token refresh | POST | `https://www.terabox.com/oauth/refreshtoken` |
| Token info (domains) | POST | `https://www.terabox.com/oauth/tokeninfo` |
| Web/Wap auth page | GET | `https://www.terabox.com/wap/outside/login?clientId=XXX` |
| User info | GET | `https://www.terabox.com/openapi/uinfo` |
| External-link activation | GET | `https://www.terabox.com/openapi/active` |
| Quota | GET | `https://www.terabox.com/openapi/api/quota` |
| Pre-upload (precreate) | POST | `https://www.terabox.com/openapi/api/precreate` |
| File creation | POST | `https://www.terabox.com/openapi/api/create` |
| File management | POST | `https://www.terabox.com/openapi/api/filemanager` |
| File list | GET | `https://www.terabox.com/openapi/api/list` |
| File metadata | GET | `https://www.terabox.com/openapi/api/filemetas` |
| Search | GET | `https://www.terabox.com/openapi/api/search` |
| Download | GET | `https://www.terabox.com/openapi/api/download` |
| Online playback | GET | `https://www.terabox.com/openapi/api/streaming` |
| Shard upload | POST | `{upload_domain}/rest/2.0/pcs/superfile2` |
| Share: verify code | POST | `https://www.terabox.com/openapi/share/verify` |
| Share: details | GET | `https://www.terabox.com/openapi/api/shorturlinfo` |
| Share: file list | GET | `https://www.terabox.com/openapi/share/list` |
| Share: transfer | POST | `https://www.terabox.com/openapi/share/transfer` |
| Share: streaming | GET | `https://www.terabox.com/openapi/share/streaming` |
| Share: mediameta | GET | `https://www.terabox.com/openapi/share/mediameta` |
| Share: download | GET | `https://www.terabox.com/openapi/share/download` |

(The examples use several mirror hosts interchangeably — `www.terabox.com`,
`www.terabox.app`, `c-jp.terabox.com`, `d.terabox.com` — and the thumbnails show
CDN mirrors `data.terabox.com`, `data.1024tera.com`, `data.4funbox.com`.)

---

## Facts that matter for this project

1. **Upload host discovery.** The official flow gets the `superfile2` domain from
   `upload_domain` in `/oauth/tokeninfo` (all other APIs use `api_domain`); cache
   ≤ 1 h. Our web-API equivalent `/rest/2.0/pcs/file?method=locateupload` is
   **not** covered by the docs — it is the browser flow and currently answers
   `400141` from Cloudflare egress IPs (see `docs/live-testing.md`).
2. **`app_id` = `250528`** — docs: shard-upload param "Fixed to 250528".
3. **Sharding rules.** Multi-shard uploads require each shard **> 4 MB**; shard
   order must match the `block_list` returned by precreate; `partseq` starts at
   0. `superfile2` returns per-shard MD5 + uploadid + partseq.
4. **`rtype` semantics confirmed**: `0` fail on conflict, `1` rename on conflict,
   `2` rename only if block_list differs, `3` overwrite. Our `createFile()` maps
   `overwriteMode > 3 → rtype 1` like bclone.
5. **OAuth available**: `authorization_code` and `device_code` (QR) flows.
   `access_token` valid **2 days**, `refresh_token` **30 days**, refresh
   single-use, old token dies 15 s after refresh. Requires a registered app
   (`client_id`/`client_secret` + `private_secret` for the `sign`).
6. **Official API namespace constraint**: file paths are confined to a
   `/From: Other Applications/Application Name-/` sandbox — the official API
   cannot see or serve the account's real drive tree. **Our cookie-based approach
   remains the right design for a full-drive WebDAV mirror.**
7. **Share flow requires a `BOXCLND` cookie** obtained from `share/verify`; it is
   then passed as `spd` / `sekey` on every subsequent share call. Not returned by
   the JSON body — it is a response header.
8. **No documented rate limits.** The only frequency-related error is
   "exchanging the code for the access_token is too high" (`300001`). Empirical
   probing of the web API (see `docs/live-testing.md`) found no 429 up to 32 rps.
9. **Sign rule** (tokens): `md5(client_id + timestamp + client_secret + private_secret)`.

## Why we keep the private web API

| | Private web API (ours) | Official OpenAPI |
|---|---|---|
| Auth | session `ndus` cookie + `jsToken` | OAuth `access_token` |
| Drive visibility | full account tree | app sandbox folder only |
| Setup | paste a cookie | app registration + user consent |
| Stability risk | API drift, verification (400141) | documented, versioned |

Fallback idea if cookie auth collapses long-term: register an app, OAuth the
account, serve WebDAV rooted at the app sandbox folder.
