// preview-chain.js — the fallback walk and the software-rung retry ladder,
// shared by the Live View page and the settings preview.
//
// The walk used to be written twice and was fixed twice (#309, #342), which is
// why it is one copy now (#400). What this pins is the copy's contract: which
// failure sends the chain where, that a dropped software socket is retried a
// bounded number of times with a growing wait and never for any other reason,
// that a fresh start cancels a pending retry without refilling the budget,
// that only sustained software decode refills it, and that the walk survives a
// player failing synchronously from inside attach(). None of that can be seen
// from a browser: every wrong answer is a picture (the wrong one) or a note
// (too early), never an error.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const A = (f) => path.join(__dirname, '..', 'www', 'a', f);

// The real transport rules, not a mirror of them: the two gates the walk asks
// (softwareRungFor, softwareRungForCodec) read only window.MajesticWasm, and
// nothing here touches preferred() or the storage behind it. Timers are faked
// so the 1+2+3+4+5 s ladder costs nothing and every wait is asserted exactly.
function load(wasmOk) {
	const timers = [];
	const win = {
		MajesticWasm: wasmOk === false ? undefined : {
			available: true,
			handles: (c) => /^h265$|^hevc$/i.test(String(c || '')),
		},
	};
	const ctx = {
		window: win, console: console,
		setTimeout: (fn, ms) => { const t = { fn, ms, fired: false, cleared: false }; timers.push(t); return t; },
		clearTimeout: (t) => { if (t) t.cleared = true; },
	};
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(A('preview-transport.js'), 'utf8'), ctx);
	vm.runInContext(fs.readFileSync(A('preview-chain.js'), 'utf8'), ctx);
	const C = win.MajesticChain;
	// A driver with a recorder for its effects, standing in for a page.
	function driver(over) {
		const e = { starts: [], exhausted: [], codec: 'h264', starting: 'webrtc' };
		e.chain = C.make(Object.assign({
			start: (k) => e.starts.push(k),
			starting: () => e.starting,
			codecFor: () => e.codec,
			onExhausted: (k, d) => e.exhausted.push(k + ' ' + d),
		}, over || {}));
		return e;
	}
	// Fire the one pending timer, as the clock would.
	function fire() {
		const live = timers.filter((t) => !t.fired && !t.cleared);
		if (live.length !== 1) throw new Error('expected one live timer, have ' + live.length);
		live[0].fired = true;
		live[0].fn();
		return live[0].ms;
	}
	const pendingMs = () => timers.filter((t) => !t.fired && !t.cleared).map((t) => t.ms);
	return { C, driver, fire, pendingMs, timers, win };
}

// ── the pure walk ───────────────────────────────────────────────────────────

group('a WebRTC failure asks for MSE, whatever the reason');
{
	const { C } = load();
	for (const d of ['fallback', 'busy', 'unreachable', 'undecodable h265', '']) {
		const r = C.decide('webrtc', d, 0, 'h264');
		check('webrtc + `' + d + '` -> mse', r.start === 'mse', JSON.stringify(r));
	}
}

group('MSE refused by the browser goes to the software rung only for a codec it speaks');
{
	const { C } = load();
	check('undecodable h265 -> wasm',
		C.decide('mse', 'undecodable h265', 0, 'h264').start === 'wasm');
	check('undecodable hevc -> wasm',
		C.decide('mse', 'undecodable hevc', 0, 'h264').start === 'wasm');
	// A browser refusing H.264 High 10 reports the same code; an H.265 decoder
	// would be a slower way to fail.
	check('undecodable h264 -> exhausted',
		C.decide('mse', 'undecodable h264', 0, 'h264').exhausted === true);
	check('undecodable with no codec named -> exhausted',
		C.decide('mse', 'undecodable', 0, 'h265').exhausted === true);
}

group('with no software decoder in the page, MSE giving up ends the walk');
{
	const { C } = load(false);
	check('undecodable h265 -> exhausted',
		C.decide('mse', 'undecodable h265', 0, 'h265').exhausted === true);
	check('unreachable on an H.265 channel -> exhausted',
		C.decide('mse', 'unreachable', 0, 'h265').exhausted === true);
}

group('an MSE socket that dropped before a verdict is rescued by the configured codec (#288)');
{
	const { C } = load();
	for (const d of ['unreachable', 'mse-error']) {
		check('`' + d + '` on a configured h265 channel -> wasm',
			C.decide('mse', d, 0, 'h265').start === 'wasm');
		check('`' + d + '` on a configured h264 channel -> exhausted',
			C.decide('mse', d, 0, 'h264').exhausted === true);
		check('`' + d + '` with the codec unknown yet -> exhausted',
			C.decide('mse', d, 0, '').exhausted === true);
	}
	// No MSE at all says nothing about the stream, and is not in the rescue.
	check('no-mse on an h265 channel -> exhausted',
		C.decide('mse', 'no-mse', 0, 'h265').exhausted === true);
}

group('a dropped software socket is retried, with a growing wait, five times');
{
	const { C } = load();
	for (let n = 0; n < C.MAX_RETRIES; n++) {
		const r = C.decide('wasm', 'unreachable', n, 'h265');
		check('retry ' + (n + 1) + ' waits ' + (n + 1) + ' s',
			r.retry === C.RETRY_MS * (n + 1), JSON.stringify(r));
	}
	check('the sixth drop is past the budget',
		C.decide('wasm', 'unreachable', C.MAX_RETRIES, 'h265').exhausted === true);
}

group('the software rung is never retried for anything but a socket drop');
{
	const { C } = load();
	for (const d of ['decoder-unavailable', 'no-offscreen', 'decoder-error',
		'undecodable h265', 'mse-error', '']) {
		check('wasm + `' + d + '` -> exhausted',
			C.decide('wasm', d, 0, 'h265').exhausted === true);
	}
}

group('a codec change restarts the walk from wherever the caller starts, from any rung');
{
	const { C } = load();
	for (const k of ['webrtc', 'mse', 'wasm', 'multipart']) {
		check(k + ' + codec-changed -> restart',
			C.decide(k, 'codec-changed h264', 3, 'h265').restart === true);
	}
}

group('nothing lies below the caller\'s floor');
{
	const { C } = load();
	check('multipart -> exhausted',
		C.decide('multipart', 'unreachable', 0, 'h265').exhausted === true);
	check('an unknown kind -> exhausted',
		C.decide('carrier-pigeon', 'unreachable', 0, 'h265').exhausted === true);
	check('nothing at all -> exhausted',
		C.decide(null, undefined, 0, undefined).exhausted === true);
}

// ── the driver ──────────────────────────────────────────────────────────────

group('the driver attaches what the walk says, and hands the floor to the caller');
{
	const { driver } = load();
	const e = driver();
	e.chain.next('webrtc', 'fallback');
	e.chain.next('mse', 'undecodable h265');
	e.chain.next('mse', 'no-mse');
	check('mse then wasm were started', e.starts.join() === 'mse,wasm', e.starts.join());
	check('and the floor was reached once, with the reason',
		e.exhausted.join() === 'mse no-mse', e.exhausted.join());
}

group('a restart passes the caller\'s token through untouched');
{
	// The Live page's startingRung() answers 'multipart' or a boolean that its
	// attachPlayer decodes; the chain must not read it.
	const { driver } = load();
	const e = driver();
	e.starting = true;
	e.chain.next('wasm', 'codec-changed h264');
	e.starting = 'multipart';
	e.chain.next('mse', 'codec-changed mjpeg');
	check('both tokens arrived verbatim',
		e.starts.length === 2 && e.starts[0] === true && e.starts[1] === 'multipart',
		JSON.stringify(e.starts));
	check('nothing was exhausted', e.exhausted.length === 0);
}

group('five drops are retried on the ladder, the sixth reaches the floor');
{
	const { C, driver, fire, pendingMs } = load();
	const e = driver();
	e.codec = 'h265';
	e.chain.next('mse', 'unreachable');          // -> wasm
	check('the decoder was started', e.starts.join() === 'wasm', e.starts.join());
	for (let i = 1; i <= C.MAX_RETRIES; i++) {
		e.chain.next('wasm', 'unreachable');
		check('drop ' + i + ': a retry is pending after ' + i + ' s',
			e.chain.pending() && pendingMs().join() === String(C.RETRY_MS * i),
			pendingMs().join());
		check('drop ' + i + ': the budget counts it', e.chain.retries() === i);
		fire();
		check('drop ' + i + ': the retry started a software player once',
			e.starts.length === i + 1 && e.starts[i] === 'wasm', e.starts.join());
		check('drop ' + i + ': nothing is pending after it fired', !e.chain.pending());
	}
	e.chain.next('wasm', 'unreachable');
	check('the sixth drop is handed to the floor',
		e.exhausted.join() === 'wasm unreachable', e.exhausted.join());
	check('and started nothing more', e.starts.length === C.MAX_RETRIES + 1);
	check('and left no timer', !e.chain.pending());
}

group('a fresh start cancels a pending retry and leaves the budget alone');
{
	const { driver, timers } = load();
	const e = driver();
	e.codec = 'h265';
	e.chain.next('wasm', 'unreachable');
	check('a retry is pending', e.chain.pending());
	// The viewer changes channel: the page cancels.
	e.chain.cancel();
	check('the timer was cleared', timers[0].cleared === true);
	check('nothing is pending', !e.chain.pending());
	check('the budget was NOT refilled', e.chain.retries() === 1, e.chain.retries() + '');
	check('and no software player was started', e.starts.length === 0);
	// A retry pending across a start the chain itself issues is superseded too.
	e.chain.next('wasm', 'unreachable');
	check('a second retry is pending', e.chain.pending() && e.chain.retries() === 2);
	e.chain.next('wasm', 'codec-changed h264');
	check('the restart cleared it', !e.chain.pending() && timers[1].cleared === true);
	check('and only the restart was attached',
		e.starts.length === 1 && e.starts[0] === 'webrtc', e.starts.join());
}

group('only sustained software decode refills the budget');
{
	const { C, driver } = load();
	const e = driver();
	e.codec = 'h265';
	e.chain.next('wasm', 'unreachable');
	e.chain.next('wasm', 'unreachable');
	check('two retries spent', e.chain.retries() === 2);
	e.chain.healthy({ transport: 'wasm', framesDecoded: C.HEALTHY_FRAMES - 1 });
	check('seven frames are not proof', e.chain.retries() === 2);
	e.chain.healthy({ transport: 'mse', framesDecoded: 100 });
	check('the MSE player decoding is not proof about this rung', e.chain.retries() === 2);
	e.chain.healthy({ transport: 'wasm', framesDecoded: C.HEALTHY_FRAMES });
	check('eight software frames are', e.chain.retries() === 0);
	e.chain.healthy(null);
	check('nothing at all is harmless', e.chain.retries() === 0);
}

group('a player that fails from inside attach() does not corrupt the walk');
{
	// MajesticWasm reports 'no-offscreen' and MajesticVideo 'no-mse'
	// synchronously, so the swap calls next() again before start() returns.
	const { driver } = load();
	let e;
	e = driver({
		start: (k) => {
			e.starts.push(k);
			if (k === 'wasm') e.chain.next('wasm', 'no-offscreen');
		},
	});
	e.codec = 'h265';
	e.chain.next('mse', 'unreachable');
	check('the decoder was started', e.starts.join() === 'wasm', e.starts.join());
	check('its synchronous refusal reached the floor',
		e.exhausted.join() === 'wasm no-offscreen', e.exhausted.join());
	check('no retry was left behind', !e.chain.pending());
	check('and the budget is untouched', e.chain.retries() === 0);
}

group('the retry timer firing into a synchronous refusal ends cleanly');
{
	const { driver, fire } = load();
	let f;
	f = driver({
		start: (k) => {
			f.starts.push(k);
			if (f.starts.length > 1) f.chain.next('wasm', 'decoder-unavailable');
		},
	});
	f.codec = 'h265';
	f.chain.next('mse', 'unreachable');      // wasm
	f.chain.next('wasm', 'unreachable');     // retry pending
	fire();
	check('the retry started a player', f.starts.join() === 'wasm,wasm', f.starts.join());
	check('its refusal reached the floor',
		f.exhausted.join() === 'wasm decoder-unavailable', f.exhausted.join());
	check('nothing is pending', !f.chain.pending());
}

done();
