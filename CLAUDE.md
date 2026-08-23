# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WebUI for [OpenIPC Firmware](https://github.com/openipc/firmware) — served on port 80 of the camera by an embedded httpd that runs `haserl` CGI scripts. There is no compile step, no package manager, no test suite. "Building" means copying the tree onto a running camera.

Authentication is HTTP Basic against `/etc/shadow` (user `root`, default password `12345`); `common.cgi:check_password` forces a redirect to `fw-interface.cgi` until the default password is changed.

**Session cookies (browser auth).** Majestic (the daemon serving port 80) also mints a `session` cookie so that browser flows Basic composes badly with — most visibly **WebSocket handshakes in Safari**, which never carry a Basic credential — keep working. The pieces:

- `www/login.html` — a **self-contained** login page (inline CSS/JS; it can't pull `/a/*` because those need auth). It `POST`s `username`/`password` to majestic's `/login`, which validates against `/etc/shadow` and returns `Set-Cookie: session=…; HttpOnly; SameSite=Strict`. On success it redirects to the sanitised `?next=` path (default `status.cgi`).
- Majestic redirects an **unauthenticated browser navigation** (a `GET` that `Accept`s `text/html` and isn't a WS handshake) to `/login.html?next=…` instead of answering `401 WWW-Authenticate: Basic`, so the native Basic dialog never pops. `curl`/CLI/XHR/WebSocket requests still get the `401`+Basic challenge, so scripted access is unchanged. It also auto-mints the cookie on any successful **root** Basic auth, so a client that still sends Basic transparently gets a session too.
- The cookie rides every later request (same-origin `fetch` with `credentials: 'same-origin'`, and — the whole point — the three WebSocket handshakes `/ws/{upgrade,video,logs}`).
- **Sign out** — a nav item in `p/header.cgi` (`#nav-logout`), wired in `main.js` to `POST /logout` (invalidates the server session) then navigate to `/login.html`.

This is a majestic-side feature; the WebUI just provides the login page and the logout control. Older majestic builds without the `/login` cookie path fall back to plain Basic (the WS flows then fail only in Safari, as before).

## Deploying / running

- `sbin/updatewebui [branch]` — fetches a branch zip from GitHub, wipes `/var/www`, then copies `sbin/*` → `/usr/sbin` and `www/*` → `/var/www`. This is the canonical "deploy from source" path. Default branch is `master`.
- Edits to a running camera can also be made directly under `/var/www/cgi-bin/` and `/usr/sbin/`.
- There is no local way to run the UI off-camera — every script assumes camera-side binaries (`majestic`, `yaml-cli`, `ipcinfo`, `fw_printenv`, `haserl`, `jsonfilter`, `jshn.sh`, `chpasswd`, `sysupgrade`).

## Architecture

### Request lifecycle (`www/cgi-bin/*.cgi`)

Every page CGI follows the same skeleton:

```
#!/usr/bin/haserl
<%in p/common.cgi %>           # helpers + sysinfo + auth gate
<% page_title="..."; ...POST handling... %>
<%in p/header.cgi %>           # <html>, nav, signature bar, flash messages
...page body using field_* / ex / button_submit helpers...
<%in p/footer.cgi %>
```

POST handlers in the same file write config, then `redirect_back`/`redirect_to` (303) with a flash message stored in `/tmp/webui/logfile.txt` and rendered by `log_read` on the next page load.

### Common helpers — `www/cgi-bin/p/common.cgi`

This is the most important file to read before editing anything. It defines:

- **Form field DSL**: `field_text`, `field_string` (with optional `enum`), `field_integer`, `field_range`, `field_switch`, `field_password`, `field_textedit`, `field_hidden`, `button_submit`, `label`. Pass `"eval"` as the value to make the helper read `$name` from the env.
- **System info bootstrap**: `update_caminfo` populates `/tmp/webui/sysinfo.txt` (`soc`, `sensor`, `flash_size`, `fw_version`, `network_*`, `tz_*`, `ptz_support`, ...). This file is sourced on every request, so call `update_caminfo` after any change that affects those values (network, MAC, timezone).
- **Flash messages**: `log_create class msg`, `log_read`, `set_error_flag msg`, `redirect_back`, `redirect_to`.
- **Majestic glue**: `get_config [prefix]` → `${prefix}/etc/majestic.yaml`; `get_schema` caches `/api/v1/config.schema.json` at `/tmp/webui/schema.json`; `get_metrics name` and `get_night key` hit `localhost/metrics/...` / read `yaml-cli`.
- **Output sanitisers**: `ex "cmd"` and `pre "text"` are the only safe ways to render shell output — they HTML-escape `& < > "`. Use them whenever you echo anything user- or device-derived.

### Persistent state — paths to remember

- `/etc/majestic.yaml` — Majestic config (edited via `yaml-cli -g/-s/-d`, never directly).
- `/etc/webui/webui.conf` — UI theme.
- `/etc/webui/{telegram,ntfy,proxy,openwall,vtun,wireguard,backup}.conf` — one per extension, sourced as shell.
- `/etc/network/interfaces.d/{eth0,wlan0}` — written by `sbin/setnetwork` (not by the CGI directly).
- `/etc/crontabs/root` — extensions add/remove their own lines with `sed -i /name/d` then append.
- `/tmp/webui/` — scratch (sysinfo, schema cache, flash log, signature).
- `/tmp/system-reboot` — sentinel file; presence triggers the "restart required" banner in `header.cgi`.
- U-Boot env via `fw_printenv -n` / `fw_setenv` for `ethaddr`, `wlanssid`, `wlanpass`, `upgrade`, `sensor`, `soc`, `gpio_motors`.

### Talking to Majestic

Majestic is the camera daemon and exposes a local HTTP API. Read it, don't reimplement it:

- `localhost/api/v1/config.json` — current config as JSON.
- `localhost/api/v1/config.schema.json` — schema used by `mj-settings.js` (in the browser) to generate the entire settings form dynamically (looping over `properties` and dispatching on `type`).
- `localhost/metrics/...` — Prometheus-style counters and gauges.
- `localhost/image.jpg`, `localhost/image.heif`, `localhost/mjpeg`, `localhost/night/{on,off,toggle,ircut,light}` — used by `preview.cgi` and the notification sbin scripts.
- `POST /api/v1/config` (≤1 MiB JSON body) — batch write. Server walks every leaf via `config_set_universal`, then runs `sdk_reload()` + `config_save()` exactly once. Aborts on first rejected leaf and returns its HTTP code; *no* persistence partial-credit. Used by the Save button in `mj-settings.js`.
- `GET /api/v1/set?<dotted>=<v>` — single-key variant of the above. Same reload + save. Used externally (CLI/webhooks); not currently called by the WebUI but kept compatible.
- `GET /api/v1/reset?key=A[&key=B]` — multi-reset; restores each key to its declared `config_default_*` value, single reload + save, 404 if a key has no recorded default. Used by per-field reset buttons in `mj-settings.js`.
- `killall -1 majestic` — SIGHUP triggers Majestic's `sdk_reload()`. The WebUI doesn't expose this any more because every `/api/v1/{set,config,reset}` already does the same `sdk_reload()` automatically. For hardware re-init that a soft reload can't cover (e.g. codec switch on `video0`), reach for the device-level `fw-restart.cgi`.

#### `mj-settings.cgi` + `a/mj-settings.js` in detail

The settings page is split: `www/cgi-bin/mj-settings.cgi` renders the page chrome server-side (auth gate, nav, tab strip, signature bar) and emits a tiny bootstrap JSON block; `www/a/mj-settings.js` does everything else in the browser. The legacy haserl POST handler (`printenv | grep POST__` + per-key `yaml-cli -g/-s/-d`) is gone — saving goes through majestic's new write-back API.

**Server side — `mj-settings.cgi`.**

1. Pick the section: `label="$GET_tab"`. `?tab=` names a **section** (`isp`, `video0`, the synthetic `live`/`roi`), not a category. Left empty the client lands on the first leaf of the first group; a stale `?tab=<group>` bookmark still resolves to that group's first section.
2. Scrape `j/locale.cgi` with `sed` into the `labels` map the boot blob carries, so the client can title each section. Note `j/locale.cgi` is parsed, *not* sourced: it is a plain `key=value` data file with no shebang, and sourcing it would fail anyway because values like `mj_cloud=Cloud (WebRTC)` are not valid shell.
3. Build a small JSON bootstrap blob:

    ```json
    {"tab":"isp","exclude":["audio.volume",…],"sensors":["/etc/sensors/imx415.bin",…]}
    ```

    - `exclude` ← `www/cgi-bin/j/exclude.lst` (one dotted path per line; the leading `.` is stripped by the haserl).
    - `sensors` ← `find /etc/sensors -maxdepth 1 -type f` (only if the directory exists).
    - Emitted inside `<script type="application/json" id="mj-settings-boot">…</script>`. JS reads it via `JSON.parse(document.getElementById('mj-settings-boot').textContent)`.

4. Emit the page skeleton — two columns: `col-md-3` on the left holding the search box (`#mj-search`, hidden until JS unhides it) above the empty `<ul id="mj-settings-nav">` the tree is built into, and `#mj-settings-form-col` (`col-md-9`) on the right containing `<form id="mj-settings-form">` (JS-managed). On `<md` the columns stack. The rail keeps `col-md-3` at every width rather than narrowing to `col-lg-2`: the tree is two levels deep and needs the room, and `col-md-8` is **not** in the PurgeCSS subset (`tools/purgecss.config.cjs`), so widening the other way would have meant regenerating `bootstrap.min.css`. There is no page-level `<h3>` — one section shows at a time and its card carries its own heading. There is no "Restart Majestic" button — Save already SIGHUPs the daemon via the API.
5. `<script src="/a/mj-settings.js" defer></script>` at the end.

The haserl never reads `/api/v1/config.json`, never calls `yaml-cli`, and never handles a POST — every dynamic value lives in JS.

**Client side — `www/a/mj-settings.js`.**

One IIFE, vanilla JS, no dependencies beyond `fetch` and the boot JSON tag.

1. **Load.** On `DOMContentLoaded`, fetch `/api/v1/config.schema.json` and `/api/v1/config.json` in parallel with `credentials: 'same-origin'` (cached HTTP-Basic creds auto-attach). Cache both in `state`. If either fails (camera down, schema missing, unknown tab), render a fatal alert in place of the form.

2. **Navigation + search.** `buildNav()` renders a two-level tree into `#mj-settings-nav` from the schema's `x-groups`: categories as headings, sections indented and directly selectable. Two leaves are synthetic — `live` (the preview plus the `x-live` knobs lifted out of their sections) and `roi` (the ROI canvas, which owns `motionDetect.roi` because `m/img.html` calls back into `window.mjRoiAdd`/`mjRoiList` and only a mounted field installs those). `#mj-search` filters the tree rather than replacing it: a category whose name matches keeps all of its subsections, otherwise a subsection survives on its own label or on any of its fields' `title`/`hint`/key, with a count of the matches and `<mark>` on the matched run. `visibleWhen`-hidden fields do not count — `fieldVisible()` evaluates the same `visMatches()` rule against `state.config`. On `<md` the categories become a true accordion: all collapsed on load, opening one closes the rest; a query force-expands whatever still matches. Highlighting the open section is done **in place** by `highlightPanel()` over `[data-hl]` — re-rendering the form per keystroke would reset every control and lose unsaved edits.

3. **Render fields.** The page shows exactly **one section**, as a single full-width card whose body is a `.mj-cols` two-column flow. Walk `schema.properties[SECTION].properties`. For each key, build a dotted path `SECTION + '.' + key`, skip if `EXCLUDE.has(dot)`, otherwise dispatch on `type` to match the old `field_*` widget mapping (so existing CSS in `bootstrap.override.css` continues to apply unchanged):

    | `schema.type` | extra condition | widget |
    |---|---|---|
    | `boolean` | — | Bootstrap form switch (`.form-check.form-switch`). |
    | `integer` | `maximum ≤ 100` | `<input type="range">` + live `.show-value` readout. |
    | `integer` | else | `<input type="number">` with `min`/`max`. |
    | `string` | `enum` non-empty | `<select>` of enum values. |
    | `string` | `dot === "isp.sensorConfig"` and boot's `sensors` non-empty | `<select>` of `/etc/sensors/*` paths. |
    | `string` | else | `<input type="text">`. |
    | `number`/`array`/`object` | — | skipped (matches the legacy `case "$type"` dispatch). |

    Each row is wrapped in `<p class="<type> mj-row">` exactly like the old `field_*` helpers emitted. The control and a bare `↺` reset button (`.mj-reset`) then share one flex line, `<span class="mj-ctl"><span class="mj-ctl-in">…control…</span><button class="mj-reset">↺</button></span>` — which is why the width caps live on `.mj-ctl-in` rather than on the control itself, or the glyph would strand at the card edge. The reset button is disabled when the schema has no `default` for that key. Live-panel rows are **not** wrapped: `.mj-live-row.range > .input-group` is a direct-child selector.

4. **Dirty tracking.** After rendering, `state.initial[dot] = field.getValue()` snapshots each control. On every `input`/`change`, `updateDirty()` recomputes which fields differ, toggles a `.mj-dirty` class on the row (left border highlight from `bootstrap.override.css`), updates the toolbar counter, and enables/disables the Save button.

5. **Save.** Submitting the form filters `state.fields` for `getValue() !== initial[dot]`, builds a **nested** JSON tree from the dot paths (`{audio:{volume:"55"}, isp:{sensorConfig:"…"}}`), and `POST /api/v1/config` with `Content-Type: application/json`. That shape is the literal input of majestic's `apply_config_subtree` walker. Values are always sent as strings — `config_set_universal` takes a `const char *` either way and the C-side `json_object_get_string` coerces booleans/numbers transparently. On 200, re-fetch `config.json`, push the new values back into each control, and reset `initial` so the page is clean again. On non-200, surface the body in an inline `.alert-danger` and leave dirty state intact — note that the server aborts at the first rejected leaf, so earlier leaves in the batch did *not* persist.

6. **Reset.** Per-field `↺` button calls `GET /api/v1/reset?key=<dot>` after a `confirm()`. On 200, refresh the config and re-render. On 404, the key has no recorded default — the button gets disabled with an explanatory tooltip.

There is no separate "Restart Majestic" affordance: every `/api/v1/{config,set,reset}` round-trip already calls `sdk_reload()` server-side, so Save *is* the reload. Settings that need true hardware re-init still want the device-level `fw-restart.cgi`.

Why this design holds together:

- **Single source of truth** — the schema majestic ships still drives the form. Adding a new setting to the daemon makes a field appear in the UI with zero WebUI changes.
- **One round-trip per save** — `apply_config_subtree` walks the whole tree, calls `sdk_reload()` + `config_save()` exactly once. The legacy per-key `yaml-cli` loop is gone.
- **No double-encoding** — there's no more `_${section}_${key}` ↔ dot-path string dance; JS uses dot paths end-to-end as object keys, control `id`s (dashes), and URL params.
- **Two escape hatches stay** — `j/exclude.lst` to hide rows, and the `isp.sensorConfig` special-case to fill a select from `/etc/sensors/*` (now driven by `boot.sensors` instead of a server-side `<script>` patch).

When you'd touch this code:

- New section appears in the schema but no tab → add `mj_<section>=<Label>` to `j/locale.cgi` (server reads it for the tab strip).
- New schema `type` to support (`number`, `array`, …) → extend the dispatch in `renderField` (`www/a/mj-settings.js`).
- Hide a specific key for a build → add its dotted path to `www/cgi-bin/j/exclude.lst` (no leading dot needed; the haserl strips one if present).
- Special widget for one property → add a branch in `renderField` keyed off `dot === '<section>.<key>'`, mirroring how `isp.sensorConfig` is handled.
- Change the save URL or batch shape → update both `onSubmit` in `mj-settings.js` and the server-side handler that consumes it.

**Requirement: the camera must run a majestic build with the libyaml writer + `/api/v1/config` POST + `/api/v1/reset` GET.** Older builds will 404 on save; users see the error inline. There is no fallback to the legacy POST flow.

### JSON endpoints — `www/cgi-bin/j/`

Small `#!/bin/sh` scripts that emit JSON for the front-end. `pulse.cgi` is polled every 2s by `main.js:heartbeat` and fills the top bar (SoC temp, memory, overlay, uptime, day/night). `run.cgi` streams the output of a base64-encoded shell command (`cmd=` for trusted local, `web=` adds `timeout 3` for the console page).

### Front-end — `www/a/`

- Pure JS, no framework. `$`/`$$` are `querySelector` wrappers. Don't introduce jQuery or any bundler — the README is explicit about keeping this small.
- Bootstrap 5 (`bootstrap.bundle.min.js`, `bootstrap.min.css`) plus `bootstrap.override.css`.
- `main.js:initAll` runs on `load`: wires `.btn-danger`/`.btn-warning`/`.confirm` to `confirm()`, links `input[type=range]` to a sibling `…-show` and hidden input, makes external links open in a new tab, and starts the heartbeat.
- `main.js:runCmd(msg)` streams `/cgi-bin/j/run.cgi` line-by-line via `fetch`/`ReadableStream` and appends to a `pre#output` element whose `data-cmd` carries the base64-encoded command; used by `fw-reset.cgi` (overlay erase).
- `timezone.js` holds the `TZ` array used by `fw-time.cgi` for the city → `TZ` string mapping.

### FPV variant

The repo serves two flavours of firmware selected by `$fw_variant` (read from `/etc/os-release:BUILD_OPTION`):

In practice the split is much smaller than it looks. **Every** page — `fpv-wfb.cgi` included — uses `p/header.cgi`, `p/common.cgi` and `j/locale.cgi`. `$fw_variant` only drives cosmetics (a `<body>` class and the brand label).

The FPV-specific code is exactly two files:

- `p/fpv_common.cgi` — its own `yaml_get_value`/`yaml_set_value`/`yaml_get_nested` helpers, included by `fpv-wfb.cgi` only.
- `fpv-wfb.cgi` — WFB-NG wireless settings, with legacy `wfb.conf` ↔ YAML compatibility.

`fpv-wfb.cgi` is not linked from any navigation; it is reachable only by URL. The only link to it ever written lived in `p/header_fpv.cgi`, which no page ever included — that file and `j/locale_fpv.cgi` (a variant tab-label set nothing ever read) were removed rather than left to imply a code path that never existed. Git history has them if the FPV nav is ever built for real.

### Extensions (`ext-*.cgi` + `sbin/*`)

Each extension is a CGI for the form + a sbin script invoked by cron or webhook:

- `ext-telegram.cgi` ↔ `sbin/telegram` (image push on motion / on interval).
- `ext-ntfy.cgi` ↔ `sbin/ntfy` (ntfy.sh notifications, reuses `/etc/webui/proxy.conf`).
- `ext-openwall.cgi` ↔ `sbin/openwall`.
- `ext-wireguard.cgi`, `ext-vtun.cgi`, `ext-proxy.cgi`, `ext-backuper.cgi` — VPN / SOCKS5 / config backup.

Each extension's CGI typically: defines a `params` list, loops `POST_<name>` into shell vars, validates, rewrites its single `/etc/webui/<name>.conf`, and `sed -i /<name>/d /etc/crontabs/root` before re-adding the cron line if scheduling is on. Webhooks like `?send=image` short-circuit before `header.cgi` and emit their own `Content-type`.

## Conventions for new code

- **Bash, busybox-flavoured.** No bash-isms unavailable in busybox `ash`/`sh`; the FPV `fpv_common.cgi` uses `#!/bin/sh` semantics throughout. No GNU-only `sed`/`awk` flags.
- **Embedded-friendly front-end.** Vanilla JS, no jQuery, no bundlers, no npm. Use valid HTML5; avoid deprecated tags (per README).
- **Always escape shell output before rendering.** Use `ex` or `pre` from `common.cgi`. Never `<%= $userInput %>` for anything that came from `POST_`/`GET_`/the filesystem.
- **Don't write `/etc/majestic.yaml` directly.** Go through `yaml-cli -g/-s/-d` so Majestic sees a valid file.
- **State that affects the signature bar / banners requires `update_caminfo`** so the cached `/tmp/webui/sysinfo.txt` is regenerated.
- **`structure.md` drifts.** It still references e.g. `ext-tunnel.cgi`; the actual files are `ext-vtun.cgi` and `ext-wireguard.cgi`, and `p/fpv_common.cgi` isn't listed. Treat the directory tree as authoritative, not `structure.md`.
