// The camera's MJPEG stream, as a rung of the transport ladder.
//
// This used to be the Preview page's terminal fallback: a bare
// `img.src = '/mjpeg'` written from showFallback(), outside the swap, with its
// own visibility flag and its own retry path. That was survivable while it was
// the last thing tried and there was only ever one camera. It is not any more.
// A USB webcam publishing MJPEG is a SOURCE, not a failure — for many of them
// it is the only thing they publish — so the same picture now has to be
// reachable as a first choice, on an element the swap owns, for a camera other
// than the on-board one. Two code paths to the same stream would drift.
//
// NOT NAMED 'mjpeg'. That string is already a player STATE code meaning "this
// rung gave up, show the fallback" (preview.js, preview-swap.js), so a
// transport kind of the same name would collide in every onState handler on
// both pages. The kind is `multipart`, after the multipart/x-mixed-replace
// response it actually reads.
//
// WHAT IT BUYS. It plays where nothing else can: no MediaSource, no WebRTC, no
// WebCodecs, no codec negotiation — an <img> and an HTTP response. That is the
// whole reason it is the bottom of the ladder, and the reason a source with
// nothing but an MJPEG stream is watchable at all.
//
// WHAT IT COSTS. A whole JPEG per frame, so the bitrate is several times the
// same picture in H.264 and there is no keyframe/delta structure to exploit. No
// audio, no talkback, no seek, no statistics worth the name — every control the
// bar can offer over this is off, and says so rather than sitting there dead.
window.MajesticMultipart = (function () {
	'use strict';

	// How long to wait for the first frame before calling it. Generous: the
	// camera encodes this one on demand, and on a busy SoC with the main
	// encoder running the first JPEG can take a moment. Shorter than the WebRTC
	// no-signal window because there is no negotiation to wait through.
	const NO_SIGNAL_MS = 6000;

	// Every transport in this UI is attached with a stream_id, so this one is
	// too — a caller should not have to know which of them speaks a different
	// language. The camera is derived from it, because /mjpeg takes a CAMERA in
	// ?channel=: there is one MJPEG stream per camera and no subtype to choose
	// between. Camera 0 is served at the bare path.
	function cameraOf(streamId) { return Math.floor((streamId | 0) / 3); }

	// The cache-buster is not about caching. Assigning an identical `src` is a
	// no-op in some engines, so a retry onto the same element would silently
	// never reopen the connection.
	function urlFor(camera) {
		const q = [];
		if ((camera | 0) > 0) q.push('channel=' + (camera | 0));
		q.push('t=' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
		return '/mjpeg?' + q.join('&');
	}

	function attach(el, opts) {
		opts = opts || {};
		const onState = opts.onState || function () {};
		const onCodec = opts.onCodec || function () {};
		const onAudio = opts.onAudio || function () {};
		let camera = cameraOf(opts.stream);
		let dead = false, playing = false, timer = null;

		// Once, at attach, rather than a control left standing that does
		// nothing: this transport carries no audio and cannot be made to.
		onAudio(null);
		onState('connecting');

		function clear() {
			if (timer) { clearTimeout(timer); timer = null; }
		}

		// Stop the connection, not just the picture. An <img> holding a
		// multipart src is a live HTTP response the camera goes on encoding
		// frames for — removing the element from view does not end it, and on a
		// camera with a session budget an abandoned one is a session nobody can
		// have back. removeAttribute and not src='': the empty string resolves
		// against the document and re-requests the page itself.
		function stop() {
			clear();
			try {
				el.removeAttribute('src');
			} catch (e) {}
		}

		function die(reason) {
			if (dead) return;
			dead = true;
			stop();
			// The last frame stays painted on an <img> the way it does on a
			// canvas, and a frozen frame is not a measurement of anything
			// current. Withdraw the claim for whatever is sampling it.
			try { el.__mjPainted = false; } catch (e) {}
			// 'mjpeg' is the vocabulary's "this rung gave up". There is nothing
			// below this one, so a caller's walk has to treat kind `multipart`
			// as terminal — see nextRung() on either page.
			if (reason) onState('mjpeg', reason);
		}

		function onLoad() {
			if (dead) return;
			clear();
			try { el.__mjPainted = true; } catch (e) {}
			if (playing) return;
			playing = true;
			// (codec, codecString, width, height) — the same four the MSE and
			// WebRTC players report, so the chip reads the same kind of
			// sentence whoever is carrying the picture. The geometry comes
			// from the image: nothing negotiated it, and the configured size
			// may not be what the camera actually sent.
			onCodec('mjpeg', 'mjpeg', el.naturalWidth || 0, el.naturalHeight || 0);
			onState('playing');
		}

		function onError() {
			die('unreachable');
		}

		el.addEventListener('load', onLoad);
		el.addEventListener('error', onError);

		timer = setTimeout(function () {
			timer = null;
			if (!playing) die('no-frames');
		}, NO_SIGNAL_MS);

		el.src = urlFor(camera);

		return {
			// A different CAMERA is a different URL; a different subtype of the
			// same camera is not, because there is one MJPEG stream per camera.
			// So a channel change reaches this and correctly does nothing,
			// rather than tearing down a working picture to fetch the same one.
			setStream: function (n) {
				if (dead) return;
				const next = cameraOf(n);
				if (next === camera) return;
				camera = next;
				playing = false;
				el.src = urlFor(next);
			},
			// Nothing to ask for: every frame is a whole picture.
			requestIdr: function () {},
			setAudio: function () {},
			setVolume: function () {},
			audioSupported: function () { return false; },
			setMic: function () {},
			micSupported: function () { return false; },
			destroy: function () {
				if (dead) return;
				dead = true;
				el.removeEventListener('load', onLoad);
				el.removeEventListener('error', onError);
				stop();
			},
			supported: true,
		};
	}

	// An <img> and an HTTP response; there is no browser this needs a capability
	// check for. Whether it is worth TRYING is a different question and not this
	// one — that depends on whether the camera has an MJPEG stream to serve, and
	// it is asked through MajesticTransport.multipartRungFor().
	return { attach: attach, available: true };
})();
