// Camera Preview page glue: night/IRcut/light toggles (via the /night and
// /metrics/night APIs) and the live player attach, with an MJPEG/no-signal
// fallback. `$`, mjConfig and mjGet are globals from main.js; this file loads
// after preview.js and preview-webrtc.js.
//
// TWO TRANSPORTS, ONE FAÇADE. MajesticVideo (MSE) and MajesticWebRTC return
// the same object, so everything below is written once and the choice is made
// in attachPlayer(). WebRTC is the default now: sub-second where MSE is about
// a second behind, audio in both directions, and a receiver whose reports let
// the camera match the encoder to the link. MSE is a tick away for the
// browsers and cameras where negotiation cannot be made to work.
//
// The chain is WebRTC -> MSE -> MJPEG -> note, and the middle step is
// load-bearing rather than tidy. WebRTC negotiates and can therefore fail
// where MSE cannot: Firefox's WebRTC stack offers only H.264 Baseline whatever
// its decoder can do, so a camera on `profile: main` has nothing to give it —
// the same browser plays that stream over MSE without complaint. A player
// reporting 'fallback' is asking for the other transport, not for MJPEG.
//
// Now that the chain runs by default rather than on request, what it remembers
// matters more than it did. A refusal is recorded with a timestamp and expires;
// a camera that is merely full ('busy') is not recorded at all; and an explicit
// choice beats both. Otherwise the first bad afternoon would quietly park a
// browser on the slower transport for good.
(function () {
	// --- Night / IRcut / Light toggles ---
	mjConfig().then(cfg => {
		const active = v => v !== false && v != null;
		const lm = active(mjGet(cfg, 'nightMode.lightMonitor'));
		$('#toggle-night').disabled = lm;
		$('#toggle-ircut').disabled = lm || !active(mjGet(cfg, 'nightMode.irCutPin1'));
		$('#toggle-light').disabled = lm || !active(mjGet(cfg, 'nightMode.backlightPin'));
		if (lm) $('#mj-lightmon').hidden = false;
	});

	['night', 'ircut', 'light'].forEach(n =>
		apiFetch('/metrics/night?value=' + n + '_enabled', { credentials: 'same-origin' })
			.then(r => r.text()).then(v => { $('#toggle-' + n).checked = +v > 0; })
			.catch(() => {}));

	$('#toggle-night').addEventListener('click', () => {
		apiFetch('/night/toggle', { credentials: 'same-origin' }).then(api => api.json()).then(data => {
			$('#toggle-night').checked = data;
			if (!$('#toggle-ircut').disabled) $('#toggle-ircut').checked = data;
			if (!$('#toggle-light').disabled) $('#toggle-light').checked = data;
		});
	});
	$('#toggle-ircut').addEventListener('click', () => {
		apiFetch('/night/ircut', { credentials: 'same-origin' }).then(api => api.json()).then(data => { $('#toggle-ircut').checked = data; });
	});
	$('#toggle-light').addEventListener('click', () => {
		apiFetch('/night/light', { credentials: 'same-origin' }).then(api => api.json()).then(data => { $('#toggle-light').checked = data; });
	});

	// --- Live player (WebRTC or MSE, with MJPEG / no-signal fallback) ---
	const initial = $('#live-video');
	if (!initial || !window.MajesticVideo) return;
	const badge = $('#mj-badge'), img = $('#live-mjpeg'), note = $('#mj-note');
	let jpegOn = false;
	mjConfig().then(cfg => {
		jpegOn = mjGet(cfg, 'jpeg.enabled') === true;
		const subOk = mjGet(cfg, 'video1.enabled') === true;
		subAvailable = subOk;
		if (subOk) $('#mj-sub').hidden = false;
		// Auto only where there are two streams to choose between: with one
		// encoder configured there is nothing for it to decide.
		if (subOk && autoLbl) autoLbl.hidden = false;
		if (autoCtl) autoCtl.disabled = !subOk;
		// "WxH" per channel. Auto compares areas, so parse once.
		sizeOf = [0, 1].map(n => {
			const v = mjGet(cfg, 'video' + n + '.size');
			const m = /^(\d+)x(\d+)$/.exec(String(v || ''));
			return m ? (+m[1]) * (+m[2]) : null;
		});
		autoApply();
		// Same reason as the settings panel: the label is what gets hidden, and
		// the radio behind it stays in the tab order, so without this the
		// keyboard can pick a stream the camera does not have.
		if (s1) s1.disabled = !subOk;
		// Whether each channel will actually be adapted. Absent means an older
		// camera that has no such setting and always adapted, so only an
		// explicit false counts as pinned.
		adapts = [
			mjGet(cfg, 'video0.adjustBitrate') !== false,
			mjGet(cfg, 'video1.adjustBitrate') !== false,
		];
		syncTransportNote();
		ice = MajesticTransport.iceServers(
			mjGet(cfg, 'webrtc.iceServers'),
			mjGet(cfg, 'webrtc.turnUsername'),
			mjGet(cfg, 'webrtc.turnCredential'));
	});
	// The element the visible player owns. Swapped, not reassigned to a fixed
	// id, because both elements are real and either can be the live one.
	let liveEl = $('#live-video'), spareEl = $('#live-video-b');
	const cur = () => liveEl;

	const BARS = '#000 url(/a/preview.svg)';
	function showVideo() {
		const v = cur();
		if (v) { v.style.display = ''; v.style.background = '#000'; }
		if (img) { img.style.display = 'none'; img.src = ''; }
		if (note) note.style.display = 'none';
	}
	function showNoSignal() {
		const v = cur();
		if (v) { v.style.display = ''; v.style.background = BARS; }
		if (img) { img.style.display = 'none'; img.src = ''; }
		if (note) note.style.display = 'none';
		if (badge) badge.textContent = 'no signal';
	}
	function showFallback() {
		const v = cur();
		if (v) v.style.display = 'none';
		if (jpegOn && img) { img.src = '/mjpeg'; img.style.display = ''; if (note) note.style.display = 'none'; }
		else if (note) note.style.display = '';
		if (badge) badge.textContent = 'MJPEG';
	}

	const mute = $('#mj-mute'), muteLbl = $('#mj-mute-lbl'), volCtl = $('#mj-vol');
	const audioCtl = $('#mj-audio-ctl');
	const talkCtl = $('#mj-talk-ctl'), talk = $('#mj-talk'), talkLbl = $('#mj-talk-lbl');
	const statsCtl = $('#mj-stats-ctl'), statsBtn = $('#mj-stats-btn'), statsBox = $('#mj-stats');
	const TALK_TITLE = talkLbl ? talkLbl.title : '';
	const transportCtl = $('#mj-transport'), transportGrp = $('#mj-transport-ctl');
	const transportLbl = $('#mj-transport-lbl'), transportNote = $('#mj-transport-note');

	// What the toggle says when nothing has gone wrong. Kept because a failure
	// replaces it with the reason, and switching back has to put the explanation
	// there again rather than leave the tooltip stuck on a complaint about a
	// session that is long over.
	const TRANSPORT_TITLE = transportLbl ? transportLbl.title : '';

	// The bitrate adaptation is the thing worth disclosing. It is what makes
	// WebRTC work on a thin link, and it reaches past the person who switched it
	// on: the encoder is shared with everyone else watching that stream, and
	// with whatever is recording it. So say it where it cannot be missed, and
	// only while it is actually happening — a tooltip needs a pointer to find,
	// and this is not a detail for people who happen to own a mouse.
	function syncTransportNote() {
		// Only while it is true. The note is a disclosure, and a disclosure that
		// fires when nothing is happening teaches people to ignore it — the
		// camera does not touch a channel whose adjustBitrate is off, so saying
		// it is adapting that stream is simply wrong. Per channel, because the
		// two settings are independent and Main/Sub is one click apart.
		if (transportNote) {
			transportNote.hidden = !(usingWebRTC && adapts[stream ? 1 : 0]);
		}
		if (transportLbl && usingWebRTC) {
			transportLbl.title = TRANSPORT_TITLE;
		}
	}
	const s0 = $('#mj-stream-0'), s1 = $('#mj-stream-1');
	const autoCtl = $('#mj-stream-auto'), autoLbl = $('#mj-auto');

	// Which transport to try, and the memory behind it, both live in
	// preview-transport.js — the settings page needs the same rules and two
	// copies would drift. See that file for why each of them is what it is.
	const webrtcAvailable = MajesticTransport.available();
	const wantWebRTC = () => MajesticTransport.preferred() === 'webrtc';
	const rememberTransport = t => MajesticTransport.choose(t);
	const rememberDemotion = () => MajesticTransport.demote();

	// The player on screen and which transport it is, both kept in step by the
	// swap's onPromoted. Read by the controls, which act on what is playing
	// rather than on what is being tried.
	let player = null, usingWebRTC = false;
	// Carried across a transport switch, because a new player starts from its
	// defaults and the user's choices should outlive the machinery.
	let stream = 0, audioOn = false, vol = 1;
	// The camera's STUN/TURN configuration, filled when the config lands. Read
	// through a getter at every open(), so an attach that beat the fetch is
	// corrected by the first reconnect rather than staying host-candidates-only
	// for the life of the page.
	let ice = [];
	// Auto: pick the stream closest to the size this player is drawn at, and
	// follow the window. Sizes come from the config; sizeOf[n] is null until it
	// lands, which is what stops Auto choosing on a guess.
	let autoOn = false;
	let subAvailable = false;
	let sizeOf = [null, null];
	// At most one change a second, the reporter's own limit. A drag across a
	// boundary would otherwise cut the session on every frame of the resize.
	const AUTO_MIN_GAP_MS = 1000;
	let lastAutoAt = 0, autoTimer = null;
	// Per channel, filled when the config lands; true until then, which is what
	// a camera without the setting does.
	let adapts = [true, true];
	// Talkback is deliberately NOT carried across a transport switch or a
	// reattach. Everything else here is a preference; this one holds a live
	// microphone, and silently reopening it because the page rebuilt a player
	// is not a thing to do on a user's behalf.
	let talkbackConfigured = false;
	// Set once the Main/Sub control has been touched, so a slow config answer
	// cannot undo it.
	let userPickedStream = false;
	let audioConfigured = false;

	// Which attachment is the live one. Two things need it, and neither is
	// hypothetical:
	//
	// A player can report 'fallback' from inside attach() — MajesticWebRTC does
	// exactly that when RTCPeerConnection or addTransceiver throws — so the
	// handler runs, attaches MSE, and then the outer `player = impl.attach(…)`
	// assignment completes and overwrites the working MSE player with the dead
	// WebRTC façade nobody can now destroy.
	//
	// And a destroyed player is not a silent one. WebRTC's createOffer and
	// getStats continuations settle after close, so a transport switched away
	// from can still call onState and, seeing a `usingWebRTC` that has since
	// flipped, hide a video that is playing perfectly well.
	//
	// So the generation is stamped at attach and captured by that attachment's
	// handlers: a callback from a superseded player is dropped rather than
	// interpreted as if the current one had sent it.
	let attachSeq = 0;

	// Whether to offer the audio control at all: the camera has to have audio
	// configured and this transport has to be able to carry it. MSE can only
	// when the browser decodes a codec majestic can produce, so the answer
	// changes with the transport and is asked again on every attach.
	function syncAudioCtl() {
		if (!audioCtl) return;
		audioCtl.hidden = !(audioConfigured && player && player.audioSupported());
	}

	// Talkback needs three things at once, and each of them can be absent on
	// its own: the camera configured to play received audio, a transport that
	// carries a direction MSE has no concept of, and a secure context — a
	// browser hands over no microphone on plain HTTP, so the button would ask
	// for something it can never get.
	function syncTalkCtl() {
		if (!talkCtl) return;
		const ok = talkbackConfigured && player && player.micSupported();
		talkCtl.hidden = !ok;
		// Put the control back to rest, every time. A player destroyed while
		// its permission prompt was still up never reports an ending — the
		// grant lands in a closed player, which releases it silently — so
		// anything left over from 'asking' has to be cleared here or the
		// button stays disabled on "Asking…" until the page is reloaded.
		if (talk) { talk.checked = false; talk.disabled = false; }
		if (talkLbl) { talkLbl.textContent = '🎤 Talk'; talkLbl.title = TALK_TITLE; }
	}

	// The stats panel follows the transport rather than the person: MSE has
	// none of these numbers, so the button would open an empty box. The
	// checkbox keeps the person's answer across a transport switch, so the
	// panel has to come back with it rather than needing a second click.
	function syncStatsCtl() {
		if (statsCtl) statsCtl.hidden = !usingWebRTC;
		if (statsBox) {
			statsBox.hidden = !(usingWebRTC && statsBtn && statsBtn.checked);
		}
	}

	function showStats(s) {
		const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
		const cam = s.cam || {};
		set('#mj-st-pic', s.width
			? s.width + '×' + s.height + ' ' + (s.codec || '').toUpperCase() +
				' · ' + Math.round(s.fps || 0) + ' fps'
			: '-');
		set('#mj-st-rx', s.kbps + ' kbit/s' +
			(s.audioKbps ? ' · audio ' + s.audioKbps : ''));
		// Lost is cumulative and jitter is instantaneous, which is why they are
		// labelled rather than run together into one figure.
		set('#mj-st-loss', (s.packetsLost || 0) + ' pkt · ' + (s.jitterMs || 0) + ' ms');
		set('#mj-st-rtt', s.rttMs ? s.rttMs + ' ms' : '-');
		set('#mj-st-recov', (s.nack || 0) + ' nack · ' + (s.pli || 0) + ' keyframe req');
		set('#mj-st-cam', cam.ice
			? 'ice ' + cam.ice + ' · dtls ' + cam.dtls + ' · media ' + cam.media
			: '-');
		// The camera's own estimate of what this link will carry, which is what
		// it sets the encoder from — not a measurement of what arrived.
		set('#mj-st-remb', cam.remb || '-');
		set('#mj-st-pli', cam.pli || '-');
		set('#mj-st-ain', cam['audio-in'] || '-');
		// Both halves, because they answer different questions: the browser
		// says it sent, the camera says it arrived. A microphone that is on
		// with the camera's counter stuck at zero is the case worth seeing.
		set('#mj-st-talk', s.micWanted
			? (s.micSending ? 'sending' : 'offered, not accepted') +
				' · ' + (s.micPackets || 0) + ' pkt out'
			: 'off');
	}

	// Rebuilt rather than mutated when the transport changes: the two players
	// own different machinery, and the state worth carrying over is three
	// values.
	// Apply the preferences a fresh player does not know about, and put the
	// controls into the state it is actually in.
	function settle() {
		if (!player) return;
		// No setAudio() here: the player was opened with it. Calling it now
		// would be a no-op at best and a renegotiation at worst.
		player.setVolume(vol);
		syncAudioCtl();
		// The outgoing player's destroy() released the microphone, so talkback
		// comes back up off whatever the new one is doing.
		syncTalkCtl();
		syncStatsCtl();
		syncTransportNote();
	}

	// The swap itself lives in preview-swap.js — two elements, a trial that
	// costs the viewer nothing until it works. Everything below is what this
	// page does about the outcome, which is the part the settings panel does
	// differently.
	const swap = MajesticSwap({
		// Resolved on every use, never stored: the MSE player replaces its
		// element on each reconnect, so a node captured here would be detached
		// within a session and every show/hide would write to nothing.
		elements: [() => $('#live-video'), () => $('#live-video-b')],
		// audio and volume go in at attach rather than after promotion.
		// Applying them later means renegotiating a session that has just
		// proved itself, which blanks the picture for anyone who was listening
		// — the flicker this whole change removes, reintroduced at the last
		// step.
		open: (kind, el, id, onState) => MajesticVideoImpl(kind).attach(
			el, Object.assign(
				{ stream: stream, iceServers: () => ice,
					audio: audioOn, volume: vol },
				handlersFor(id, onState))),
		onPromoted: (kind) => {
			player = swap.player();
			usingWebRTC = kind === 'webrtc';
			liveEl = swap.element();
			settle();
			showVideo();
		},
		// A trial was dropped and the screen is untouched. All that changes is
		// the toggle, which has to come back up carrying the reason.
		onFailed: (kind, why, permanent) => {
			// The trial is gone and the live player is whatever it was. The
			// toggle has to describe that, not the transport that just failed
			// — including when the failure was MSE and WebRTC is still playing,
			// where leaving it unchecked would report the opposite of the truth
			// and make the stored preference retry the failure next load.
			if (kind !== 'webrtc') {
				if (swap.kind() === 'webrtc' && transportCtl) {
					transportCtl.checked = true;
					rememberTransport('webrtc');
				}
				return;
			}
			if (transportCtl) transportCtl.checked = false;
			// The reason first, because it is the news, then the standing
			// explanation — the tooltip is the only place either of them lives.
			if (transportLbl) {
				transportLbl.title =
					'WebRTC: ' + (why || 'unavailable') + '\n\n' + TRANSPORT_TITLE;
			}
			// 'busy' says the camera is full, which will not be true for long.
			// Only a real refusal is worth remembering, and even that expires.
			if (permanent) rememberDemotion();
		},
		// Nothing left on screen worth keeping. Try the other transport — from
		// WebRTC that means MSE, which plays what this browser's decoder takes
		// rather than what its WebRTC stack will negotiate, a strictly larger
		// set — and MJPEG if that already was the other transport.
		onExhausted: (kind) => {
			player = null;
			if (kind === 'webrtc') attachPlayer(false);
			else showFallback();
		},
		onLive: (s, d) => {
			if (s === 'playing') showVideo();
			else if (s === 'nosignal') showNoSignal();
			else if (s === 'mjpeg') showFallback();
			else if (s === 'fallback' || s === 'busy') {
				// The live player gave up mid-session. Staged like any other
				// switch, so its last frame stays until the replacement has one
				// of its own.
				if (usingWebRTC) {
					if (transportCtl) transportCtl.checked = false;
					if (transportLbl) {
						transportLbl.title = 'WebRTC: ' + (d || 'unavailable') +
							'\n\n' + TRANSPORT_TITLE;
					}
					if (s === 'fallback') rememberDemotion();
					swap.retire();
					attachPlayer(false);
				} else {
					showFallback();
				}
			}
			else if (badge) badge.textContent = (s === 'error') ? 'reconnecting…' : s + '…';
		},
	});

	const MajesticVideoImpl = (kind) =>
		kind === 'webrtc' ? MajesticWebRTC : MajesticVideo;

	function attachPlayer(webrtc) {
		swap.start(webrtc ? 'webrtc' : 'mse');
	}

	// The page's own callbacks, all of which belong to the player on screen: a
	// trial has no badge, no audio control and no talkback button to report to.
	// onState is the swap's, unchanged — it decides what a trial's states mean.
	function handlersFor(id, onState) {
		const isLive = () => swap.isLive(id);
		return {
			onState: onState,
			onCodec: (codec, cs, w, h) => {
				if (!isLive()) return;
				if (badge) {
					badge.textContent = codec.toUpperCase() + ' ' + w + '×' + h +
						(usingWebRTC ? ' · WebRTC' : '');
				}
			},
			// null means we asked for audio and the camera had none to give (mic
			// off or not producing). Reflect that on the control rather than
			// leaving the user staring at an unmute button that does nothing.
			onAudio: (codec) => {
				if (!isLive() || !mute) return;
				if (mute.checked && !codec) {
					muteLbl.textContent = '🔇 No audio';
					mute.checked = false;
					audioOn = false;
					if (volCtl) volCtl.disabled = true;
				}
			},
			// 'asking' while the browser's permission prompt is up, 'on' once
			// the camera has accepted the direction, 'off' for every way it
			// ends — refused, unplugged, revoked, or declined by a camera with
			// audio.outputEnabled off. The reason rides along and goes in the
			// tooltip, which is the only place it lives.
			// Four states, and the middle one earns its place: 'asking' while
			// the browser's prompt is up, 'live' once the microphone is
			// capturing but the camera has not answered yet, 'on' when it has
			// accepted, 'off' for every ending. Reporting 'on' at the moment
			// of capture would say "Talking" over a session that has not
			// offered the track yet, and might still be refused.
			//
			// 'live' leaves the button enabled, unlike 'asking': the
			// microphone is running by then, and a control that cannot stop a
			// running microphone is the wrong control.
			onMic: (state, why) => {
				if (!isLive() || !talk) return;
				talk.checked = state === 'on' || state === 'live';
				talk.disabled = state === 'asking';
				if (talkLbl) {
					talkLbl.textContent = state === 'asking' ? '🎤 Asking…'
						: state === 'live' ? '🎤 Connecting…'
						: state === 'on' ? '🎤 Talking' : '🎤 Talk';
					talkLbl.title = why ? why + '\n\n' + TALK_TITLE : TALK_TITLE;
				}
				// Only once the camera has accepted. Talking opens its audio
				// too — it refuses a one-way audio section — so the listen
				// control follows what was negotiated rather than what was
				// asked for.
				if (state === 'on' && mute && !mute.checked) {
					mute.checked = true;
					audioOn = true;
					muteLbl.textContent = '🔊 Listening';
					if (volCtl) volCtl.disabled = false;
				}
			},
			onStats: (s) => {
				if (!isLive() || !statsBox || statsBox.hidden) return;
				showStats(s);
			},
		};
	}

	// Start on the substream, which is the convention this equipment is built
	// around: the main channel carries the best picture the sensor can give and
	// is what an NVR or the SD card records, while the substream exists to be
	// watched over whatever link happens to be available. Previewing the
	// channel that is being recorded, and then adapting its bitrate down to
	// suit one browser, is the wrong way round.
	//
	// It also settles most of what a bitrate opt-out would have been for: the
	// adaptation now lands on the channel whose job is preview. Main is one
	// click away for anyone who wants to look closely, and the note under the
	// toggle says what that costs.
	//
	// Gated on video1.enabled rather than assumed, because the two transports
	// disagree about what a missing stream means. WebRTC treats ?stream=N as a
	// preference and falls back to a channel it can serve; /ws/video subscribes
	// to whatever number it is given and simply delivers nothing, which reads
	// as "no signal" rather than as a misconfiguration.
	// ...but not at the cost of starting at all. mjConfig() is memoised and the
	// night-mode controls asked for it before this ran, so in practice the
	// answer is already here. On the link this default exists for it might not
	// be, and /api/v1/config.json has no timeout of its own — a request that
	// hangs would leave the page blank for as long as the tab is open, which is
	// a worse failure than starting on the wrong channel.
	//
	// So: attach as soon as we know, or after this deadline regardless.
	const CONFIG_WAIT_MS = 1500;

	// Whether the deadline won and we picked a stream without being told.
	let attachedBlind = false;

	// Which stream best fits the box this player is drawn in.
	//
	// By area, not by width: a 704x576 substream and a 1280x720 main stream are
	// not ordered the same way by one dimension as by the picture they carry,
	// and it is pixels that cost bandwidth.
	//
	// CSS pixels rather than device pixels, deliberately. On a 2x display the
	// larger stream is sharper, but this exists for links that cannot carry the
	// larger stream at all, and doubling the demand on every phone is the wrong
	// side to err on.
	//
	// Nearest at or above the target, else the largest below it — the
	// reporter's rule, and the right way round: scaling a bigger picture down
	// loses nothing visible, scaling a smaller one up does.
	function autoPick() {
		const el = swap.element() || cur();
		const want = el ? el.clientWidth * el.clientHeight : 0;
		if (!want) return null;   // not laid out yet; ask again later
		const options = [];
		for (let n = 0; n < 2; n++) {
			if (sizeOf[n] && (n === 0 || subAvailable)) {
				options.push({ n: n, area: sizeOf[n] });
			}
		}
		if (!options.length) return null;
		const atLeast = options.filter(o => o.area >= want);
		if (atLeast.length) {
			return atLeast.reduce((a, b) => (b.area < a.area ? b : a)).n;
		}
		return options.reduce((a, b) => (b.area > a.area ? b : a)).n;
	}

	// Act on it, subject to the rate limit. Called on resize and whenever the
	// numbers behind the decision change.
	function autoApply() {
		if (!autoOn) return;
		const want = autoPick();
		if (want === null || want === stream) return;
		const wait = AUTO_MIN_GAP_MS - (Date.now() - lastAutoAt);
		if (wait > 0) {
			// Not dropped, deferred: the size that triggered this is the size
			// it still is, and forgetting it would leave the wrong stream up
			// until the next time the window happened to move.
			clearTimeout(autoTimer);
			autoTimer = setTimeout(autoApply, wait);
			return;
		}
		lastAutoAt = Date.now();
		goToStream(want);
	}

	// Which channel to open on: what this browser last chose, or the substream.
	//
	// A remembered choice outranks the default but not reality — a browser that
	// picked Sub on a camera which has since lost video1 opens on Main rather
	// than on nothing. Returns true if the channel moved off Main.
	function chooseSub(cfg) {
		const remembered = MajesticTransport.chosenStream('preview');
		if (remembered === 'auto' && subAvailable) {
			autoOn = true;
			if (autoCtl) autoCtl.checked = true;
			const pick = autoPick();
			// A size the page cannot measure yet leaves Auto on the substream,
			// which is the default it would otherwise have had; the first
			// resize or the layout settling corrects it.
			stream = pick === null ? 1 : pick;
			return stream === 1;
		}
		const want = remembered === null ? 1 : remembered;
		if (want !== 1 || !subAvailable) {
			stream = 0;
			if (s0) s0.checked = true;
			return false;
		}
		stream = 1;
		if (s1) s1.checked = true;
		return true;
	}

	Promise.race([
		mjConfig(),
		new Promise(done => setTimeout(() => done(null), CONFIG_WAIT_MS)),
	]).then(cfg => {
		if (cfg) chooseSub(cfg); else attachedBlind = true;
		attachPlayer(wantWebRTC());
	});

	// If the deadline won, put it right when the answer turns up — but not if
	// the person watching has since chosen a stream themselves. Correcting a
	// default is helpful; overriding a decision is not.
	mjConfig().then(cfg => {
		if (!attachedBlind) return;
		// The stream, unless the person has since chosen one themselves:
		// correcting a default is helpful, overriding a decision is not.
		const moved = !userPickedStream && chooseSub(cfg);
		if (moved && player) player.setStream(stream);
		// The note follows the channel, and this is the one path that changes
		// the channel without going through attachPlayer(). A camera whose two
		// channels differ would otherwise disclose Main's setting while playing
		// Sub, until something else happened to re-sync it.
		syncTransportNote();

		// The ICE list, unconditionally. A blind attach opened with an empty
		// one, and the getter is only read when a session opens — so without
		// this the first session runs on host candidates alone until something
		// else happens to reconnect it. Off-LAN that session cannot work: it
		// negotiates, carries nothing, and spends the full no-signal timeout
		// finding out, which is exactly the sequence that demotes a browser to
		// MSE. Skipped when setStream() has already reopened for the stream
		// change, and when there is nothing to apply.
		// Not while a trial is being judged: that trial is the viewer's own
		// choice in flight, and it was opened after `ice` was filled anyway, so
		// restarting WebRTC here would both undo their click and re-do work.
		if (!moved && player && !swap.trial() && usingWebRTC && ice.length) {
			attachPlayer(true);
		}
	});

	if (transportCtl && transportGrp && webrtcAvailable) {
		transportGrp.hidden = false;
		// From the preference rather than from usingWebRTC, which the deferred
		// attach above has not set yet.
		transportCtl.checked = wantWebRTC();
		transportCtl.addEventListener('change', () => {
			rememberTransport(transportCtl.checked ? 'webrtc' : 'mse');
			attachPlayer(transportCtl.checked);
		});
	}

	// Guarded because the first attach waits on the config fetch, and nothing
	// stops a fast set of fingers reaching these first.
	//
	// The flag is armed on click rather than on change, and that distinction is
	// the whole point of it: clicking the radio that is already selected fires
	// no change event, so someone who starts on Main and presses Main — because
	// that is the one they want — would otherwise look identical to someone who
	// pressed nothing, and a late config answer would move them to Sub. A click
	// is an expression of intent whether or not it alters anything.
	// Recorded on click for the same reason the flag is: pressing the radio that
	// is already selected is still an answer, and it is the one that has to be
	// remembered — someone whose camera crops video0, or whose substream is
	// sized nothing like the preview box, wants Main and should say so once
	// rather than on every page load.
	// Everything a channel change has to reach: the player on screen, any trial
	// being judged — a trial keeps the stream it was opened with, so otherwise
	// it would be promoted onto the channel the viewer had already left — and
	// the adaptation notice, which is per channel.
	function goToStream(n) {
		stream = n;
		if (player) player.setStream(n);
		const t = swap.trial();
		if (t) t.setStream(n);
		syncTransportNote();
	}
	if (s0) s0.addEventListener('change', () => { autoOn = false; goToStream(0); });
	if (s1) s1.addEventListener('change', () => { autoOn = false; goToStream(1); });
	if (autoCtl) autoCtl.addEventListener('change', () => {
		autoOn = autoCtl.checked;
		if (!autoOn) return;
		// Acting immediately rather than waiting for a resize: the person just
		// asked for the best fit, and the window is already the size it is.
		lastAutoAt = 0;
		autoApply();
	});
	// Recorded on click rather than change: pressing the radio that is already
	// selected fires no change event and is still an answer — the one that has
	// to be remembered, for someone whose video0 is cropped or whose substream
	// is sized nothing like the preview box.
	[s0, s1, autoCtl].forEach((el, n) => {
		if (el) el.addEventListener('click', () => {
			userPickedStream = true;
			MajesticTransport.chooseStream('preview', n === 2 ? 'auto' : n);
		});
	});

	// Follow the window. Debounced because a drag fires this continuously, and
	// the rate limit in autoApply() is what keeps the session from being cut
	// more than once a second even so.
	let resizeTimer = null;
	window.addEventListener('resize', () => {
		if (!autoOn) return;
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(autoApply, 250);
	});

	// Audio: revealed only when the camera has it configured and the transport
	// in use can carry it — otherwise the button is a dead end.
	if (audioCtl && mute) {
		mjConfig().then(cfg => {
			audioConfigured = mjGet(cfg, 'audio.enabled') === true;
			syncAudioCtl();
		});
		mute.addEventListener('change', () => {
			const on = mute.checked;
			audioOn = on;
			if (!player) return;
			player.setAudio(on);
			muteLbl.textContent = on ? '🔊 Listening' : '🔇 Muted';
			if (volCtl) volCtl.disabled = !on;
		});
		if (volCtl) volCtl.addEventListener('input', () => {
			vol = volCtl.value / 100;
			// Kept even with no player yet: attachPlayer() applies it.
			if (player) player.setVolume(vol);
		});
	}

	// Talkback: the camera has to be configured to play what it receives.
	// audio.enabled alone is the microphone; outputEnabled is the speaker, and
	// this is the one that decides whether the far end has anywhere to put our
	// audio. A camera with it off answers the session without our direction and
	// the player reports that back through onMic.
	if (talkCtl && talk) {
		mjConfig().then(cfg => {
			talkbackConfigured = mjGet(cfg, 'audio.outputEnabled') === true;
			syncTalkCtl();
		});
		talk.addEventListener('change', () => {
			if (!player) { talk.checked = false; return; }
			// The player owns the answer, not the checkbox: a refused
			// permission or a camera that declines leaves this unchecked
			// again through onMic, and setting the label here would flash a
			// state that never happened.
			player.setMic(talk.checked);
		});
	}

	if (statsBtn && statsBox) {
		// Through the same helper the transport switch uses, so "is the panel
		// showing" has one answer and not two that have to agree.
		statsBtn.addEventListener('change', syncStatsCtl);
	}
})();
