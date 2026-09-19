# JSON endpoints, the SD card and the read-back pass

What `www/cgi-bin/j/` is for, and the contract between `j/sdcard.cgi`,
`sbin/sdscan`, `www/a/sdcard-health.js` and `www/a/storage-verdict.js`.

Small `#!/bin/sh` scripts emitting JSON for the front end. `pulse.cgi` is the
model for what belongs here at all: it was cut back to the three things majestic
cannot answer — overlay `df`, `/etc/timezone`, and the camera's own `date %z` —
once `/metrics` was found to carry the rest. The heartbeat polls `/metrics`
directly every 2 s and asks `pulse.cgi` only every 15th tick. `run.cgi` streams
the output of a base64-encoded shell command (`cmd=` for trusted local, `web=`
adds `timeout 3` for the console page).

**`sdcard.cgi` makes the judgement once, server-side.** Two pages read it
(`a/sdcard.js`, `a/recordings.js`) and they only choose wording; the verdict is
its `health` field — `ok`, `readonly`, `unmounted`, `unreadable`, `unformatted`,
`absent`. `readonly` is the one that matters and the one nothing else can show: a
card the kernel dropped to read-only (`errors=remount-ro`) still reports its old
free space through `df`, so capacity, the storage bar and the clip list read
exactly as they did before recording stopped. `fsErrors` carries up to three
matching `dmesg` lines, gathered **only** in the unhealthy states (polled every
5 s, and `dmesg` is ~80 KB on a running camera) and is corroboration only — the
ring buffer is small enough that an error which stopped recording hours ago has
usually scrolled out, so an empty list must never render as a clean bill of
health. `canFsck` is false where busybox's generic `fsck` wrapper has no
`fsck.vfat` to exec, and the pages then say "reformat" rather than offering a
repair the firmware cannot perform.

**Formatting and capacity checks verify against the card, never against an exit
status** — the reasoning is in `sdcard.cgi`; four results of it must survive any
edit:

- `probe_write`/`probe_seen` stamps the partition's first sector and reads it
  back cold before `mkfs` runs, with the stamp **minted per run** (an aborted
  format can have left one behind, and a fixed string would then be found without
  this run having written it). It is what catches a card gone **read-only in
  hardware** — the ordinary way an SD card dies, dropping writes in silence while
  the filesystem already there reads back intact, so every test that only asks
  "is there a filesystem?" says yes. Past the probe the card is known to keep
  writes, so nothing after it may blame the hardware.
- `probe_span` asks the *other* question — a counterfeit takes every write and is
  a quarter of the size it claims, folding addresses past its real end back onto
  the start. It writes **every point first and only then reads them all back** (a
  write-then-read-each loop passes at every single point, pinned by
  `tests/sdcard-span.test.js` against a simulated fake), and the offsets are a
  **power-of-two ladder**, because a counterfeit is a real 4/8/16 GB die masked
  up and an evenly spread ladder aliases each point onto a different free
  address. It deliberately reports **no capacity**: the obvious shortcut — the
  highest rung that held its own stamp — is wrong on exactly these cards.
- `mbr_ok` wants the `0x55AA` signature **and** a non-empty type byte in the
  first partition entry, since a vfat boot sector ends in `0x55AA` too, and it
  has three outcomes rather than two: table, no table, and *could not look*.
- `UNSTORED` names the card or the slot as the fault, so nobody keeps
  reformatting a card that reformatting cannot fix — reached only after a table
  has actually been written on this run and has not come back.

**`sbin/sdscan` is a read-back pass, not a surface map**; its header explains why
a latency-by-LBA picture does not transfer to flash. Five things the rest of the
system depends on:

- `op=scanstart` launches it detached with **all three descriptors closed**. Not
  tidiness: the background job inherits the pipe the web server reads the CGI's
  output from, and while it holds that pipe the HTTP response never finishes.
- Progress goes to `/tmp/webui/sdscan/state.json`, temp-and-renamed, and reaches
  the page through the status poll it was already making — no progress endpoint,
  no keepalive. `/tmp` and not `/etc`: a read pass that died with the camera is
  safe to run again.
- The lock is **pid-based** (`kill -0` is the proof, age only the backstop): no
  age is both short enough to recover from a `kill -9` and long enough to survive
  a six-hour scan. Stopping is a **flag, not a kill**, because the worker holds a
  partial result and only it can write one.
- A chunk is judged on the **byte count dd delivered**, never its exit status — a
  read off the end of the device answers `0+0 records out` and exits 0 — which is
  why it reads `count=16 bs=1M` and not `count=1 bs=16M`.
- **A clip the recorder deleted mid-scan is not a card fault.** majestic deletes
  the oldest recording at `records.maxUsage`, to the very files at the front of
  the oldest-first list this walks, so a failed read asks whether the file is
  still there before blaming the card — and counts the skipped clip (`vanished`)
  rather than ignoring it, because those bytes were not checked.

**`www/a/sdcard-health.js` is where the three kinds of evidence meet** — the
recorder's counters (free, continuous, the only thing speaking for the card while
nobody is looking), the capacity probe (cheap, destructive, rare) and the read
pass (on request). Pure and dual-exported, so `tests/sdcard-health.test.js`
reaches it with a plain `require`. Every accusatory clause is gated on the
counters being a *reading*: `null` (not asked), `{absent: true}` (this build does
not publish it) and a reading produce three different sentences, and only the
third may be `ok`. **Never checked is not a pass** — a card keeping up and never
checked gets "Keeping up so far, but never checked", because a dying card looks
exactly like a healthy one to every counter the camera publishes. In
`storage-verdict.js`, `queued` and `dropped` are passed in **pre-judged by the
caller**, because whether a queue is a moment's backlog or a card falling behind
is a claim about a window only the caller knows it is watching.
