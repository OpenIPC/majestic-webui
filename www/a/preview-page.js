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
		if (subOk) $('#mj-sub').hidden = false;
		// Same reason as the settings panel: the label is what gets hidden, and
		// the radio behind it stays in the tab order, so without this the
		// keyboard can pick a stream the camera does not have.
		if (s1) s1.disabled = !subOk;
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
		if (transportNote) {
			transportNote.hidden = !usingWebRTC;
		}
		if (transportLbl && usingWebRTC) {
			transportLbl.title = TRANSPORT_TITLE;
		}
	}
	const s0 = $('#mj-stream-0'), s1 = $('#mj-stream-1');

	// Which transport to try, and the memory behind it, both live in
	// preview-transport.js — the settings page needs the same rules and two
	// copies would drift. See that file for why each of them is what it is.
	const webrtcAvailable = MajesticTransport.available();
	const wantWebRTC = () => MajesticTransport.preferred() === 'webrtc';
	const rememberTransport = t => MajesticTransport.choose(t);
	const rememberDemotion = () => MajesticTransport.demote();

	// What is on screen, and what is being tried out of sight.
	//
	// A transport switch used to tear down the working player before anything
	// knew whether its replacement would run, so a refusal cost a blank element
	// and a visible reconnect on the way back. Now the new player attaches to
	// the idle element and the old one keeps playing until the new one has a
	// picture: a success looks like nothing happened, and a failure looks like
	// nothing happened either, because nothing did.
	//
	// Each attachment carries its own id rather than sharing one counter. Both
	// players are live at once during a swap, and the outgoing one has to go on
	// working — a single "is this the current generation" test cannot say that
	// about two things at the same time.
	let player = null, usingWebRTC = false;
	let attach = null;   // { id, p, el, webrtc } — on screen
	let staging = null;  // { id, p, el, webrtc } — on trial, hidden
	// Carried across a transport switch, because a new player starts from its
	// defaults and the user's choices should outlive the machinery.
	let stream = 0, audioOn = false, vol = 1;
	// The camera's STUN/TURN configuration, filled when the config lands. Read
	// through a getter at every open(), so an attach that beat the fetch is
	// corrected by the first reconnect rather than staying host-candidates-only
	// for the life of the page.
	let ice = [];
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
		if (audioOn && player.audioSupported()) player.setAudio(true);
		player.setVolume(vol);
		syncAudioCtl();
		// The outgoing player's destroy() released the microphone, so talkback
		// comes back up off whatever the new one is doing.
		syncTalkCtl();
		syncStatsCtl();
		syncTransportNote();
	}

	// Take over the screen. The outgoing player is destroyed only here, once
	// its replacement has a picture — which is the whole point.
	function promote() {
		const s = staging;
		staging = null;
		if (attach) {
			try { attach.p.destroy(); } catch (e) {}
			attach.el.style.display = 'none';
		}
		attach = s;
		player = s.p;
		usingWebRTC = s.webrtc;
		liveEl = s.el;
		spareEl = (s.el === $('#live-video')) ? $('#live-video-b') : $('#live-video');
		settle();
		showVideo();
	}

	// The trial failed. Throw it away and leave the screen exactly as it was —
	// unless what is on screen is already dead, in which case there is nothing
	// left to protect and this is the end of the chain.
	function dropStaging(why, permanent) {
		const s = staging;
		staging = null;
		if (s) { try { s.p.destroy(); } catch (e) {} }
		if (s && s.webrtc) {
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
		}
		// Is there still something worth keeping? Two ways there is not: the
		// first attach failed, so nothing ever played; or the live player gave
		// up and this was its replacement, so the picture on screen is a frozen
		// last frame rather than a running session.
		if (attach && !attach.dead) return;
		if (attach) {
			try { attach.p.destroy(); } catch (e) {}
			attach = null;
			player = null;
		}
		// Try the other transport, and MJPEG if that already was the other one.
		if (s && s.webrtc) attachPlayer(false);
		else showFallback();
	}

	function attachPlayer(webrtc) {
		// One trial at a time: a second click while the first is still being
		// judged would leave the first running with nothing tracking it.
		if (staging) { try { staging.p.destroy(); } catch (e) {} staging = null; }

		const id = ++attachSeq;
		const el = attach ? spareEl : liveEl;
		const impl = webrtc ? MajesticWebRTC : MajesticVideo;
		// MSE leaves a MediaSource object URL behind and WebRTC uses srcObject;
		// an element carrying both is a confusing thing to debug, and this one
		// may have been used by the other transport a moment ago.
		try { el.removeAttribute('src'); el.srcObject = null; } catch (e) {}

		staging = { id: id, p: null, el: el, webrtc: !!webrtc };
		const p = impl.attach(el, Object.assign(
			{ stream: stream, iceServers: () => ice }, handlersFor(id)));

		// attach() can report 'fallback' before returning — MajesticWebRTC does
		// exactly that when RTCPeerConnection or addTransceiver throws — so the
		// handler has already run and thrown this attempt away. Assigning now
		// would resurrect it.
		if (!staging || staging.id !== id) {
			try { p.destroy(); } catch (e) {}
			return;
		}
		staging.p = p;

		// Nothing on screen to protect: this is the first attach, so the trial
		// is the live player and the usual state applies to it immediately.
		if (!attach) {
			promote();
		}
	}
	function handlersFor(id) {
		const isLive = () => attach !== null && attach.id === id;
		const isStaged = () => staging !== null && staging.id === id;
		return {
			// A staged player owns nothing on screen, so it reports only two
			// things that matter: it worked, or it did not. Everything in
			// between — connecting, no signal, reconnecting — is exactly what
			// must NOT reach the page, because the whole point is that trying
			// costs the viewer nothing until it succeeds.
			onState: (s, d) => {
				if (isStaged()) {
					if (s === 'playing') promote();
					else if (s === 'fallback' || s === 'busy' || s === 'mjpeg') {
						// 'mjpeg' is MSE saying it is out of options, which for
						// a trial is just another way of failing.
						dropStaging(d, s === 'fallback');
					}
					return;
				}
				if (!isLive()) return;
				if (s === 'playing') showVideo();
				else if (s === 'nosignal') showNoSignal();
				else if (s === 'mjpeg') showFallback();
				else if (s === 'fallback' || s === 'busy') {
					// The live player gave up mid-session. Try the other
					// transport — from WebRTC that means MSE, which plays what
					// this browser's decoder takes rather than what its WebRTC
					// stack will negotiate, a strictly larger set.
					//
					// Staged like any other switch, so the last frame stays
					// until the replacement has one. If MSE cannot run either,
					// its own trial fails and lands on MJPEG.
					if (usingWebRTC) {
						if (transportCtl) transportCtl.checked = false;
						if (transportLbl) {
							transportLbl.title = 'WebRTC: ' +
								(d || 'unavailable') + '\n\n' + TRANSPORT_TITLE;
						}
						if (s === 'fallback') rememberDemotion();
						// Its picture is a frozen frame from here on. Say so,
						// or a replacement that also fails would leave it on
						// screen for ever with nothing to move it to MJPEG.
						attach.dead = true;
						attachPlayer(false);
					} else {
						showFallback();
					}
				}
				else if (badge) badge.textContent = (s === 'error') ? 'reconnecting…' : s + '…';
			},
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

	// Which channel to open on: what this browser last chose, or the substream.
	//
	// A remembered choice outranks the default but not reality — a browser that
	// picked Sub on a camera which has since lost video1 opens on Main rather
	// than on nothing. Returns true if the channel moved off Main.
	function chooseSub(cfg) {
		const subAvailable = mjGet(cfg, 'video1.enabled') === true;
		const remembered = MajesticTransport.chosenStream('preview');
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

		// The ICE list, unconditionally. A blind attach opened with an empty
		// one, and the getter is only read when a session opens — so without
		// this the first session runs on host candidates alone until something
		// else happens to reconnect it. Off-LAN that session cannot work: it
		// negotiates, carries nothing, and spends the full no-signal timeout
		// finding out, which is exactly the sequence that demotes a browser to
		// MSE. Skipped when setStream() has already reopened for the stream
		// change, and when there is nothing to apply.
		if (!moved && player && usingWebRTC && ice.length) attachPlayer(true);
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
	[s0, s1].forEach((el, n) => {
		if (el) el.addEventListener('click', () => {
			userPickedStream = true;
			MajesticTransport.chooseStream('preview', n);
		});
	});
	if (s0) s0.addEventListener('change', () => {
		stream = 0;
		if (player) player.setStream(0);
	});
	if (s1) s1.addEventListener('change', () => {
		stream = 1;
		if (player) player.setStream(1);
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
