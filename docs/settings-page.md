# The settings page

The contract between `www/cgi-bin/camera.cgi`, `www/a/mj-settings.js`,
`www/a/mj-tree.js`, `www/a/mj-help.js`, `j/locale.cgi` and `j/exclude.lst`.
No single file's header can carry it, which is why it is written down here.

Split: `www/cgi-bin/camera.cgi` renders the chrome server-side (auth gate, nav,
signature bar) and emits a bootstrap JSON block; `www/a/mj-settings.js` does
everything else in the browser. **The haserl never reads `/api/v1/config.json`,
never reads the configuration any other way, and never handles a POST** — every
dynamic value lives in JS. There is no "Restart Majestic" button either, because
Save *is* the reload.

**Server side.** `?tab=` names a **section** (`isp`, `video0`, the synthetic
`live`), not a category; left empty the client lands on the first leaf of the
first group. Section labels are scraped out of `j/locale.cgi` with `sed` — that
file is **parsed, not sourced**: it has no shebang and values like
`mj_cloud=Cloud (WebRTC)` are not valid shell. The boot blob is

```json
{"tab":"isp","soc":"hi3516ev300","exclude":["audio.volume",…],"sensors":["/etc/sensors/imx415.bin",…]}
```

emitted inside `<script type="application/json" id="mj-settings-boot">`, where
`exclude` ← `www/cgi-bin/j/exclude.lst` (one dotted path per line, leading `.`
stripped), `sensors` ← `find /etc/sensors -maxdepth 1 -type f`, and `soc` ←
sysinfo. Both readers of `soc` — the Day/Night pin map's caption and the pin
sweep — used to read a `window.mjSoc` nothing ever assigned, so the caption was
empty on every camera and the sweep was SoC-blind. The skeleton is two columns:
`col-md-3` left holding `#mj-search` above the empty `<ul id="mj-settings-nav">`,
and `#mj-settings-form-col` (`col-md-9`) holding `<form id="mj-settings-form">`.
The rail keeps `col-md-3` at every width — the tree is two levels deep and needs
the room. There is no page-level `<h3>`: one section shows at a time and its card
carries its own heading.

**Client side.** One IIFE, vanilla JS, no dependencies beyond `fetch` and the
boot tag.

1. **Load.** Fetch `config.schema.json` and `config.json` in parallel with
   `credentials: 'same-origin'`. If either fails, render a fatal alert in place
   of the form.
2. **Navigation and search.** `buildNav()` renders a two-level tree from the
   schema's `x-groups`; which leaf a key lands on is `www/a/mj-tree.js`'s
   decision, reached through thin wrappers (`groups`, `sectionFields`,
   `leafFields`, `lifted`, `absorbed`). `#mj-search` **filters** the tree rather
   than replacing it, with a match count and `<mark>` on the matched run;
   `visibleWhen`-hidden fields do not count (`fieldVisible()` evaluates the same
   rule against `state.config`). Below `md` the categories become a true
   accordion. Highlighting the open section is done **in place** by
   `highlightPanel()` over `[data-hl]` — re-rendering the form per keystroke
   would reset every control and lose unsaved edits, which is why **every
   `[data-hl]` node must stay a text-only leaf**.
3. **Render fields.** One section at a time, as a single full-width card whose
   body is a `.mj-cols` two-column layout. Walk
   `schema.properties[SECTION].properties`, build the dotted path, skip if
   `EXCLUDE.has(dot)`, else dispatch on `type`:

   | `schema.type` | extra condition | widget |
   |---|---|---|
   | `boolean` | — | Bootstrap form switch (`.form-check.form-switch`) |
   | `integer` | `maximum ≤ 100` | `<input type="range">` + live `.show-value` readout |
   | `integer` | else | `<input type="number">` with `min`/`max` |
   | `string` | `enum` non-empty | `<select>` of enum values, each shown by its `x-enum-titles` word where the schema gives it one — a map keyed by value, so the option still posts the token |
   | `string` | `dot === "isp.sensorConfig"` and boot `sensors` non-empty | `<select>` of `/etc/sensors/*` paths |
   | `string` | `x-secret` or `writeOnly` | `<input type="password">` with a Show checkbox wired **in place** (the global toggle in `main.js` ran at load, long before this form existed) |
   | `string` | else | `<input type="text">` |
   | `number`/`array`/`object` | — | skipped |

   Each row is `<p class="<type> mj-row">`, and the control and a bare `↺` reset
   share one flex line: `<span class="mj-ctl"><span class="mj-ctl-in">…control…
   </span><button class="mj-reset">↺</button></span>` — which is why the width
   caps live on `.mj-ctl-in` and not on the control, or the glyph strands at the
   card edge. Reset is disabled where the schema declares no `default`.
   Live-panel rows are **not** wrapped: `.mj-live-row.range > .input-group` is a
   direct-child selector.
4. **Column dealing.** `.mj-cols` is a flex row of two `.mj-col` children and
   `layoutCols()` deals rows between them — it is **not** a CSS multi-column box.
   A column box re-balances whenever content changes height, so every
   `visibleWhen` row that appeared or disappeared re-flowed the section and at
   some widths carried the select being edited across the fold, leaving the
   cursor pointing at nothing (#189). So the deal happens at mount and on a
   debounced `resize`, and **never when a row toggles**. `rowBoxes()` reads each
   visible row's height and margins from its own styles rather than from where
   the last deal put it, so a given width always picks the same cut. The chosen
   cut leaves the taller column shortest and never falls immediately after an
   `<h5>`. Re-dealing re-parents nodes, so `grabFocus`/`restoreFocus` carry the
   focused control and its text selection across. Below `md` the columns stack
   and the deal is skipped. The cost — revealing a large group leaves one column
   long until the next resize — is the trade the issue asked for.
5. **Dirty tracking.** `state.initial[dot] = field.getValue()` at render; every
   `input`/`change` recomputes which differ, toggles `.mj-dirty` on the row, and
   hands the count to `renderToolbar()`. The count line also says what Save will
   cost *before* it is pressed, from `changeCost()`.
6. **Save.** Filter for changed fields, build a **nested** tree from the dot
   paths, `POST /api/v1/config`. Values are always sent as strings; the camera
   coerces. On 200, re-fetch `config.json`, push values back into each control
   and reset `initial`. On non-200, surface the body in an inline `.alert-danger`
   and leave dirty state intact.
7. **Reset.** Per-field `↺` calls `GET /api/v1/reset?key=<dot>` after a
   `confirm()`; on 404 the button is disabled with an explanatory tooltip.

**What a save costs is asked of the camera, not guessed.** `changeCost()` reads
the schema's `x-reload` — the daemon's own classification — and reduces it to
three answers. `none`/`live` are already carried; `service:<name>` and
`channel:<n>` are carried too, in place, with the encoders and their sessions
left running; `pipeline` is the only one the operator is still owed. A bare
`service` or `channel` names nothing to restart, which the daemon answers with a
pipeline rebuild, so the page agrees — and anything unrecognised falls there too,
because a class this page has never heard of is one it cannot claim was carried.
A save that moved only in-place classes offers no button, because there is no
action left to take; only something genuinely pipeline-class sets
`state.applyPending` and shows **Apply now** in the sticky bar next to where Save
just was (a banner at the *top* of the form meant scrolling back up to press it —
#171). Both buttons follow one rule: each is in the bar only while its own action
is available, so with nothing pending there is no bar. `renderToolbar()` toggles
the pieces rather than rebuilding them, or the transient "Saving…"/"Applying…"
labels would be lost mid-flight, and the bar is the form's last child so its
coming and going moves nothing above it. The cost is said there and not per row
because on a HiSilicon build 156 of 202 keys are pipeline-class (#316).

**A cleared pin is sent as `null`, in the same batch as everything else.** The
nightMode pin fields are the one place an empty control means *remove this key*.
`stillSet()` re-reads the refreshed config afterwards and names any coil that is
**still** configured, in the words the map uses and never the config key: a save
that silently failed to disconnect one would state the exact opposite of what the
feature exists to guarantee.

**A field has three texts, and where each goes is the schema's decision.**
`title` is the name beside the control; `hint` is what you need in order to
DECIDE — what it does, what it costs, the unit, the trap — standing alone
underneath; `help` is what you need in order to UNDERSTAND, behind a small
circled `?` so nobody pays for it who did not ask. `www/a/mj-help.js` owns the
rules and `tests/help-fold.test.js` pins them, because every wrong answer
produces a page that looks entirely ordinary. Four constraints that break
silently:

- **The cut is decided by MEASURING the box**, never by counting characters — a
  hint line holds 43 characters at 390px and 63 at 2560px. A height of **zero is
  not "it fits"**: a `display: none` row measures nothing, so `overflows()` has
  three answers and an unmeasurable row is left exactly as it renders.
- The long text carries `hidden="until-found"` so find-in-page reaches it and
  fires `beforematch`, which the page records as the reader opening the fold. It
  needs one `!important`: reboot's `[hidden]{display:none!important}` matches
  `until-found` as readily as a bare `hidden`, and `display: none` takes the text
  out of the find index, so the feature would be silently off.
  `content-visibility: hidden` hides it instead.
- **One mark opens both** hint and help when a row has long versions of each; two
  marks would be a reader choosing which half of an explanation they wanted.
- `foldHints()` must run **after** `layoutCols()` (which decides a column's width)
  and **after** `highlightPanel()` (because `<mark>` carries padding and can
  change a line count), while never CALLING `layoutCols()` — re-dealing the
  columns moves the control under the reader's cursor, which is the whole of
  #189. The `?` is a **sibling** of the hint's `[data-hl]` leaf, never inside it.

**Where a key is drawn is `mj-tree.js`'s decision, and `x-live` does not make
it.** Three rules, pinned by `tests/tree.test.js`: the first group with any
`x-live` key *owns* the synthetic **Live adjustments** leaf, and those keys are
**lifted** onto it beside the picture; a section the leaf lifts more of than it
leaves is **absorbed** and renders its leftovers there with no page of its own; a
section it lifts less of keeps its page and says where the rest went. `x-live` is
the daemon's word for *what the camera can do*; where a control is drawn is this
page's. Treating the flag as a placement rule silently dropped the Bitrate row
from Main stream and Sub stream when majestic began flagging
`video0.bitrate`/`video1.bitrate` live — no error, no gap, found by accident — so
a `tests/tree.test.js` invariant now walks the shipped schema and fails if any
key of any grouped section lands on no leaf or on two.

Four leaves have hand-written renderers, each with its reasoning beside it in
`mj-settings.js`: **Live adjustments** (the picture, the lifted knobs, and the
Orientation group over hidden `mirror`/`flip`/`rotate` fields), **`osd`**
(`renderOsd`; the camera burns the overlay in, so the live picture is the real
thing and placing is a round trip — offsets are written as a **percentage** so
Main and Sub agree, and the template is chips because majestic's specifier switch
returns 0 for an unknown code and silently truncates the rest of the line),
**`motionDetect`** (`renderMotion`, which absorbed the Visual editor, so
`?tab=roi` redirects here rather than 404ing), and **`nightMode`** (the pin map
above its fields). `mountRegions` is shared by the motion and privacy-mask
editors, parameterised by a `words` object and a `gated` flag; what is
deliberately not shared is what the rectangles mean — a motion region says where
to watch, a privacy mask is burned into the stream and is therefore in the
recording and in every other viewer's picture.

**When you'd touch this code:**

- New section in the schema → add `mj_<section>=<Label>` to `j/locale.cgi`. With
  no row the page title-cases the section id, which is right by luck for
  `Analytics` and wrong for `FPV`.
- New schema `type` to support → extend the dispatch in `renderField`.
- Hide a key for a build → add its dotted path to `www/cgi-bin/j/exclude.lst`.
- Special widget for one property → a branch in `renderField` keyed off
  `dot === '<section>.<key>'`, mirroring `isp.sensorConfig`.
- A field's explanation is too long for under the control → that is the daemon's
  `help` tier. Nothing here truncates by meaning; the page only folds by measure.
- **Anything in `renderField` that reads the field's own value → `getValue()` /
  `setValue()`**, which are declared above the widget dispatch and reach
  `control._get`/`._set` on every call. They used to *capture* those hatches,
  which pinned the declaration to the bottom of the function; the `x-requires`
  warning, which paints on mount well above it, then read a `const` in its
  temporal dead zone and threw a `ReferenceError` out of `renderField` — taking
  every field after the annotated one, and the save bar, with it. Keep the
  call-through form: it is what makes where you write a new branch stop
  mattering.
- Change the save URL or batch shape → update both `onSubmit` and the
  server-side handler that consumes it.

## The Live leaf's tone mode

`image.tuning` is a mode, and the two modes **share no controls**. Automatic
shows what the camera is doing and the way to take it back; Manual shows the
presets and the knobs and reports no status. Nothing is on the page in both,
which is the whole of the rule and the reason `toneManual` and `toneAutomatic`
are two lists rather than one list of things to grey out.

The alternative — leave the driven knobs on the page, disabled, with the
camera's number beside them — is half a step, and this page already argues
against it for the Stock button: *a control which cannot be used is not left on
the page looking as though it can*. A greyed slider is exactly that. It was
reported on a camera as "I see both Automatic and Outdoor", which is the same
complaint one control further along: Automatic and Indoor are not alternatives
on one axis, so they are not chips in one row. One control says who is driving;
the others say what look to apply, and they only exist when the answer to the
first is "you do".

**Manual** is the way back, and it is the *only* way back. An earlier revision
also put an "Adjust the picture" button under the status sentence, reasoning
that somebody who came to change the picture should get a thing to press
rather than a thing to notice. It called `handOver()` — the same function,
with the same argument — ten pixels below the Manual option that calls it.
Two controls doing one job on one card is not a second affordance, it is a
question about what the difference is; the unlit half of a two-state control
is already the answer.

The order inside `handOver()` is
load-bearing: seed the knobs from what the camera is holding, *then* switch.
That way the ISP already carries those numbers when the controller lets go and
the picture does not move as the operator takes it. Switching first and seeding
after is a visible jump to the saved values and back. The seeded values stage
like any other edit — the save bar is what says they are not permanent.

What to seed comes from `MajesticToneCheck.KNOBS`, not from what the strip
happens to hold: `isp.dehaze` is one of them and it is drawn in another card
entirely. The reading itself is `lastTone`, kept only while the camera is
actually measuring — paused, those gauges are as frozen as the span beside
them, and seeding from one would hand over a picture from before the operator
started.

### The sentence and the figures under it

Automatic renders a verdict and then the measurement it is a verdict on, and
**no number appears in both**. `describe()` returns the sentence in plain
words; `figures()` returns the four labelled readings — range in use, shadows,
highlights, sensor headroom.

The split is not cosmetic. The sentence used to carry the numbers, and the
state where that mattered most read *"Holding back — stretching further would
clip — 2.1% crushed and 0.3% blown"*. It was reported, correctly, as useless:
it reads as a fault report when the camera has in fact reached the best this
scene allows, it names its failure mode in jargon, and it quotes two shares
against budgets the page does not hold and should not learn. It is now
*"At its limit — as wide as this scene goes without losing detail"*, with the
two shares under it as Shadows and Highlights. A figure repeated two lines
below its own label is furniture, and the sentence that has to carry one
cannot be written in plain words.

The fourth figure is the controller's **headroom**, not a sensor gain.
`isp_again`/`isp_dgain` are raw vendor numbers — Q10 on HiSilicon, another
scale on Ingenic, absent on most parts — so a gain printed here would be a
unit guess that reads as fact on the vendors it is wrong for.
`image_tune_headroom` is the daemon's own vendor-neutral answer to the same
question, derived from both gains, and it is what the controller acts on.

`figures()` gates itself on `describe()`'s `measuring` flag, so a pause empties
the row: PAUSED freezes every gauge at the reading taken before the operator
started, and four real numbers none of which are true any more, under a
sentence saying the camera has stopped looking, is the exact failure the state
exists to prevent. Per gauge the rule is the usual one — absent is left out,
never zeroed — so a part whose AE will not state its gain shows a row of three.

### Manual is a mode; the live `tuning` key is a press

`POST /api/v1/image?tuning=0` is a **momentary preview**, built for the compare
button: it expires after sixty seconds so an abandoned press cannot leave a
camera showing somebody's comparison for ever. Manual is a **mode** and lasts
until the operator leaves it. The daemon cannot tell the two callers apart, so
the page — which can — says which one it is by renewing the preview.

Measured on the lab hi3516ev300: switch to Manual, touch nothing, and at +63 s
the controller took the picture back and began driving it while the page still
said Manual and the sliders still claimed to own it.

`TONE_KEEPALIVE_MS` is 30 s, **half** the daemon's `TONE_HOLD_TICKS`, so the
hold is renewed at its midpoint and never runs out. Renewing on the *lapse*
instead also works — measured, it was back inside one heartbeat — but "works"
there means the controller got one tick of the picture every minute, which is a
visible blip on a camera someone is watching. The lapse test stays as the second
arm and is not redundant: a dropped write, a daemon restart, or a hold shorter
than this interval all land there. Both arms go quiet the moment the mode is
saved — the controller stops, publishes no state, and `d.known` goes false.
`toneKeptAt` resets to 0 with the leaf, so a remount renews on its first
heartbeat rather than assuming it inherited a fresh hold.

Two traps worth knowing. Every half of this carries an author `display`, which
beats the UA's `[hidden]` rule whatever the specificity, so each needs its own
`[hidden] { display: none }` — without them the mode lights up and nothing
moves. And `renderAutoStatus` sets `row.hidden` on every heartbeat, so it gates
on `d.on` as well as `d.known`; otherwise the next poll puts the status back two
seconds after the mode took it away.
