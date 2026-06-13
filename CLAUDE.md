# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WebUI for [OpenIPC Firmware](https://github.com/openipc/firmware) — served on port 80 of the camera by an embedded httpd that runs `haserl` CGI scripts. There is no compile step, no package manager, no test suite. "Building" means copying the tree onto a running camera.

Authentication is HTTP Basic against `/etc/shadow` (user `root`, default password `12345`); `common.cgi:check_password` forces a redirect to `fw-interface.cgi` until the default password is changed.

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

1. Pick the tab: `label="$GET_tab"`, default `system`.
2. Iterate `properties` from `$(get_schema)` (cached at `/tmp/webui/schema.json`), and source `j/locale.cgi` to map each property to its English label. Render the underlined tab strip server-side — sections with no `mj_<key>` label entry are hidden (still how `cloud`/`youtube` are suppressed).
3. Compute `$title` for the active tab — server-rendered as the form column's `<h3>`.
4. Build a small JSON bootstrap blob:

    ```json
    {"tab":"isp","exclude":["audio.volume",…],"sensors":["/etc/sensors/imx415.bin",…]}
    ```

    - `exclude` ← `www/cgi-bin/j/exclude.lst` (one dotted path per line; the leading `.` is stripped by the haserl).
    - `sensors` ← `find /etc/sensors -maxdepth 1 -type f` (only if the directory exists).
    - Emitted inside `<script type="application/json" id="mj-settings-boot">…</script>`. JS reads it via `JSON.parse(document.getElementById('mj-settings-boot').textContent)`.

5. Emit the page skeleton — two columns: a sticky vertical `nav-pills flex-column` on the left (one `<li>` per schema section that has a `mj_<key>` label, with the active class on the current `$label`), and `#mj-settings-form-col` on the right containing `<form id="mj-settings-form">` (JS-managed). On `<md` the columns stack. There is no "Restart Majestic" button — Save already SIGHUPs the daemon via the API.
6. If `$label = motionDetect`, include `p/roi.cgi` after the layout (unchanged from before).
7. `<script src="/a/mj-settings.js" defer></script>` at the end.

The haserl never reads `/api/v1/config.json`, never calls `yaml-cli`, and never handles a POST — every dynamic value lives in JS.

**Client side — `www/a/mj-settings.js`.**

One IIFE, vanilla JS, no dependencies beyond `fetch` and the boot JSON tag.

1. **Load.** On `DOMContentLoaded`, fetch `/api/v1/config.schema.json` and `/api/v1/config.json` in parallel with `credentials: 'same-origin'` (cached HTTP-Basic creds auto-attach). Cache both in `state`. If either fails (camera down, schema missing, unknown tab), render a fatal alert in place of the form.

2. **Render fields.** Walk `schema.properties[TAB].properties`. For each key, build a dotted path `TAB + '.' + key`, skip if `EXCLUDE.has(dot)`, otherwise dispatch on `type` to match the old `field_*` widget mapping (so existing CSS in `bootstrap.override.css` continues to apply unchanged):

    | `schema.type` | extra condition | widget |
    |---|---|---|
    | `boolean` | — | Bootstrap form switch (`.form-check.form-switch`). |
    | `integer` | `maximum ≤ 100` | `<input type="range">` + live `.show-value` readout. |
    | `integer` | else | `<input type="number">` with `min`/`max`. |
    | `string` | `enum` non-empty | `<select>` of enum values. |
    | `string` | `dot === "isp.sensorConfig"` and boot's `sensors` non-empty | `<select>` of `/etc/sensors/*` paths. |
    | `string` | else | `<input type="text">`. |
    | `number`/`array`/`object` | — | skipped (matches the legacy `case "$type"` dispatch). |

    Each row is wrapped in `<p class="<type> mj-row">` exactly like the old `field_*` helpers emitted, plus an inline `↺ reset` button (`.mj-reset`) wired to per-field reset. The reset button is disabled when the schema has no `default` for that key.

3. **Dirty tracking.** After rendering, `state.initial[dot] = field.getValue()` snapshots each control. On every `input`/`change`, `updateDirty()` recomputes which fields differ, toggles a `.mj-dirty` class on the row (left border highlight from `bootstrap.override.css`), updates the toolbar counter, and enables/disables the Save button.

4. **Save.** Submitting the form filters `state.fields` for `getValue() !== initial[dot]`, builds a **nested** JSON tree from the dot paths (`{audio:{volume:"55"}, isp:{sensorConfig:"…"}}`), and `POST /api/v1/config` with `Content-Type: application/json`. That shape is the literal input of majestic's `apply_config_subtree` walker. Values are always sent as strings — `config_set_universal` takes a `const char *` either way and the C-side `json_object_get_string` coerces booleans/numbers transparently. On 200, re-fetch `config.json`, push the new values back into each control, and reset `initial` so the page is clean again. On non-200, surface the body in an inline `.alert-danger` and leave dirty state intact — note that the server aborts at the first rejected leaf, so earlier leaves in the batch did *not* persist.

5. **Reset.** Per-field `↺` button calls `GET /api/v1/reset?key=<dot>` after a `confirm()`. On 200, refresh the config and re-render. On 404, the key has no recorded default — the button gets disabled with an explanatory tooltip.

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

- Standard build uses `p/header.cgi` + `p/common.cgi` + `j/locale.cgi`.
- FPV build includes `p/header_fpv.cgi` + `p/fpv_common.cgi` + `j/locale_fpv.cgi` and surfaces `fpv-wfb.cgi` (WFB-NG wireless settings, with legacy `wfb.conf` ↔ YAML compatibility). When touching FPV pages, keep both code paths working — `fpv_common.cgi` provides its own `yaml_get_value`/`yaml_set_value`/`yaml_get_nested` helpers used by `fpv-wfb.cgi`.

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
