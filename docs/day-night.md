# Day / Night — the IR-cut filter

The four `ircut-*.js` modules and the pad endpoint they drive.

## `ircut-check.js`, `ircut-map.js`, `ircut-scan.js`, `ircut-pads.js`

A misconfigured IR-cut filter is invisible everywhere else: the camera streams,
records, answers ONVIF and reports healthy counters while sending a magenta
picture, and the commonest fault is a *missing* value — with no
`nightMode.irCutPin1` majestic never drives the filter at all. So the four
modules are a ladder of evidence. `ircut-check.js` is the verdict module and the
only one with opinions: `diagnose()` reads config and the metrics the heartbeat
already polls (free, passive, catches the missing pin outright), `stats()`
computes the colour statistics that recognise an open filter, and `probe()`
drives the filter and watches the picture change — the only one that can tell
"wired backwards" from "not wired". `ircut-map.js` draws the pads,
`ircut-scan.js` finds the wiring by driving it, and `ircut-pads.js` is what the
sweep knows about the part before it drives anything.

Each file argues its own case at length, including why there is no brightness
gate, why two agreeing frames buy a third trial, and why a stuck filter is
usually a configuration rather than a wire. What reaches beyond those files:

- **The scan proposes; the test adjudicates.** Nothing is written to majestic
  behind anyone's back — a proposal is staged into the hidden fields and the
  ordinary save bar appears — and a pad assignment is only ever *claimed* correct
  by `probe()`, which measures.
- **The sweep's UI is `pin-hunt.js`, mounted twice.** The Pins page offers both
  hunts; Day / Night passes `only: 'filter'` and gets that half alone, opened by
  the panel's own button rather than by a resting card. The two differ in the
  door and in where a find lands — nowhere else, and the pure half stays in
  `ircut-scan.js`. The split is by *detector*, not by page: the general hunt
  holds one pin and diffs the camera's device inventory, so it can find
  anything and belongs with the chip; this one pulses **pairs** and reads the
  **picture**, so an IR-cut filter is the only thing it can ever find, and it
  belongs beside the wiring fields its answer goes into. Running it from the
  other page cost three presses, a page change, and two presses that visibly
  did nothing because the door and then `Start` were below the fold (#552).
  A find made on Day / Night is staged through the host's `pins.use`; only one
  made on the Pins page has to cross in `sessionStorage`, and it must stay
  session-scoped — a proposal that outlived the tab would raise a save bar next
  week holding pins from a board no longer on the desk.
- **The test refuses to run while the pin map has unsaved wiring**, and the check
  hangs off `updateDirty()` — the funnel every settings edit goes through — not
  off the map's own `onChange`, because the pin fields stay editable directly on
  a camera whose pad list could not be read. A test run against staged wiring
  pulses the *old* pair and then stamps its verdict with the *new* assignment:
  measured, the page said "wired correctly" about wiring that had never been on
  the camera.
- **The picture is never a verdict on its own, and a frame that looks fine
  produces no finding at all** — a filter stuck *closed* is invisible until
  nightfall, so silence here must never read as a clean bill of health.
- **`ircut-pads.js` is generated** from the wiki's GPIO table by
  `tools/harvest-gpio-table.js`; re-run it after that table changes. It demotes
  pads the table names as something else (reset lines, USB enables, illuminators)
  rather than excluding them, because those rows are per *board* and a pad that
  is a coil on any board with the part is never demoted.
- **Pads carry plain running integers** — the same number that goes into
  `nightMode.irCutPin1` and the same the wiki lists. The kernel's `bank_pin`
  spelling appears nowhere.

## Driving pads

**`gpio.cgi` is a tombstone (410).** The pads moved into majestic, which already
drove them: `GET /api/v1/gpio` enumerates, `POST` with `?pair=` or `?park=` moves
one. The file stays because deleting it would not remove it — `sbin/updatewebui`
prunes the overlay copy of a file a release stops shipping, uncovering the
firmware's own older copy underneath, and that copy reads config out of a file
that omits every defaulted key, coordinates with nothing, and actuates on a GET.
What the daemon's endpoint guarantees, and anything touching pads must preserve:

- **Pad count is never assumed.** `/sys/class/gpio/gpiochip*` carries base and
  ngpio for every bank the kernel registered — 9 banks on most HiSilicon V2/V3,
  10 on EV300/DV200, 17 on a 3516AV100, pads numbered from 224 on Novatek.
  Anything hardcoding 80 is wrong on most cameras in the field.
- **The guards refuse what they cannot see.** Ownership comes from
  `/sys/kernel/debug/gpio`, which separates two claims that are not the same: a
  line a **driver** holds is hardware somebody wired on purpose and is refused
  outright, while `sysfs` is only an export — and on OpenIPC that export is
  majestic's own, keeping IR-cut pads driven because on a brake-held filter that
  is what holds the day position. A debugfs that cannot be read, more held lines
  than fit, or a boot environment that will not parse are **not** an absence of
  owners; they reach the page as `ownersUnknown`/`ptzUnknown`, which disables the
  sweep rather than printing "free" for a pad nobody checked.
- `?pair=a,b` raises a against b then **brakes both**. The brake is not tidiness:
  an IR-cut filter is an H-bridge across two pads, no single-pad operation
  actuates it, and on a brake-held board the brake is what *holds* the position
  the actuation reached. `?park=a,b&mode=float` is the explicit release.
- **A coil burns if current is left in it.** The pulse ceiling (40–400 ms) is a
  hardware limit, not a tuning knob, and is clamped whatever the request asks.
  Pads are braked on every exit including the client hanging up mid-pulse, an
  abandoned actuation still serves out its cooldown, and there is one actuation
  at a time camera-wide — the daemon's own day/night transition stands aside
  while a scan holds the pads, *before* it updates the gauge `/metrics` reports,
  so a move that did not happen cannot leave the camera claiming otherwise.
- **The journal is the one write whose failure stops the actuation**, because it
  is what keeps a pair that took the camera down from being offered again. Synced
  before any pad is touched, written to a temp file and renamed rather than
  truncated in place; a pair whose journal says it began before this boot and
  never finished is refused outright.

## The sun: `sun-place.js`, `sun-panel.js`, `tz-places.js`

`nightMode.switchBy` lets automatic day/night ask something other than the
picture: the sun's height, two set times, or the picture with no day allowed in
the dark hours. `nightMode.whiteLight` lets the white lamp follow the sun too.
The panel under *Switch day and night by* is where the sun's two settings are
made, and what reaches beyond its own header is this:

- **An angle, chosen on a strip.** The angles (`sunNightAngle`, `sunDayAngle`)
  are drawn hidden and driven by `setValue`, the pin map's pattern. So are
  `calibration.latitude`/`longitude`, though they belong to another section: the
  save batch is built by dotted path, and nothing on the page compares a field's
  section with the one on screen. One Save carries both sections.
- **The page computes no time.** Every time on the strip comes from the camera,
  `GET /api/v1/sun[?lat=&lon=]`, in the camera's own time zone, which need not
  be the browser's. A place typed but not saved is asked about too, so the times
  follow the typing. The endpoint is owner-only, since it answers where the
  camera stands.
- **A night the sun does not reach is said, never left blank.** The case is a
  camera told "night at nautical dusk" in Moscow in June: it looks set up and
  never goes to night. The panel names it in words and draws the unreached lines
  struck through. The sentence is pure (`tonight()`), and
  `tests/sun-panel.test.js` holds it to the cases, because it reads just as
  confidently when it picks the wrong line.
- **No place, no sun choices.** While neither the saved config nor the page
  holds a place, *The sun* and *Picture, no day in the dark hours* are greyed
  out (and the white lamp's *Follows the sun*), unless one of them is already
  what the camera runs.
- **Where the camera is comes from the owner.** Over plain HTTP the browser will
  not give the page a location. So it is typed, or pasted from a map link that
  `sun-place.js` reads by each host's own convention: Yandex writes longitude
  first, and a Google place link carries both the pin and the view. Every
  misreading of a link is silent, which is why `tests/sun-place.test.js` exists.
  The camera's time zone offers its city as a first guess. The table is
  generated from tzdata by `tools/harvest-tz-places.js`, fetched only when the
  guess is offered, and the guess is staged like any edit, never saved by
  itself.
- **The live line.** The monitor line under Automatic day/night reads sources 5
  (the sun) and 6 (set times) from `night_mode_source`. It says why the picture
  is deciding when the sun or the clock handed back (`night_sun_state`), and
  when the dark hours are refusing a day (`night_window_closed`,
  `night_days_refused_total`). A gauge the camera did not publish adds nothing.
