# The live player, the Live page and PTZ

The contract between the two player implementations, `preview-page.js` and the
modules around them, plus the Live page's stage and the PTZ pad. Each module
also opens with its own reasoning — read that before changing one.

`main.js:initAll` runs on `load`: wires `.btn-danger`/`.btn-warning`/`.confirm`
to `confirm()`, links `input[type=range]` to a sibling `…-show` and hidden input,
makes external links open in a new tab, and starts the 2 s heartbeat.
`main.js:runCmd(msg)` streams `/cgi-bin/j/run.cgi` line-by-line via
`fetch`/`ReadableStream` into a `pre#output` whose `data-cmd` carries the
base64-encoded command. The heartbeat publishes `null`, never `0`, for a gauge
majestic does not emit (`night`/`ircut`/`light`). Sparkline and axis-chart
primitives live in `www/a/charts.js` — **load it before any consumer.**

## The live player

**Two implementations behind one façade.** `preview.js` (`MajesticVideo`, MSE
over `/ws/video`) and `preview-webrtc.js` (`MajesticWebRTC`, WebRTC over
`/ws/webrtc`) return the same object — `setStream`, `requestIdr`, `setAudio`,
`setVolume`, `audioSupported`, `destroy`, `supported` — so `preview-page.js` is
written once and picks a transport at attach time. **WebRTC is the default.**
`preview()` in `p/common.cgi` has exactly one caller, `live.cgi`; `camera.cgi`
does **not** share that markup — its live tab is built client-side by
`renderLive()` in `mj-settings.js` — though it loads all four preview scripts.

- **The chain is WebRTC → MSE → software decode → the caller's floor.** The
  middle step matters: WebRTC negotiates, so it can fail where MSE cannot
  (Firefox's stack offers only H.264 Baseline whatever its decoder can do), and
  a player reporting a failure is asking for the next rung, not for the floor.
  The third rung is **not a transport and gets no radio** — it is the same
  `/ws/video` bytes the MSE player just failed on, decoded in WebAssembly, so a
  transport picker names the transport exactly once and a codec problem never
  touches a remembered preference. Which rungs below MSE are open is decided by
  rules in `preview-transport.js` and read through it, never off the decoder
  module directly, because the tests drive those gates from a stub. **MJPEG is
  the Live page's floor, not a rung**: `onExhausted` is where each caller
  decides, and the settings preview shows an alert instead.
- **The walk is one copy, `preview-chain.js`** — it used to be written in both
  consumers and the same fault fixed once in each. `decide()` is the pure walk;
  `make()` owns the retry timer and a budget refilled **only** by frames a live
  software session actually decoded, never by the codec announcement and never by
  a channel change (#288). Any fresh start cancels a pending retry, and the timer
  needs no generation guard: a cancelled timer cannot fire.
- **What is remembered is split in two.** `mj-transport-pick` is the person's
  explicit choice and is permanent; `mj-transport-auto` is a demotion a failure
  decided for them, timestamped so it expires (6 h), or one bad session parks a
  browser on the slower transport for good. A camera merely out of session slots
  answers `busy`, not `error`, and that is not remembered at all.
- **WebRTC's `?stream=` is a preference, not an order.** The camera states the
  channel it served in a `served` reply; the player adopts it internally (so
  re-picking the fallen-from channel is a real renegotiation, not a no-op) and
  the page treats it as authoritative. On a mismatch against an **explicit** pick
  the radios move **by writing `.checked`, never by firing `change`** —
  `goToStream()` must not re-enter and the remembered preference must stay the
  viewer's own. In Auto nothing moves: nothing was betrayed, and the chip is the
  disclosure.
- **The MSE player seeks for drift, never for lag** (`syncLive` in `preview.js`).
  Seeking whenever the buffer ran ahead of the playhead read a decoder's own
  output delay as latency to cut — Chrome's hardware H.264 path takes its reorder
  window from the SPS, and an SPS with no `bitstream_restriction` gets the level's
  whole DPB, 1.7 s on the level 5.1 1080p an Ingenic T31 emits at ~9 fps, so every
  seek flushed a decoder that had not produced a frame yet. Nothing is seeked
  while the playhead is not advancing; the lag a pipeline runs at is learned from
  its first movement and only drift beyond it is cut; a start refused autoplay
  does not get its waiting learned as pipeline lag.

## The Live page

**Settings-free by design.** It is the page every user of the future multi-user
system gets, read-only, so nothing on it changes the camera — no night/IR/light
toggles (those are `wireNightToggles` in mj-settings' Live section), no control
panels. The one exception is the PTZ pad: steering, not configuration. Every
setting belongs under `camera.cgi` only.

**The picture, and nothing else.** `live.cgi` sets `full_bleed=1`, which asks
`p/header.cgi`/`p/footer.cgi` for a page with no container, card, status strip or
footer: `body#page-live` is a `100dvh` flex column of navbar → banners → stage,
so the stage takes what is left and the page never scrolls. It is the only page
that asks. The strip went because all four of its readings are on the Dashboard,
and every heartbeat writer already guards its `$('#…')`.

`preview-zoom.js` is the view rule — `Fill`, `Fit`, `1:1`, drag pan, pinch and
ctrl+wheel free zoom, double-click for Fit↔Fill, preset remembered in
`mj-view-pick` (one permanent key; nothing here demotes the view behind the
viewer's back the way a failed transport does).

- **Without the module the page is still right**: the media keep the
  stylesheet's `inset: 0` and `object-fit: contain`, which is exactly Fit.
  `preview-page.js` knows it through two guarded calls only (`setFrame`,
  `scalePct`/`refresh`), because that file runs in a bare `vm` in two tests.
- **The chip prints the scale** — Fill enlarges a stream smaller than the screen,
  and a soft picture with no number beside it reads as a soft camera.
- **A drag always does something, and which is decided by whether anything is
  hidden.** `setAffordance()` sets `.mj-pannable` / `.mj-drawable`, mutually
  exclusive by construction; the stylesheet reads them for the cursor and the
  pointer handler for the gesture. In Fit a drag draws a zoom rectangle with no
  control to visit first; zooming in makes the next drag pan, and the cursor
  changing at that moment is the disclosure.
- **Zoom to an area** (`#mj-area`) arms one drag, for drawing while the picture
  *is* pannable. `zoomToRect()` converts to **frame** coordinates before changing
  the scale, since stage pixels mean nothing across that change; a drag under
  `max(16px, 2% of the stage)` in either axis is a slip and zooms nothing; it
  disarms after one drag, because a mode you can forget you are in is the wrong
  thing to leave over a picture that also steers a camera. **Copy this control,
  not a paraphrase of it**, if another section needs a rectangle — the motion
  region editor already does.
- **The wheel zooms; panning is the drag, on every platform and on touch.** One
  input cannot mean pan on a picture that overflows and zoom on one that does not
  without changing meaning under the hand mid-gesture. `ctrl`+wheel stays because
  that is what a trackpad pinch sends; **Esc** disarms, or returns a free zoom to
  the preset in force.
- **Two zooms, and they never share a control, a label or a gesture.** The pad's
  `Zoom · Wide/Tele` drives a motor — it changes the field of view for every
  viewer and for the recording, with no undo; the View group scales pixels in one
  browser. The pad owns the lens, the stage owns the picture, and **pinch never
  reaches the lens on any camera**.

**What the chrome is anchored to.** The stage carries
`--mj-pic-{top,left,right}`, read by the chrome that *annotates* the picture —
chip, stats panel, both toasts — so a letterboxed view does not leave them
floating in the black beside it. The bar and the PTZ pad deliberately do **not**
read them: furniture that jumps when you change zoom is worse than furniture on a
band. One exception, `--mj-pic-top` alone, for a picture too small to carry the
chrome; the horizontal pair is **never** surrendered. Both halves are #302, where
the gate was measured against the chip's own `offsetWidth`, so pressing **Auto** —
which appends the served channel's name — grew the chip by 42%, tripped the gate
and threw every annotation out to the screen's edges with the picture not moving
a pixel. **A threshold that decides where a widget is drawn must never be
measured against what that widget happens to say**: it takes nominals
(`CHIP_W`/`CHIP_H`), while `--mj-chip-h`, which describes the chip rather than
placing it, stays measured. The two toasts hang under that measured height as a
flex stack rather than at fixed offsets, for the same reason.

**Bar conventions.** Every group is black glass and, where it has state, a lit
indicator **with the word that names it** (`Muted`, `Talk`, `Stats`) — a lit dot
alone does not say what is lit. A **segmented picker carries no caption**: its
options say what it is (`Main Sub Auto`, `Fit Fill 1:1`, `WebRTC MSE`) and
`aria-label` says it for a screen reader. The markup is input-behind-a-label,
because the page drives `.checked`/`.disabled` on those inputs and they keep the
groups keyboard-reachable. The bar is one **centred** cluster and stays overlaid
at every width, since it lives inside `.mj-stage` and that is what carries it
into fullscreen; below `md` it scrolls sideways with the icon group
`position: sticky; right: 0`, so fullscreen never falls off the scrollport.

`preview-adapt.js` and `preview-stats.js` are the overlaid readouts; the latter
follows the former's contract exactly — self-contained IIFE, lazy DOM, one
guarded `window.MajesticStats.tick()` from `onStats`, plus `reset()` and
`setOpen()` — and is deliberately comparative, its MSE mode leading with
`≥ buffer + screen` ("player alone; camera and network are invisible over MSE")
and grading from stalls and drops instead of loss and rtt.

**`preview-hero.js` owns the stage chrome** — bar visibility, fullscreen (hidden
on iOS Safari, which lacks the API), snapshot (shown only when `jpeg.enabled`).
It is a separate file for a reason that constrains every addition here:

> **`tests/auto-source.test.js` and `tests/staging.test.js` execute
> `preview-page.js` in a bare `vm`** with a stubbed `$` over an `IDS` list. Any
> new element `preview-page.js` touches must be `$`-guarded and added to **both**
> `IDS` lists, and any new module it needs goes into **both** `SRCS` lists ahead
> of it — the loaders run every file in `SRCS` in order.

### Focus by ear

`focus-ear.js` (the grammar, pure, tested) and `preview-focus.js` (the poll,
the sound, the card). For an installer on a ladder who cannot read a phone:
the camera's focus statistic, polled five times a second from
`/metrics/isp?value=isp_afmetrics` (one number, no auth, answered from the
daemon's memory in about ten milliseconds), becomes beeps that come faster and
higher the closer the reading is to the best it has been, a low note when the
lens has gone past it, and one held tone when it is back on it. Rate and pitch
run over two decades of the ratio logarithmically, because a focus curve is
narrow against the lens's travel.

Three rules, each because the obvious alternative lies:

- **The reference is a ratchet with resets, not a window.** A sliding maximum
  forgets the peak while the installer stands still off it, then holds the tone
  on a soft lens. The resets are the card's *Start over*, the pad's zoom and
  Autofocus (through the `mj-focus-reset` event `preview-ptz.js` dispatches from
  its own `focusReset()`), and an automatic re-base after fifteen seconds under
  half the best, which is a re-zoom by hand on a ladder where no button is
  reachable.
- **A held tone needs a confirmed peak.** The ratio to the best is 1 all the way
  up a first climb, because the best ratchets with every sample. The tone holds
  only once the reading has fallen clearly below the best since it was set, and
  is back within 3% of it, flat, for 1.2 s. A small excess over a confirmed peak
  is the same peak read better (the smoothed reading lags a moving lens), not a
  new one; only a clearly higher reading un-confirms it and earns the chime.
- **Silence is a fact.** No reading for 700 ms silences the sound with a "lost"
  cue; an empty body means the chip has no statistic and the mode switches
  itself off with one toast. A negative reading is how some chips spell "no
  statistic" and reads as absent; zero is a black scene and a reading.

**Part of the picture.** The card's *Area* button borrows the zoom module's
rubber band for one drag: `MajesticZoom.pickRect` arms the stage exactly as the
bar's Area does and hands the rectangle back in the shown stream's pixels
instead of zooming to it, and a click, Esc or an interrupted gesture hand back
nothing, which is the whole frame. The rectangle travels through the camera's
per-stream windows into the ISP frame the focus grid divides (`mj-region.js`'s
map with the group standing in as a stream of its own, since the statistics are
taken ahead of every channel's crop) and is snapped to the cells whose centres
it holds; `focus-area.js` is that arithmetic, pure and tested. From then on the
poll reads `/api/v1/isp/af-zones.json` and feeds the reducer the mean of those
cells' blended sums, leaving out cells with a clipped pixel and cells under 15%
of the grid's median luma, the raw editor's rule. On the lab camera that mean
over every cell is within a percent of the whole-frame number, so the two
sources share a scale; a switch between them resets the reducer regardless. An
outline on the stage shows the cells, not the drag, and follows every pan and
zoom. A rectangle with nothing measurable in it is `null`, which the reducer
hears as no reading (silence, "no reading") while the note says why; it is not
the "no statistic" answer that switches the mode off. The button appears only
once the session's probe has had a usable grid, and a session that ends drops
the rectangle, so every session starts on the whole frame.

The AudioContext is created inside the toggle's own event, before any await,
which is what lets a phone sound at all. `navigator.wakeLock` exists only in a
secure context, so on the plain-http origin most cameras are reached on the
card says once to turn off auto-lock instead. A hidden tab pauses the poll and
ramps the sound out; coming back may need a tap on the card on a phone, and the
card says so. The toggle is unhidden only once the heartbeat has reported the
metric and only where the browser has Web Audio. Neither file is in the two
tests' `SRCS` lists; `preview-page.js` does not know they exist.

## PTZ

`p/motor.cgi` (markup only, hidden) + `preview-ptz.js`, which relocates the
pad(s) into the stage's `#mj-ptz` mount: Pointer Events with capture for
press-and-hold, arrow keys only while the stage itself has focus (the bar's
slider and radios own them otherwise), `apiFetch` to `j/ptz.cgi`.

**Four backends**, detected in `common.cgi:update_caminfo` into `ptz_backend`.
The switch is U-Boot `ptz_control` (#227): `gpio` (`gpio-motors`; pins in
`ptz_gpio`, legacy `gpio_motors` accepted as an alias), `pelco-d`, `pelco-xm`
(the XiongMai near-Pelco UART protocol — same nine verbs and the same pad, its
own framing and checksum), or `motor` (`/usr/bin/motor`; profile in
`ptz_profile`, legacy `ptz` as fallback). **Unset means no PTZ**, exactly like
`none`, so a legacy-configured camera must `fw_setenv ptz_control <method>` once.
`gpio` and `motor` are stepped eight-way pads speaking `j/ptz.cgi?h=&v=`
(validated as small signed ints); `pelco` covers both serial variants — four
directions, zoom and focus, each a fixed timed pulse — speaking
`j/ptz.cgi?act=<verb>` against a **closed whitelist**, because the verb becomes a
frame on a wire and must never pass through raw. `ptz_caps` narrows the pad to
the axes the hardware has (`fw_setenv ptz_caps 'zoom focus'`; unset = all),
sanitised in `update_caminfo`, honoured by `p/motor.cgi` and enforced again in
`j/ptz.cgi` (`stop` always allowed; stepped backends zero the missing component).
**Autofocus** is majestic's engine: with `.isp.autofocus.enabled` true and a focus
axis, `update_caminfo` sets `af_support`, the pelco pad grows an **AF** button,
and `j/ptz.cgi` maps it to `GET /autofocus`.

**The camera owns the Pelco wire** (`mj_ptz` in `p/majestic.sh`):
`POST /ptz?move=<verb>` moves the lens, and a bare `GET /ptz` is the capability
probe deciding whether the pad renders at all — reading what the lens can do is
safe from anywhere, moving it is not. This repo shipped `bin/btzoom` and
`bin/btzoom-xm` until they were deleted for opening the same tty the camera was
already driving for autofocus, behind a `mkdir` lock that cannot make a
three-step movement atomic against another process; on an hi3516ev300 that cost
presses that did nothing for seconds at a time and focus adjustments that undid
themselves. A Pelco camera needs `fw_setenv ptz_control pelco-d` (or `pelco-xm`)
**and** [majestic-af](https://github.com/OpenIPC/majestic-af); without it `/ptz`
answers 503 and the pad says so rather than claiming the camera has no PTZ —
`mj_ptz` keeps *could not ask* apart from a statement about the hardware, the way
`mj_cfg` does. A held button is one continuous move, not a train of pulses: each
request re-arms the camera's auto-stop deadline (`isp.autofocus.pulse`, default
500 ms) and the release sends `act=stop`, with the motor stopping on that
deadline anyway if the release never arrives.

To render either pad without hardware: set the env vars, `touch`+`chmod +x` a
fake binary for the stepped backends, then remove `/tmp/webui/sysinfo.txt`.

## Other subsystems

- **`update.js` says what it observed, and its three sources are not equal
  evidence (#478).** sysupgrade's own markers (`Protected: flashing`,
  `Kernel updated`, `RootFS updated`, `Unconditional reboot`) are latched into
  **sticky** flags, because `recent` is a 512-character rolling window and a
  marker scrolls out of it. The camera's own sentences are the only definitive
  source and end the run at once through the one `stopWaiting()` every early
  ending goes through. The socket closing proves only that the socket closed, so
  a close with neither a flash marker nor the announcement behind it writes
  `--- connection to the camera ended here ---` and no more, and the watch that
  follows says it is waiting *in case* the camera reboots. **`sawFlash === false`
  deliberately does not shorten the wait**, and nothing the camera says is acted
  on once `sawFlash` is set: the eight minutes exist for a flash running unseen,
  and the cost of being wrong is a reader standing beside a camera they have just
  been told is idle. The refusals are an **enumerated** list, not any line
  beginning `ERROR:`, because the transcript is other people's tool output and a
  loose pattern would end a run mid-flash; the one carve-out is a **reattached**
  run. `tests/update-endings.test.js` pins all of it, including the case that must
  never regress: a socket that dies mid-flash still gets the full watch and keeps
  "do not power off".
- **Encrypted recordings are opened in the page, and the crypto is ours.** A
  sealed clip is Common Encryption fragmented MP4, and handed to a browser
  untouched none of it errors — MediaSource takes the init segment, takes the
  fragments, and shows nothing. `mjcrypto.js` writes out SHA-256, HMAC, HKDF,
  PBKDF2, AES-128-CTR and RSA-OAEP because `crypto.subtle` is secure-context only
  and a camera is `http://` on a LAN — the same wall `preview-wasm.js` hits with
  WebCodecs and the microphone with `getUserMedia`. `crypto.getRandomValues` is
  *not* gated that way and is where every salt comes from. Nothing there is a new
  construction, so the only failure mode is transcription, and
  `tests/mjcrypto.test.js` pins every function to the document that defines it —
  three transcription bugs were caught that way, each producing correct-looking
  output. In `mp4crypt.js` **every failure is a refusal rather than a repair**,
  because decrypting *most* of a fragment produces video that plays and is not
  what the camera recorded; the key check value is verified before anything is
  decrypted, which is what makes "that passphrase does not open this recording" a
  sentence instead of a picture of noise. `reckeys.js` holds the private key
  wrapped under an unlock passphrase in this origin's IndexedDB — a convenience,
  not a backup; the PEM taken at generation is the copy that matters.
- **Two clocks, and the page says which one it is printing.** Every second in
  `recordings.js` and `timeline.js` is **camera-local** and must stay that way:
  clips are named by the camera's own strftime, so day folders, the ribbon and
  the clip list are read out of filenames — which is what is on the card and what
  VLC agrees with. The `mj-rec-tz` toggle moves the **printing** only, through the
  local `hhmm`/`clock` wrappers; nothing in the model, the playhead, the selection
  or the export arithmetic ever leaves camera time. Conversion is **per timestamp,
  not per day** (`instantOf(sec)` then `viewerAt()`), because a single offset for
  the whole day is wrong on the two days a year either zone changes and states an
  hour that never existed. The camera's offset comes from `/etc/timezone` via
  `Intl` (`ianaZone()` puts back the underscores `time.cgi` strips), with
  `pulse.cgi`'s `%z` as the fallback. **`state.offsetMs` defaulting to 0 is not a
  camera that reported UTC**: everything the page says out loud about zones is
  gated on `tzUsable()`, and the toggle appears only where the two zones actually
  differ somewhere in the day. Read on another clock a camera day no longer starts
  at midnight, so the whole-day axis is relabelled (`renderHours`) rather than
  using the static `00…24`, and an exported cut is named after what was displayed,
  date included. The mode lives in a module variable, not `localStorage`, which
  throws outright in some privacy configurations. The header's clock is a
  different question answered differently: it is the **browser's**, because
  nothing there is stamped by the camera — device time survives only as
  `#clock-drift`.
- `timezone.js` holds the `TZ` array `time.cgi` uses for the city → `TZ` mapping.
