// mj-preview.js — servedDecision(): what a WebRTC `served` reply does to the
// Live adjustments panel's channel picker.
//
// WebRTC takes ?stream= as a preference, not an order, so a new majestic states
// in the signalling which channel a session actually serves (#240/#249). The
// panel follows that channel and says why — the Live View page's behaviour,
// ported to the shared preview component for #252. The rule is fiddly in three
// ways this pins down: it moves the radios only on a real mismatch, it says the
// reason once rather than on every reconnect, and it must not wipe a standing
// explanation when an internal reopen is answered with the adopted channel
// while the viewer's own ask is still unmet.
//
// Tested here rather than through the stage because the stage builds itself
// from innerHTML and cannot be mounted without a real DOM; the decision is
// pure, so it is exposed and checked directly.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const ctx = { window: {}, console: console };
vm.createContext(ctx);
vm.runInContext(
	fs.readFileSync(path.join(__dirname, '..', 'www', 'a', 'mj-preview.js'), 'utf8'),
	ctx);
const decide = ctx.window.MajesticPreview.servedDecision;

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

	// The same reply again — a reconnect or audio renegotiation re-delivers it.
	const again = decide({ channel: 1, requested: 0, reason: 'undecodable' }, 0, d.key);
	check('the radios still follow it', again.adopt === 1);
	check('but the message is not shown a second time', again.message === null,
		JSON.stringify(again.message));
	check('and the key is unchanged', again.key === d.key, again.key);
}

group('a match clears a stale message');
{
	// Asked for Main and got Main: whatever mismatch a message described is over.
	const d = decide({ channel: 0, requested: 0, reason: '' }, 0, '0>1:undecodable');
	check('the radios are left alone', d.adopt === null, d.adopt + '');
	check('any standing message is hidden', d.hide === true);
	check('and the key is cleared', d.key === '', JSON.stringify(d.key));
	check('no new message', d.message === null);
}

group('a reopen answered with the adopted channel leaves the explanation up');
{
	// The session adopted Sub after the mismatch above; an internal reopen now
	// requests Sub and is answered with Sub — a match — but the viewer asked for
	// Main and still has not got it, so the standing message must not vanish.
	const d = decide({ channel: 1, requested: 1, reason: '' }, 0, '0>1:undecodable');
	check('no mismatch, so the radios are left', d.adopt === null);
	check('the message is left standing (not hidden)', d.hide === false);
	check('and the say-once key is untouched', d.key === '0>1:undecodable', d.key);
	check('the viewer\'s ask is still remembered', d.wanted === 0, d.wanted + '');
}

group('a daemon that says nothing usable changes nothing');
{
	// Older majestic never sends this at all; a future one could send a channel
	// this UI does not know. Either way the picker is not disturbed.
	const d = decide({ channel: 2, requested: 0, reason: 'unavailable' }, 5, 'k');
	check('the served channel is unknown', d.servedCh === null);
	check('the radios are left', d.adopt === null);
	check('nothing shown, nothing hidden', d.message === null && d.hide === false);
	check('the remembered ask and key pass through', d.wanted === 5 && d.key === 'k');
}

group('the reason words a different sentence and a different key');
{
	const d = decide({ channel: 0, requested: 1, reason: 'unavailable' }, null, '');
	check('adopts Main', d.adopt === 0);
	check('remembers the Sub ask', d.wanted === 1, d.wanted + '');
	check('keyed by request, channel and reason', d.key === '1>0:unavailable', d.key);
	check('message carries the reply for wording', d.message && d.message.reason === 'unavailable');
}

done();
