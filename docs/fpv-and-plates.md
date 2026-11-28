# The FPV variant and the fetched readers

## FPV variant

`$fw_variant` comes from `/etc/os-release:BUILD_OPTION`. In practice the split is
much smaller than it looks: `wfb.cgi` goes through `p/common.cgi` and
`p/header.cgi` like every other page, and `$fw_variant` drives only cosmetics (a
`<body>` class and the brand label). It builds its own labels from `wfb_*`
variables and does **not** read `j/locale.cgi` — that file is read by
`camera.cgi`, `p/player.cgi` and `www/a/preview-page.js`, and nothing else, so
editing it will not move an FPV label.

The FPV-specific code is exactly three files: `p/fpv_common.cgi`, its own
`yaml_get_value`/`yaml_set_value` helpers, included by `wfb.cgi` only;
`wfb.cgi` itself, WFB-NG wireless settings with legacy `wfb.conf` ↔ YAML
compatibility; and `a/wfb.js`, its script. They ship only on an image built with
the FPV page (`BR2_PACKAGE_MAJESTIC_WEBUI_FPV`, on by default for the fpv and
wfbng variants), and `sbin/updatewebui` installs them only where `/rom` carries
`p/fpv_common.cgi`. Nothing `<%in`-includes `wfb.cgi`, so unlike `p/motor.cgi`
it can simply be absent. `wfb.cgi` is not linked from any navigation and is reachable only
by URL — the FPV nav was never built, and the files that implied one were removed
rather than left to suggest a code path that never existed. Git history has them.

## Two plate features, and which is which

They are easy to confuse, and people did:

- **Licence plates** (Settings → Events, the `lpr` section): the camera reads
  plates itself, on the NPU, beside object detection -- majestic's `lpr.*`
  keys, infinity6c ultimate images with the plate models. `platesPanel()` in
  `mj-settings.js` puts on that section what nothing else on the camera says:
  what it needs (object detection with vehicles, on another page -- warned
  about from the loaded config), where a read goes (`/api/v1/analytics`,
  `/ws/analytics`, ONVIF metadata, the log, recordings), and the reads
  themselves as they arrive (`mj-plates.js`). The camera publishes a plate
  once per vehicle and takes it back two seconds later, so the panel keeps a
  list rather than showing the latest event, and says the list covers only
  the time the page has been open. The analytics overlay draws a plate's
  number on its vehicle's box.
- **The Plates tab of the raw editor** (below): a person drawing a rectangle
  on a raw frame to set exposure for plates and to try a read in the browser.
  It tunes a camera for plates; it reads nothing on its own.

## The plate reader is fetched, and `webui_lpr_base` names a mirror

`lpr-loader.js` is pinned to `lpr-wasm` v0.1.0 by its commit and behaves like `raw-loader.js`
next door: the **Plates** tab is there on every camera that can serve a raw
frame, and about nine megabytes of model and runtime arrives the first time
somebody uses it. `webui_lpr_base` in `/etc/webui/webui.conf` points a camera at
a mirror of its own:

```sh
echo 'webui_lpr_base="https://mirror.example/lpr-wasm/dist/"' \
    >> /etc/webui/webui.conf
```

`configuredBase()` therefore answers three ways, not two: `undefined` for nothing
configured, and the pinned default is used; a string for a usable base; and
`null` for one it **refuses**, which leaves no reader rather than falling back.
That last case is the one to preserve — a mirror is named precisely when the
public CDN is not wanted, so a typo in the address must not quietly send the
camera there anyway. `tests/lpr-loader.test.js` covers all three.

`raw-loader.js` pins one `raw-editor` release tag, and the pin is part of the
feature rather than housekeeping: every option the WebUI hands `mountEditor`
(`plates`, the Calibrate hooks `raw-calibrate.js` provides, `focus` with its
motor, filter and `liveHref` extras) exists from a particular release on, and a
release pinned too low ignores the option rather than failing. None of these is
a compile error — they are a Plates tab that takes thirteen seconds where it
should take one, a Focus tab that never grows its buttons, or a panel that
reads a crippled picture in silence. The commit that bumps the pin says which
release brought what; bump it in the same change that starts relying on a new
option.
