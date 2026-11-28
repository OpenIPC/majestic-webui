// preview-sound.js: the sound-only session beside a picture that has none.
//
// Admitted for the reason talkback.test.js is. Each failure here is silent:
// - a companion left open is the camera encoding Opus for nobody;
// - one opened under a staged trial is two soundtracks for a second;
// - one whose failure reached the page's onState is the fallback chain
//   walking away from a picture that was playing;
// - one that outlives destroy() is a microphone nobody can stop.
// Seeing any of them needs an H.265 camera, a browser without a hardware
// decoder and the timing of a swap. Here the picture and the WebRTC player
// are stubs that record what was asked of them.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = path.join(__dirname, '..', 'www', 'a', 'preview-sound.js');

function makeEnv(o) {
	o = o || {};
	const env = { sessions: [], appended: [] };
	const rtc = {
		available: o.rtc !== false,
		micAvailable: () => o.rtc !== false && o.mic !== false,
		attach(el, opts) {
			const s = {
				el: el, opts: opts, destroyed: false, audio: [], mic: [],
				volume: opts.volume, stream: opts.stream,
				setAudio(on) { this.audio.push(on); },
				setVolume(v) { this.volume = v; },
				setStream(n) { this.stream = n; },
				setMic(on) { this.mic.push(on); },
				destroy() { this.destroyed = true; },
			};
			env.sessions.push(s);
			// No RTCPeerConnection, say: the player gives up inside attach().
			if (o.failFirst && env.sessions.length === 1) opts.onState('fallback', 'RTCPeerConnection failed');
			return s;
		},
	};
	const document = {
		createElement(tag) {
			const el = { tag: tag, removed: false, remove() { this.removed = true; } };
			return el;
		},
		body: { appendChild(el) { env.appended.push(el); } },
	};
	const win = { isSecureContext: o.secure !== false };
	if (o.rtc !== 'absent') win.MajesticWebRTC = rtc;
	const ctx = { window: win, document: document, console };
	ctx.globalThis = ctx;
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
	env.Sound = win.MajesticSound;
	env.page = { states: [], audio: [], mic: [] };
	env.open = function (extra) {
		const opts = Object.assign({
			stream: 0, volume: 0.4, audio: false, iceServers: () => [],
			onState: (s) => env.page.states.push(s),
			onAudio: (c) => env.page.audio.push(c),
			onMic: (s, why) => env.page.mic.push(s),
		}, extra || {});
		env.picture = null;
		const p = env.Sound.beside((po) => {
			// Closures, not `this`, like the real players: the wrapper
			// copies these members onto an object of its own.
			const pic = env.picture = {
				opts: po, destroyed: false, stream: po.stream,
				setStream: (n) => { pic.stream = n; },
				requestIdr: () => { pic.idr = true; },
				setAudio() {}, setVolume() {},
				audioSupported() { return false; },
				setMic() {}, micSupported() { return false; },
				destroy: () => { pic.destroyed = true; },
				supported: true,
			};
			return env.picture;
		}, opts);
		env.play = () => env.picture.opts.onState('playing');
		return p;
	};
	return env;
}

const live = (env) => env.sessions.filter((s) => !s.destroyed);

function nothingBeforePlaying() {
	group('a staged picture opens no session until it has played');
	const env = makeEnv();
	env.open({ audio: true });
	check('Listen already on, picture not playing: no session', env.sessions.length === 0);
	env.picture.opts.onState('connecting');
	check('still none while connecting', env.sessions.length === 0);
	env.play();
	check('one sound-only session once it plays', live(env).length === 1);
	const s = env.sessions[0];
	check('it is sound only', s.opts.audioOnly === true);
	check('opened listening', s.opts.audio === true);
	check('at the volume set before it existed', s.volume === 0.4);
	check('the page still heard the picture\'s states',
		env.page.states.join(',') === 'connecting,playing', env.page.states.join(','));
	env.play();
	check('a second playing opens no second session', env.sessions.length === 1);
}

function listenOpensAndCloses() {
	group('Listen opens the session and Listen off closes it');
	const env = makeEnv();
	const p = env.open();
	env.play();
	check('nobody listening: no session', env.sessions.length === 0);
	p.setVolume(0.7);
	p.setAudio(true);
	check('Listen on: one session', live(env).length === 1);
	check('at the volume set while closed', env.sessions[0].volume === 0.7);
	p.setVolume(0.2);
	check('volume reaches the open session', env.sessions[0].volume === 0.2);
	p.setAudio(false);
	check('Listen off: closed', live(env).length === 0);
	check('its element removed', env.sessions[0].el.removed === true);
	p.setAudio(true);
	check('Listen on again: a fresh session', live(env).length === 1 && env.sessions.length === 2);
}

function talkAlone() {
	group('Talk alone opens it; the camera\'s accept ticks Listen; Talk off then keeps it');
	const env = makeEnv();
	const p = env.open();
	env.play();
	p.setMic(true);
	check('Talk on: one session', live(env).length === 1);
	const s = env.sessions[0];
	check('opened muted (nobody asked to listen)', s.opts.audio === false);
	check('the microphone was asked for', s.mic.join(',') === 'true', s.mic.join(','));
	s.opts.onMic('live', '');
	s.opts.onMic('on', '');
	check('the page heard live then on', env.page.mic.join(',') === 'live,on', env.page.mic.join(','));
	check('the accept unmuted the session, as the page now shows Listening',
		s.audio.join(',') === 'true', s.audio.join(','));
	p.setMic(false);
	check('Talk off while listening: session kept', live(env).length === 1);
	check('and asked to drop the microphone', s.mic.join(',') === 'true,false', s.mic.join(','));
	p.setAudio(false);
	check('then Listen off: closed', live(env).length === 0);
}

function talkOffNobodyListening() {
	group('Talk off with Listen off closes the session and says the microphone is off');
	const env = makeEnv();
	const p = env.open();
	env.play();
	p.setMic(true);
	const s = env.sessions[0];
	// The camera has not accepted yet: Listen was never ticked.
	p.setMic(false);
	check('closed (destroy releases the microphone)', s.destroyed === true);
	check('the page was told off', env.page.mic[env.page.mic.length - 1] === 'off', env.page.mic.join(','));
}

function talkBeforePlaying() {
	group('Talk asked for before the picture played is asked when it does');
	const env = makeEnv();
	const p = env.open();
	p.setMic(true);
	check('no session yet', env.sessions.length === 0);
	env.play();
	check('one session on playing', live(env).length === 1);
	check('and the microphone asked for once', env.sessions[0].mic.join(',') === 'true',
		env.sessions[0].mic.join(','));
}

function companionFailure() {
	group('a companion that gives up is no audio, never a picture state');
	for (const terminal of ['fallback', 'busy']) {
		const env = makeEnv();
		const p = env.open({ audio: true });
		env.play();
		const s = env.sessions[0];
		p.setMic(true);
		s.opts.onState('connecting');
		s.opts.onState('error');
		s.opts.onState('nosignal');
		check(terminal + ': its transient states change nothing', live(env).length === 1);
		s.opts.onState(terminal, 'why');
		check(terminal + ': the page\'s onState saw only the picture',
			env.page.states.join(',') === 'playing', env.page.states.join(','));
		check(terminal + ': reported as no audio', env.page.audio.length === 1 && env.page.audio[0] === null,
			JSON.stringify(env.page.audio));
		check(terminal + ': and the microphone off', env.page.mic[env.page.mic.length - 1] === 'off');
		check(terminal + ': the session destroyed', s.destroyed === true);
		check(terminal + ': the picture left alone', env.picture.destroyed === false);
	}
}

function pictureAudioSwallowed() {
	group('the picture\'s own "no audio" does not reach the page');
	const env = makeEnv();
	env.open({ audio: true });
	env.picture.opts.onAudio(null);
	check('swallowed', env.page.audio.length === 0, JSON.stringify(env.page.audio));
}

function streamAndDestroy() {
	group('setStream reaches both; destroy takes both');
	const env = makeEnv();
	const p = env.open({ audio: true });
	env.play();
	p.setStream(3);
	check('picture moved', env.picture.stream === 3);
	check('session moved', env.sessions[0].stream === 3);
	p.requestIdr();
	check('everything else is the picture\'s', env.picture.idr === true);
	p.destroy();
	check('session destroyed', env.sessions[0].destroyed === true);
	check('picture destroyed', env.picture.destroyed === true);
	env.play();
	check('a late playing opens nothing after destroy', env.sessions.length === 1);
}

function lateCallbacksIgnored() {
	group('a closed session\'s late callbacks change nothing');
	const env = makeEnv();
	const p = env.open({ audio: true });
	env.play();
	const old = env.sessions[0];
	p.setAudio(false);
	p.setAudio(true);
	old.opts.onState('fallback', 'late');
	old.opts.onAudio(null);
	check('the new session survives the old one\'s failure', live(env).length === 1);
	check('and the page heard nothing of it', env.page.audio.length === 0);
}

function supportAnswers() {
	group('what the control is told');
	let env = makeEnv();
	let p = env.open();
	check('WebRTC present: sound offered', p.audioSupported() === true);
	check('and talk, where the browser has a microphone', p.micSupported() === true);
	env = makeEnv({ mic: false, secure: false });
	p = env.open();
	check('plain HTTP: sound still offered', p.audioSupported() === true);
	check('talk not', p.micSupported() === false);
	env.play();
	p.setMic(true);
	check('a Talk press opens nothing', env.sessions.length === 0);
	check('and says why', env.page.mic.join(',') === 'off');
	env = makeEnv({ rtc: false });
	p = env.open({ audio: true });
	check('no WebRTC: no sound offered', p.audioSupported() === false);
	env.play();
	check('and no session tried', env.sessions.length === 0);
	env = makeEnv({ rtc: 'absent' });
	p = env.open();
	check('preview-webrtc.js not loaded: no sound offered', p.audioSupported() === false);
}

function failsInsideAttach() {
	group('a session that fails inside attach() is heard, and Listen can try again');
	const env = makeEnv({ failFirst: true });
	const p = env.open({ audio: true });
	env.play();
	check('reported as no audio', env.page.audio.length === 1 && env.page.audio[0] === null,
		JSON.stringify(env.page.audio));
	check('the failed session destroyed', env.sessions[0].destroyed === true);
	check('its element removed', env.sessions[0].el.removed === true);
	p.setAudio(true);
	check('Listen on again opens a fresh one', live(env).length === 1 && env.sessions.length === 2);
}

function autoplayReachesThePage() {
	group('sound the browser refused to start is the page\'s to announce');
	const env = makeEnv();
	env.open({ audio: true });
	env.play();
	const s = env.sessions[0];
	s.opts.onState('gesture');
	s.opts.onState('resumed');
	check('the page heard gesture then resumed',
		env.page.states.join(',') === 'playing,gesture,resumed', env.page.states.join(','));
	check('the session stays', live(env).length === 1);
}

function declinedAudioCloses() {
	group('a camera that declines the audio closes the session, unless Talk holds it');
	let env = makeEnv();
	let p = env.open({ audio: true });
	env.play();
	env.sessions[0].opts.onAudio(null);
	check('the page told', env.page.audio.length === 1 && env.page.audio[0] === null);
	check('the session closed', live(env).length === 0);
	p.setAudio(true);
	check('Listen on again tries afresh', live(env).length === 1 && env.sessions.length === 2);
	env = makeEnv();
	p = env.open({ audio: true });
	env.play();
	p.setMic(true);
	env.sessions[0].opts.onAudio(null);
	check('with Talk on, the session stays', live(env).length === 1);
	p.setMic(false);
	check('and closes when Talk ends, nobody listening', live(env).length === 0);
}

for (const t of [failsInsideAttach, autoplayReachesThePage, declinedAudioCloses, nothingBeforePlaying, listenOpensAndCloses, talkAlone, talkOffNobodyListening,
	talkBeforePlaying, companionFailure, pictureAudioSwallowed, streamAndDestroy,
	lateCallbacksIgnored, supportAnswers]) {
	t();
}
done();
