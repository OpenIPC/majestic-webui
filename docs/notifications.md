# Notifications and extensions

The contract shared by the three senders, the two movement hooks, and the pages
that configure them.

Each extension is a CGI for the form plus a sbin script invoked by cron or
webhook: `telegram.cgi` ↔ `sbin/telegram`, `ntfy.cgi` ↔ `bin/ntfy.sh`,
`max.cgi` ↔ `sbin/max`, `openwall.cgi` ↔ `sbin/openwall`, plus `wireguard.cgi`,
`vtun.cgi`, `proxy.cgi` and `backup-create.cgi`. The CGI defines a `params` list,
loops `POST_<name>` into shell vars, validates, rewrites its single
`/etc/webui/<name>.conf`, and `sed -i /<name>/d /etc/crontabs/root` before
re-adding the cron line if scheduling is on. Webhooks like `?send=image`
short-circuit before `header.cgi` and emit their own `Content-type`.

**All three senders answer three questions in order**, and that order is the
contract `sbin/motion-notify.sh` and `sbin/record.sh` depend on to hand every
sender one capture:

1. a **path argument** is a file somebody else made — the recording majestic has
   just closed, which *is* the motion and must never be answered by capturing a
   second clip a minute later;
2. `--clip` / `--image` from a caller that knows what it wants;
3. the page's own switch.

Where the answer is a clip with no file in hand, the sender fetches
`localhost/video.mp4?pre=N&duration=N`, which holds the muxer up for the life of
one request — **no card, no recorder, no HLS playlist**, which is the whole point:
the alternative on a card-less camera was a still picture of what the camera can
see *now* rather than what set the trigger off. `?pre=` is usually answered with
nothing, because the camera holds a run-up only while another request *that asked
for one* is open; the response says which in `X-Preroll-Seconds`, and the sender
prints no figure at all when the camera did not say, since an absent header is not
a run-up of zero. **A refusal is a refusal**: a non-200, or a 200 carrying no
bytes (the shape a pipeline torn down mid-clip leaves behind), ends the send
rather than falling back to a picture, because a silent downgrade would leave an
operator believing the clips they configured are arriving.

**Movement reaches a card-less camera through the other hook.** The clip hook
fires when a recording is *finished*, so on a camera with nowhere to record it
never fires at all; majestic also runs `/usr/sbin/motion.sh` the moment movement
*starts*, and `sbin/motion-notify.sh` is what that leads to. Both paths are the
same switch on the page — which mechanism runs is the camera's business, not the
operator's. Four things about it reach beyond that script:

- They must never both fire for one event, so it stands aside only when the
  recorder is **demonstrably** doing the job — and the predicate has three
  answers, sending the clip anyway on *could not tell*, because a missed event is
  worse than a duplicate.
- **There is no configuration key** for the movement hook: majestic runs that
  path if the file is there and executable, so wiring it means writing the file.
  `motion_hook_sync` follows the rule `clip_hook_sync` follows — write only a file
  that is absent, recognise its own by a marker line, remove only what it wrote,
  and tell the operator rather than overruling them when something else is there.
  `notify_hooks_sync` runs both and returns one sentence, so a page cannot report
  half the answer.
- One capture serves both senders where they ask for the same length; where they
  differ each gets what its own page promised, because handing both the longer
  clip silently lengthens one service's video because the other was switched on.
- **The bounding box majestic passes that hook is deliberately ignored.** Its
  numbers used to be the box's corners on HiSilicon and a corner plus its size on
  SigmaStar and Ingenic, so a script that measured what moved was wrong on two
  vendors out of three and nothing in the numbers said which. Every backend
  passes corner and size now — fixed firmware-side — but a hook of somebody's
  own that reads them should read them as x, y, width, height.

**Both notification pages lead with a sentence, written in `www/a/notify.js`.**
`NotifyStatus.verdict()` is that line — pure, exported, shared by both pages and
walked by `tests/notify-status.test.js`, because every branch produces a fluent
confident sentence and a wrong one reads exactly as well as a right one. It is
computed from what the **camera** reports, not from what was typed into the form,
and since `mjConfig()` resolves `{}` when the camera does not answer, *we could
not ask* and *the detector is off* arrive as nearly the same value — so every
clause that would blame a setting is gated on `camera.known`. Four rules that
govern any page of this shape:

- **The server renders the same verdict before any script runs.** A page whose
  only status line is built in JS says nothing at all on a camera whose browser
  never got the file, and this is the one line that has to be there; the script
  then fills in the half that needs the camera.
- **A control that cannot work dims rather than hides**, says why, and links to
  the page that fixes it — a control that vanishes takes its own explanation with
  it. Movement is the one trigger with a prerequisite, so with the detector off
  that row dims and the headline drops to *Partly ready*. *When something asks*
  is always in the list, because the webhook links are live the moment the
  service is on and addressed.
- **A page cannot file its required settings under "you will probably never need
  this".** All three used to keep the bot token, the chat or the server inside
  the advanced fold, which is true of the second visit and wrong about the first.
  Each now leads with what it cannot run without; the fold keeps what is genuinely
  optional. Tokens and passwords are masked in the raw-configuration block and
  typed into password fields.
- **`notify.js` holds a words table rather than English** — every sentence is a
  key with an English default that a page may override through `words` in its boot
  tag. A table rather than one file per language, because the logic deciding
  *which* sentence is the part that fails silently and must not be duplicated;
  untranslated keys fall back rather than rendering blank, and the test leaves one
  untranslated on purpose to pin that.

The webhook verbs name their payload rather than asking the settings —
`?send=image` and `?send=clip` on both pages, so a dashboard pulling a thumbnail
goes on getting one after the schedule has been switched to video, while
`ntfy.cgi?send=test` stays the page's own button. Intervals are words
(`Every hour` → `0 * * * *`), after `telegram_interval` went into the cron
**minute** field where `*/60` matched only minute 0.

**MAX is the same shape from the page's side and a different wire underneath**,
and the difference is a trap worth knowing before reading `sbin/max`: it takes
three calls rather than one, and the two payload kinds disagree about where the
token comes from. A **video** slot answers `{"url","token"}` and the upload
itself answers `<retval>1</retval>`, which is not JSON at all; an **image** slot
answers `{"url"}` alone and the token comes back from the upload as
`{"photos":{…:{"token":…}}}`. Both are pinned in `tests/delivery.test.js`,
measured against the live service — a port written from the API documentation
would have shared one code path and shipped a Picture switch that silently
failed. The API host is fixed and deliberately not a setting: MAX is a service
you join rather than one you can run, which is the difference from `ntfy_server`.
The protocol knowledge is ported from
[AT-Lee/MAX-for-OpenIPC](https://github.com/AT-Lee/MAX-for-OpenIPC) (MIT) and the
licence notice travels with it in `sbin/max`.

**The MAX page is Russian, and it is in the menu only for Russian readers.** Its
bots can only be registered by a Russian business after identity verification, so
an English page would be a translation nobody who can use the feature needs.
`p/header.cgi` renders the entry `hidden` and `main.js` reveals it when
`navigator.languages` mentions Russian — anywhere in the list, because a menu
entry is not exclusive, where `setup.html` picks one language by precedence
because it can display only one agreement. **Hiding is not access control**: the
page answers a direct link exactly as before, which is what a bookmark and the
webhook URLs depend on.
