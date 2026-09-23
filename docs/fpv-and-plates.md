# The FPV variant and the fetched readers

## FPV variant

`$fw_variant` comes from `/etc/os-release:BUILD_OPTION`. In practice the split is
much smaller than it looks: `wfb.cgi` goes through `p/common.cgi` and
`p/header.cgi` like every other page, and `$fw_variant` drives only cosmetics (a
`<body>` class and the brand label). It builds its own labels from `wfb_*`
variables and does **not** read `j/locale.cgi` — that file is read by
`camera.cgi`, `p/player.cgi` and `www/a/preview-page.js`, and nothing else, so
editing it will not move an FPV label.

The FPV-specific code is exactly two files: `p/fpv_common.cgi`, its own
`yaml_get_value`/`yaml_set_value` helpers, included by `wfb.cgi` only; and
`wfb.cgi` itself, WFB-NG wireless settings with legacy `wfb.conf` ↔ YAML
compatibility. `wfb.cgi` is not linked from any navigation and is reachable only
by URL — the FPV nav was never built, and the files that implied one were removed
rather than left to suggest a code path that never existed. Git history has them.

## The plate reader is fetched, and `webui_lpr_base` names a mirror

`lpr-loader.js` is pinned to `lpr-wasm@v0.1.0` and behaves like `raw-loader.js`
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

`raw-loader.js` is pinned to `raw-editor@v0.12.0`, and the pin is part of the
feature rather than housekeeping: v0.11.0 was the first release whose
`mountEditor` reads `plates` at all, v0.11.1 the one whose burst goes through
`?frames=` instead of asking sixteen times, v0.11.2 the one that warns when
Develop is set to a demosaic the reader cannot read through, and v0.12.0 the
one whose Calibrate calls the `baseline()` and `persist()` hooks
`raw-calibrate.js` provides. None of these is a
compile error when pinned too low — they are a Plates tab that takes thirteen
seconds where it should take one, and one that reads a crippled picture in
silence.
