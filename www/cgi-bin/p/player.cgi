<%
# The Live player: the stage, its chrome, and the boot payload the page reads
# its source names from.
#
# A partial rather than a function in p/common.cgi, which is where this lived
# and is why it used to be written as a heredoc. That file is one single
# code block from its first line to its last -- a shell library -- and inside
# a code block there is no such thing as literal text, so markup can only
# leave it as the argument of a command. Three hundred lines of static HTML
# then have to be a heredoc, and an unquoted heredoc is shell source: the
# comments in it quote CSS with backticks the way the rest of the tree does,
# and the shell ran them.
#
# (This paragraph carefully does not spell either tag out. A closing tag
# inside the block would end it here, which is the same class of accident
# one layer up.)
#
# Here the markup is just markup, the way p/motor.cgi two lines below the
# include already was. Nothing interprets it, so nothing in it can be
# interpreted wrongly.

# The source names, from the camera's own locale file. The daemon reports a
# KIND ('sensor' / 'external') and refuses to name it — it has no business
# deciding what language an operator reads — so the naming happens here,
# where every other operator-facing string on this camera is translated.
#
# Underscores in the key, unlike the settings-tree labels beside them:
# these name a source rather than a config section, so they are not in that
# namespace and must not collide with a section called `source`.
# Escaped, not merely quoted. The value is whatever is in the locale file,
# and this lands inside an inline <script>: an unescaped quote or backslash
# invalidates the payload (which sourceLabel() then silently answers in
# English), and a "</script" in it would end the element and turn the rest
# into markup on an authenticated page. Backslash first, then quote, then
# every < — none of them can appear in a source name, so dropping them
# costs nothing and closes the tag-break.
# No `local`: this is a partial, not a function, and `local` outside one is a
# runtime error that aborts the script -- which `sh -n` does not catch, so it
# emits nothing and the page silently loses its player.
mj_src_labels=$(sed -n \
	's/^mj_\(source_[A-Za-z0-9_]*\)=\(.*\)/\1\t\2/p' \
	j/locale.cgi 2>/dev/null |
	while IFS="$(printf '\t')" read -r k v; do
		v=$(printf '%s' "$v" |
			sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/[<>]//g' \
				-e 's/[[:cntrl:]]//g')
		printf '"%s":"%s"\n' "$k" "$v"
	done | paste -sd,)
# No trailing newline: haserl emits the one that follows this block's closing
# tag, and the two together would put a blank line between the payload and the
# markup.
printf '%s' \
	"<script type=\"application/json\" id=\"mj-preview-boot\">{\"labels\":{${mj_src_labels}}}</script>"

%>
<div class="mj-player" id="mj-player">
	<!-- The stage: everything lives ON the video, and the stage is the page.
	     It takes the whole window under the navbar — no container, no card, no
	     footer — because the picture is what this page is for, and the frame
	     around it was costing a 4:3 sensor two thirds of a 1440p screen.

	     It is a VIEWPORT, not a box that reserves the stream's shape:
	     preview-zoom.js sizes and positions the picture inside it (Fill covers
	     the window, Fit shows the whole frame, 1:1 shows real pixels) and pans
	     whatever does not fit. Without that module the media keep their CSS
	     `inset: 0` and `object-fit: contain`, which is Fit.

	     tabindex makes the stage itself focusable: that focus is what scopes
	     the PTZ arrow keys away from the volume slider and the radio groups in
	     the bar. -->
	<!-- --mj-pic-*: the insets of the picture inside the stage, written by
	     preview-zoom.js so the chrome that ANNOTATES the picture (the chip, the
	     stats panel, the toasts) sits on it rather than floating in a
	     letterbox band beside it. Zero here so the page is right before — and
	     without — that module. The bar and the PTZ pad deliberately do not read
	     them: they are the player's furniture, not annotation, and furniture
	     that jumps when you change zoom is worse than furniture on black. -->
	<div class="mj-stage" id="mj-stage" tabindex="0" aria-label="Live video">
		<!-- Two, and only ever one of them visible. A transport switch attaches
		     the new player to whichever is idle and leaves the other playing, so
		     the picture only changes once the replacement has one of its own.
		     One element cannot do that: MSE drives it through src and WebRTC
		     through srcObject, so the incoming player would have to evict the
		     outgoing one before anybody knows whether it works. -->
		<video id="live-video" class="mj-stage-media" autoplay muted playsinline></video>
		<video id="live-video-b" class="mj-stage-media" autoplay muted playsinline style="display:none"></video>
		<!-- The software-decode rung paints here instead. Two, for the same
		     reason the videos are two: a trial has to prove itself on an idle
		     element before it takes the stage. Hidden to start with, because
		     nothing hides them but the swap and the swap only touches the slot
		     it is using. WebCodecs and MediaStreamTrackGenerator would let a
		     decoder feed a real <video>, and both are secure-context-only,
		     which a camera on plain HTTP is not -- hence a canvas. -->
		<canvas id="live-canvas" class="mj-stage-media" style="display:none"></canvas>
		<canvas id="live-canvas-b" class="mj-stage-media" style="display:none"></canvas>
		<!-- And the MJPEG rung paints here. Two, for the same reason as the
		     videos and the canvases: it is a transport now rather than the
		     terminal fallback it used to be, so it is staged and promoted like
		     any other, and a trial has to prove itself on an idle element.
		     It stopped being a fallback because a USB webcam publishing MJPEG
		     is a SOURCE — for most of them the only thing they publish — so
		     this picture has to be reachable as a first choice, for a camera
		     other than the on-board one. -->
		<img id="live-mjpeg" class="mj-stage-media" alt="" style="display:none">
		<img id="live-mjpeg-b" class="mj-stage-media" alt="" style="display:none">
		<!-- Shown only when there is no MJPEG fallback to show, so it carries
		     both halves: why the stream could not be played (preview-page.js
		     rewrites the span from the player's reason code) and the one thing
		     that would give this browser a picture. With jpeg.enabled on, the
		     picture arrives instead and the reason goes to the #mj-served
		     toast — the explanation must not be the thing that disappears the
		     moment the fallback works. -->
		<p id="mj-note" class="alert alert-warning mj-stage-alert" style="display:none">
			<span id="mj-note-why">Your browser can't play the live video stream.</span>
			<!-- Hidden by preview-page.js when the camera already has a JPEG
			     stream: the chain reaches it as a transport of its own now, so
			     if the page is showing this note that stream was tried and
			     failed, and telling someone to switch on what is already on is
			     how a page loses their trust. -->
			<a id="mj-note-act" href="camera.cgi?tab=jpeg">Enable JPEG</a> for an MJPEG fallback.
		</p>
		<!-- The other half of "there is nothing to see", and the one #mj-note
		     cannot reach: a camera on the wrong sensor driver PLAYS, so the
		     player never fails and never writes the note. preview-health.js
		     owns this one and writes both the sentence and the link from the
		     finding, because one banner covers a black picture, a stopped
		     encoder and a camera with no channel enabled, and each of those
		     wants its own words and its own destination. Usually the viewer has
		     already been handed to the Dashboard by the time it renders; this
		     is what the page says when that hand-off has been spent. -->
		<p id="mj-blind" class="alert alert-warning mj-stage-alert" style="display:none">
			<span id="mj-blind-why"></span>
			<a id="mj-blind-act" href="camera.cgi?tab=isp"></a>
			<!-- Hidden until a finding says it applies: a hardware fault is the
			     one an owner cannot fix from a settings page, and the log is
			     what they can screenshot for whoever sold them the camera. -->
			<a id="mj-blind-help" href="logs.cgi" hidden></a>
		</p>
		<!-- The status chip. Same id as the badge it replaces, so every state
		     write (connecting… / no signal / MJPEG / reconnecting…) keeps
		     landing; live it reads "H264 3840×2160 · 25 fps". The transport is
		     NOT named here — it is named exactly once, on the picker below. -->
		<span id="mj-badge" class="mj-chip">connecting…</span>
		<!-- The network story (preview-stats.js). An empty shell on purpose:
		     the panel is meaningless without the script that measures for
		     it, so the script owns the structure too, and the two ends'
		     numbers still come from the two ends — the browser can be losing
		     packets the camera never sees dropped, and the camera's remb= is
		     its opinion of the link, not a measurement of it. An overlay, so
		     looking at the numbers does not displace the picture they
		     describe. -->
		<div id="mj-stats" class="mj-stats-overlay small" hidden></div>
		<!-- The toast stack. A flex column rather than two boxes at hardcoded
		     offsets under the chip: the chip's height is not a constant (its
		     text is "MJPEG" on one camera and "H265 3840×2160 · 25 fps · 36% ·
		     Sub stream" on another, which wraps on a phone), so anything
		     measured from the top of the stage sat too close to it or on top of
		     it. preview-zoom.js publishes the chip's measured height and the
		     stack starts below it; a hidden toast takes no room, so the served
		     message moves up when there is no adaptation toast above it. -->
		<div class="mj-toasts" id="mj-toasts">
		<!-- The adaptation toast (preview-adapt.js): the whole disclosure of
		     WebRTC's shared-encoder bitrate adaptation, made at the moment it
		     acts rather than as a standing sentence (the always-on note this
		     replaces taught people to ignore it, and could not tell whose
		     connection was responsible). Names the direction and says whose
		     link moved the encoder — a change caused by another viewer is the
		     case nothing else on the page would explain. Below the chip so
		     the two can show together. -->
		<!-- role=status so the announcement reaches a screen reader when the
		     text lands; the × is the keyboard's dismissal (click-anywhere
		     only serves a pointer) and focusing it pins the toast the same
		     way hovering does. -->
		<p id="mj-adapt" class="mj-adapt-toast small" role="status" hidden>
			<span id="mj-adapt-rates" class="mj-adapt-rates"></span>
			<span id="mj-adapt-why" class="mj-adapt-why"></span>
			<button type="button" class="mj-adapt-close" aria-label="Dismiss">×</button>
		</p>
		<!-- The served-channel message (preview-page.js): why the channel the
		     viewer picked is not the one playing, from the camera's own
		     `served` signalling reply on a new enough majestic. Unlike the
		     adaptation toast it does not time out — the mismatch stands for
		     the whole session — so it stays until dismissed or stale. Slotted
		     below the adaptation toast so all three overlays can show. -->
		<p id="mj-served" class="mj-adapt-toast mj-served-toast small" role="status" hidden>
			<span id="mj-served-why"></span>
			<button type="button" class="mj-adapt-close" aria-label="Dismiss">×</button>
		</p>
		</div>
		<!-- The rubber band, while a zoom-to-area rectangle is being drawn.
		     Its huge box-shadow spread is what dims everything outside it --
		     one element instead of four, clipped by the stage. -->
		<div id="mj-marquee" class="mj-marquee" hidden></div>
		<!-- PTZ mount. Empty and hidden on every camera; p/motor.cgi (included
		     by live.cgi only when the hardware exists) emits the pad after
		     the player and preview-ptz.js relocates it in here. -->
		<div id="mj-ptz" class="mj-ptz" hidden></div>
		<!-- The control bar. Hidden until pointed at, focused into, or tapped
		     (preview-hero.js) — the picture is the page's point, not the
		     chrome. It stays overlaid at every width, because it lives inside
		     the stage and that is what carries it into fullscreen; below md it
		     scrolls sideways rather than wrapping into rows over a 186px-tall
		     picture. The PTZ pad is the one that moves off the video there:
		     it is always visible, so overlaid it never gives the picture back.

		     Every group is black glass with a micro-caps label and, where it
		     has a state, a lit indicator — the same vocabulary the Live
		     adjustments deck uses, so the two pages read as one product. The
		     radio/checkbox-behind-a-label pattern is kept exactly as it was:
		     preview-page.js drives .checked and .disabled on those inputs, and
		     they are what keeps the groups reachable from a keyboard.

		     Icons are inline SVG on a 20px grid. The emoji that were here
		     (U+1F507 speaker, U+1F3A4 microphone, U+1F4F7 camera) rendered as
		     a different picture on every machine — the same argument the
		     fullscreen button in this very bar already won, when U+26F6 came
		     out as a box on real hardware. -->
	<div class="mj-bar" id="mj-bar">
			<!-- How the frame is fitted to the window. First in the bar, and that
			     is not arbitrary: on a camera with an optical zoom the page
			     carries two zooms, and this one must not sit next to the pad's
			     Wide/Tele. The pad owns the lens, the stage owns the picture.

			     Hidden until preview-zoom.js takes it: without that module the
			     media elements keep their CSS `inset: 0` and `object-fit:
			     contain`, which is exactly Fit — a working page with one fewer
			     control rather than a control that does nothing.

			     No caption above the group, like Stream and Transport beside it:
			     a segmented picker's options say what it is, and aria-label says
			     it for a screen reader. Only the stateful toggles carry a word,
			     because a lit dot alone does not say what is lit. -->
			<span class="mj-hud mj-seg" role="group" aria-label="View" id="mj-view-ctl" hidden>
				<input type="radio" class="mj-seg-in" name="mj-view" id="mj-view-fit" autocomplete="off">
				<label class="mj-seg-lbl" for="mj-view-fit"
					title="The whole frame. Letterboxed where its shape does not match the window's.">Fit</label>
				<input type="radio" class="mj-seg-in" name="mj-view" id="mj-view-fill" autocomplete="off" checked>
				<label class="mj-seg-lbl" for="mj-view-fill"
					title="Cover the window: no part of the screen is spent on black. Whatever does not fit is one drag away.">Fill</label>
				<input type="radio" class="mj-seg-in" name="mj-view" id="mj-view-one" autocomplete="off">
				<label class="mj-seg-lbl" for="mj-view-one"
					title="One stream pixel per screen pixel — what to judge focus on.">1:1</label>
			</span>

			<!-- Zoom to an area you draw. The View presets and pinch already zoom,
			     but pinch is a trackpad gesture and a mouse has nothing like it:
			     ctrl+wheel works everywhere and is discoverable by nobody. This
			     is the control that says out loud that the picture can be
			     enlarged, and it is more precise than either -- you say which
			     part, and the scale falls out of the rectangle.

			     Armed rather than modal: one drag, then it disarms itself.
			     A mode you can forget you are in is the wrong thing to put
			     over a live picture that also steers a camera. -->
			<span class="mj-hud mj-tog-wrap" id="mj-area-ctl" hidden>
				<input type="checkbox" class="mj-tog-in" id="mj-area" autocomplete="off">
				<label class="mj-tog" for="mj-area"
					title="Draw a rectangle on the picture to enlarge that part of it. Where nothing is hidden — Fit, mostly — you can just drag; this is for when the picture is already zoomed in and a drag would move it instead. Esc cancels; Fit or Fill comes back out.">
					<span class="mj-led"></span>
					<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<rect x="3" y="4.4" width="14" height="11.2" rx="1.2" stroke-dasharray="3 2.2"></rect>
						<path d="M10 7.6v4.8M7.6 10h4.8"></path>
					</svg>
					<span class="mj-tog-t">Area</span>
				</label>
			</span>

			<!-- Which camera. Empty, and built by preview-page.js from
			     /api/v1/sources, because most cameras have exactly one source
			     and markup for a chooser nobody can use is markup that has to
			     be hidden correctly for ever — the same reasoning
			     cameras-switch.js applies to the device picker. A camera with a
			     second sensor or a USB webcam grows the buttons; every other
			     one leaves this empty and it takes no room. -->
			<span class="mj-hud mj-seg" role="group" aria-label="Source"
				id="mj-source" hidden></span>

			<span class="mj-hud mj-seg" role="group" aria-label="Stream">
				<input type="radio" class="mj-seg-in" name="mj-stream" id="mj-stream-0" autocomplete="off" checked>
				<label class="mj-seg-lbl" for="mj-stream-0">Main</label>
				<!-- Both start disabled, not merely label-hidden: the input is a
				     real radio behind CSS, so an unhidden one is in the tab
				     order and a keyboard could select a stream this camera may
				     not have before the configuration has been read.
				     preview-page.js enables them once it knows there is a
				     substream. -->
				<input type="radio" class="mj-seg-in" name="mj-stream" id="mj-stream-1" autocomplete="off" disabled>
				<label class="mj-seg-lbl" for="mj-stream-1" id="mj-sub" hidden>Sub</label>
				<input type="radio" class="mj-seg-in" name="mj-stream" id="mj-stream-auto" autocomplete="off" disabled>
				<label class="mj-seg-lbl" for="mj-stream-auto" id="mj-auto" hidden
					title="Picks whichever stream is closest to the size this player is being shown at, and follows the window as it changes. The chip names the one in use.">Auto</label>
			</span>

			<!-- Muting and level are one control, so the slider rides inside
			     the same glass rather than beside it. The speaker icon carries
			     both states in one element: CSS shows the crossed-out ending
			     while the input is unchecked and the waves while it is, so the
			     word alone is what preview-page.js has to rewrite. -->
			<span class="mj-hud mj-tog-wrap" id="mj-audio-ctl" hidden>
				<input type="checkbox" class="mj-tog-in" id="mj-mute" autocomplete="off">
				<label class="mj-tog" for="mj-mute" id="mj-mute-lbl">
					<span class="mj-led"></span>
					<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M4 7.6h2.8L10.6 4.4v11.2L6.8 12.4H4z"></path>
						<path class="mj-ic-off" d="M13.6 7.8l3.8 4.4M17.4 7.8l-3.8 4.4"></path>
						<path class="mj-ic-on" d="M13.4 7.6a3.4 3.4 0 0 1 0 4.8M15.8 5.6a6.6 6.6 0 0 1 0 8.8"></path>
					</svg>
					<span class="mj-tog-t" id="mj-mute-t">Muted</span>
				</label>
				<input type="range" id="mj-vol" min="0" max="100" value="100" class="mj-vol" disabled aria-label="Volume">
			</span>

			<!-- Talkback. Revealed only over WebRTC, only where the camera has
			     audio.outputEnabled, and only in a secure context: a browser
			     hands over no microphone on plain HTTP, so the button would be
			     a dead end. -->
			<span class="mj-hud mj-tog-wrap" id="mj-talk-ctl" hidden>
				<input type="checkbox" class="mj-tog-in" id="mj-talk" autocomplete="off">
				<label class="mj-tog mj-tog-amber" for="mj-talk" id="mj-talk-lbl"
					title="Send this browser's microphone to the camera's speaker. The camera will not take audio in one direction only, so talking also opens its audio to you.">
					<span class="mj-led"></span>
					<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<rect x="7.4" y="2.6" width="5.2" height="9" rx="2.6"></rect>
						<path d="M4.6 9.4a5.4 5.4 0 0 0 10.8 0M10 14.8v2.6"></path>
					</svg>
					<span class="mj-tog-t" id="mj-talk-t">Talk</span>
				</label>
			</span>

			<!-- The transport, named exactly once, with the alternative finally
			     visible. Unhidden by preview-page.js only where
			     preview-webrtc.js is loaded and the browser has WebRTC. The
			     failure tooltip still lands on the WebRTC label
			     (#mj-transport-lbl), which is where the question "why am I not
			     on WebRTC?" gets asked. -->
			<span class="mj-hud mj-seg mj-bar-end" role="group" aria-label="Transport" id="mj-transport-ctl" hidden>
				<input type="radio" class="mj-seg-in" name="mj-transport" id="mj-transport-w" autocomplete="off">
				<label class="mj-seg-lbl" for="mj-transport-w" id="mj-transport-lbl"
					title="Sub-second video and two-way audio, and the camera fits the stream to your connection — which changes it for everyone else watching that stream too.">WebRTC</label>
				<input type="radio" class="mj-seg-in" name="mj-transport" id="mj-transport-m" autocomplete="off">
				<label class="mj-seg-lbl" for="mj-transport-m"
					title="Plain buffered playback. A couple of seconds behind, but nothing adapts and nothing negotiates.">MSE</label>
			</span>

			<span class="mj-hud mj-tog-wrap" id="mj-stats-ctl" hidden>
				<input type="checkbox" class="mj-tog-in" id="mj-stats-btn" autocomplete="off">
				<label class="mj-tog" for="mj-stats-btn"
					title="Per-second measurements from both ends of the session.">
					<span class="mj-led"></span>
					<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
						<path d="M3.4 16.6V11M8.4 16.6V4.6M13.4 16.6V8.2M17.2 16.6v-3.4"></path>
					</svg>
					<span class="mj-tog-t">Stats</span>
				</label>
			</span>

			<span class="mj-hud mj-ico-wrap">
				<button type="button" class="mj-hud-ico" id="mj-snap" hidden
					title="Download a full-resolution snapshot" aria-label="Snapshot">
					<svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
						<path d="M2.6 6.6h3.2l1.5-2.1h5.4l1.5 2.1h3.2v9H2.6z" stroke-linejoin="round"></path>
						<circle cx="10" cy="10.6" r="3.1"></circle>
					</svg>
				</button>
				<button type="button" class="mj-hud-ico" id="mj-fs" hidden
					title="Fullscreen" aria-label="Fullscreen">
					<svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
						<path d="M3 7.4V3h4.4M16.9 7.4V3h-4.4M3 12.6V17h4.4M16.9 12.6V17h-4.4"></path>
					</svg>
				</button>
			</span>
		</div>
	</div>
</div>
