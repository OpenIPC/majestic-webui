// preview-served.js — the served-channel rule shared by the Live View page and
// the settings preview.
//
// WebRTC takes ?stream= as a preference, so a new majestic states in the
// signalling which channel a session actually serves (#240/#249). Both pages
// follow that channel and say why; the rule is one copy (MajesticServed) tested
// here. It is fiddly in three ways this pins down: it moves the radios only on a
// real mismatch, it says the reason once rather than on every reconnect, and it
// must not wipe a standing explanation when an internal reopen is answered with
// the adopted channel while the viewer's own ask is still unmet. `make()` also
// carries the Live page's Auto exception, where a mismatch is disclosed by the
// chip rather than by moving the radios.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const ctx = { window: {}, console: console };
vm.createContext(ctx);
vm.runInContext(
	fs.readFileSync(path.join(__dirname, '..', 'www', 'a', 'preview-served.js'), 'utf8'),
	ctx);
const decide = ctx.window.MajesticServed.decide;
const make = ctx.window.MajesticServed.make;
const holder = ctx.window.MajesticServed.holder;

// ── the pure decision ───────────────────────────────────────────────────────

group('a mismatch moves the picker and explains itself, once');
{
	// Asked for Main, the camera served Sub because this browser's WebRTC could
	// not take Main's format.
	const d = decide({ channel: 1, requested: 0, reason: 'undecodable' }, null, '');
	check('the served channel is read', d.servedCh === 1, d.servedCh + '');
	check('the radios move to the served channel', d.adopt === 1, d.adopt + '');
	check('the betrayed ask is remembered', d.wanted === 0, d.wanted + '');
	check('a message is shown', d.message !== null);
	check('with a say-once key', d.key === '0>1:undecodable', d.key);
	check('nothing is hidden', d.hide === false);

	const again = decide({ channel: 1, requested: 0, reason: 'undecodable' }, 0, d.key);
	check('the radios still follow it', again.adopt === 1);
	check('but the message is not shown a second time', again.message === null,
		JSON.stringify(again.message));
	check('and the key is unchanged', again.key === d.key, again.key);
}

group('a match clears a stale message');
{
	const d = decide({ channel: 0, requested: 0, reason: '' }, 0, '0>1:undecodable');
	check('the radios are left alone', d.adopt === null, d.adopt + '');
	check('any standing message is hidden', d.hide === true);
	check('and the key is cleared', d.key === '', JSON.stringify(d.key));
	check('no new message', d.message === null);
}

group('a reopen answered with the adopted channel leaves the explanation up');
{
	const d = decide({ channel: 1, requested: 1, reason: '' }, 0, '0>1:undecodable');
	check('no mismatch, so the radios are left', d.adopt === null);
	check('the message is left standing (not hidden)', d.hide === false);
	check('and the say-once key is untouched', d.key === '0>1:undecodable', d.key);
	check('the viewer\'s ask is still remembered', d.wanted === 0, d.wanted + '');
}

group('a daemon that says nothing usable changes nothing');
{
	const d = decide({ channel: 2, requested: 0, reason: 'unavailable' }, 5, 'k');
	check('the served channel is unknown', d.servedCh === null);
	check('the radios are left', d.adopt === null);
	check('nothing shown, nothing hidden', d.message === null && d.hide === false);
	check('the remembered ask and key pass through', d.wanted === 5 && d.key === 'k');
}

group('a channel stated without a request moves the radios silently');
{
	// The signalling parser maps an omitted `requested` to null: the camera named
	// the channel it is serving but not what was asked, so no mismatch can be told
	// and there is no "instead of X" to word — but the picture IS on that channel,
	// so the radios follow it and any standing message is left exactly as it was.
	const d = decide({ channel: 1, requested: null, reason: '' }, 0, '0>1:undecodable');
	check('the served channel is read', d.servedCh === 1, d.servedCh + '');
	check('the radios follow it', d.adopt === 1, d.adopt + '');
	check('no message is worded', d.message === null);
	check('nothing is hidden', d.hide === false);
	check('the standing key is untouched', d.key === '0>1:undecodable', d.key);
	check('the remembered ask passes through', d.wanted === 0, d.wanted + '');
}

// ── the stateful applier ────────────────────────────────────────────────────

// A recorder of the effects, standing in for a page's radios and message.
function recorder(extra) {
	const e = { adopted: [], shown: [], hidden: 0 };
	e.make = () => make(Object.assign({
		adopt: (ch) => e.adopted.push(ch),
		show: (info) => e.shown.push(info),
		hide: () => e.hidden++,
	}, extra || {}));
	return e;
}

group('the applier drives the effects and remembers what it said');
{
	const r = recorder();
	const s = r.make();
	// Mismatch: adopt Sub, show the message.
	s.apply({ channel: 1, requested: 0, reason: 'undecodable' });
	check('moved the picker to Sub', r.adopted.join() === '1', r.adopted.join());
	check('showed one message', r.shown.length === 1, r.shown.length + '');
	// The same reply again (a reconnect): still adopts, but does not re-say it.
	s.apply({ channel: 1, requested: 0, reason: 'undecodable' });
	check('adopts again', r.adopted.join() === '1,1');
	check('but says it only once', r.shown.length === 1, r.shown.length + '');
	// Now served as the ask (the viewer re-picked and it worked): message clears.
	s.apply({ channel: 0, requested: 0, reason: '' });
	check('hid the stale message', r.hidden >= 1, r.hidden + '');
	check('reports the served channel', s.channel() === 0, s.channel() + '');
}

group('reset clears the state and hides the message');
{
	const r = recorder();
	const s = r.make();
	s.apply({ channel: 1, requested: 0, reason: 'undecodable' });
	s.reset(0);
	check('the message was hidden', r.hidden >= 1);
	check('the served channel is forgotten', s.channel() === null);
	// After a reset to Main, a plain Main match is not read as a betrayal.
	r.shown.length = 0;
	s.apply({ channel: 0, requested: 0, reason: '' });
	check('no message on a clean match after reset', r.shown.length === 0);
}

// ── the staged holder ───────────────────────────────────────────────────────
//
// The settings preview attaches each transport as a hidden trial and promotes it
// only once it proves a picture, so a served reply can arrive for a session that
// is not on screen and may never be. holder() keeps the reply against the
// attachment id that carried it and applies it only when that id is live. A
// stand-in applier records apply/reset so the holding rule can be checked without
// a real preview or DOM.

function applierSpy() {
	const a = { applied: [], reset: [] };
	a.handle = { apply: (info) => a.applied.push(info), reset: (n) => a.reset.push(n) };
	return a;
}

group('a held reply waits for its own attachment to go live');
{
	const a = applierSpy();
	const h = holder(a.handle);
	const live = { id: 0 };                      // nothing on screen yet
	h.hold(7, { channel: 1, requested: 0, reason: 'undecodable' });
	h.flush((id) => id === live.id);
	check('a trial that is not on screen is not applied', a.applied.length === 0,
		a.applied.length + '');
	check('and the reply is still held', h.held() !== null);
	live.id = 7;                                 // that trial is promoted
	h.flush((id) => id === live.id);
	check('now it is applied', a.applied.length === 1, a.applied.length + '');
	check('and cleared, so a second flush is a no-op', h.held() === null);
	h.flush((id) => id === live.id);
	check('applied exactly once', a.applied.length === 1, a.applied.length + '');
}

group('a held reply for a trial that fails is never applied');
{
	const a = applierSpy();
	const h = holder(a.handle);
	h.hold(7, { channel: 1, requested: 0, reason: 'undecodable' });
	// The trial never goes live; a fresh channel change resets the holder.
	h.reset(0);
	check('nothing was applied', a.applied.length === 0);
	check('the applier was reset to the new ask', a.reset.join() === '0', a.reset.join());
	check('and the stale held reply is gone', h.held() === null);
	// A flush after the reset, even if that dead id somehow reads live, does
	// nothing — there is no held reply to apply.
	h.flush(() => true);
	check('still nothing applied after reset', a.applied.length === 0);
}

group('a newer held reply replaces an older one on the same holder');
{
	const a = applierSpy();
	const h = holder(a.handle);
	h.hold(7, { channel: 1, requested: 0, reason: 'undecodable' });
	h.hold(9, { channel: 0, requested: 1, reason: 'unavailable' });
	check('the holder keeps the latest attachment', h.held().id === 9, h.held().id + '');
	h.flush((id) => id === 7);
	check('the superseded trial does not flush it', a.applied.length === 0);
	h.flush((id) => id === 9);
	check('the latest one does', a.applied.length === 1 && a.applied[0].channel === 0);
}

group('in Auto a mismatch is not shown — the chip discloses it');
{
	let auto = true;
	const r = recorder({ auto: () => auto });
	const s = r.make();
	s.apply({ channel: 1, requested: 0, reason: 'undecodable' });
	check('the radios are not moved in Auto', r.adopted.length === 0, r.adopted.length + '');
	check('and no message is shown', r.shown.length === 0, r.shown.length + '');
	check('but the served channel is still known', s.channel() === 1, s.channel() + '');
	// A match still clears a stale message, Auto or not.
	s.apply({ channel: 0, requested: 0, reason: '' });
	check('a match still hides in Auto', r.hidden >= 1);
}

done();
