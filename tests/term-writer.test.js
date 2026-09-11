// main.js's <pre>-as-terminal writer, across the frame boundaries a socket
// actually puts in the middle of things.
//
// The writer strips ANSI so the pane shows text rather than escape codes, and
// it used to do that to each chunk in isolation. A socket splits where it
// likes, so a sequence delivered in two pieces was never recognised: the first
// piece matched the strip expression as though it were whole — its trailing
// digits satisfy a terminator class that has to accept digits, because `ESC 7`
// and `ESC 8` are real sequences — and the second piece arrived with no escape
// character in front of it and was rendered as text. In the field that showed
// up as a stray "m" on a line of its own in an upgrade transcript (#430); one
// byte further left it is the escape character itself reaching the DOM.
//
// It is intermittent by construction, which is the whole reason for this file:
// which byte a frame ends on is not something a person can reproduce on demand,
// and the same stream renders correctly nearly every time. So the test does not
// pick a split — it renders one stream under EVERY split and asserts they all
// come out the same as the unsplit one.
//
// The other half is the fix's own failure mode, and it is the silent one.
// Holding a tail back to wait for the rest of a sequence is exactly the kind of
// change that is off by one frame: hold too eagerly and the pane stops one
// character short of what the camera has said, which during a flash reads as a
// camera that has stopped. So the cases below also pin that ordinary text is
// never held, that a digit is held only when an escape is waiting on it, and
// that a stream carrying an escape that never finishes goes on painting rather
// than seizing up.
//
// write()'s return value is pinned alongside, because it is not decoration:
// update.js matches the markers that drive its phase strip and its reboot watch
// against exactly that string.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const ESC = '\u001b';

// A text node with the two operations the writer uses, and an element that
// records nothing but has the properties it touches.
function textNode() {
	return { data: '', appendData(s) { this.data += s; } };
}

function load() {
	const nodes = [];
	const el = { children: [], scrollTop: 0, scrollHeight: 0,
		appendChild(n) { this.children.push(n); return n; } };
	const ctx = {
		console, JSON, Object, Math, String, Number, Array, Promise, RegExp,
		Error, Set, Date, isNaN, isFinite, TextDecoder, AbortController,
		setTimeout: () => 0, clearTimeout: () => {},
		setInterval: () => 0, clearInterval: () => {},
		document: {
			createTextNode() { const n = textNode(); nodes.push(n); return n; },
			addEventListener() {},
			querySelector() { return null; },
			querySelectorAll() { return []; },
		},
		window: { addEventListener() {}, location: { reload() {} } },
		location: { protocol: 'http:', host: 'cam' },
		navigator: {},
		fetch: () => Promise.reject(new Error('not used here')),
	};
	ctx.globalThis = ctx;
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(
		path.join(__dirname, '..', 'www', 'a', 'main.js'), 'utf8'), ctx);
	const term = ctx.termWriter(el);
	// What the pane shows: the finished lines plus the one still being drawn.
	term._pane = () => el.children.map((n) => n.data).join('');
	return term;
}

// Render `text` through a fresh writer, handed to it in the pieces `cuts`
// describes. Returns what the pane ends up showing and what write() gave back.
function render(text, cuts) {
	const term = load();
	let returned = '';
	let at = 0;
	for (const c of cuts.concat([text.length])) {
		if (c <= at) continue;
		returned += term.write(text.slice(at, c));
		at = c;
	}
	return { pane: term._pane(), returned: returned };
}

(function () {
	group('a sequence split across frames is still a sequence');

	// One coloured line of the shape a transcript is full of.
	const line = ESC + '[1;37m\nUnconditional reboot' + ESC + '[0m\n';
	const whole = render(line, []);
	check('unsplit, the escapes do not reach the pane',
		whole.pane === '\nUnconditional reboot\n', JSON.stringify(whole.pane));

	// Every boundary, including the ones inside each escape. This is the test:
	// the bug was one specific cut of many, and nobody can choose which one a
	// socket makes.
	let bad = [];
	let badRet = [];
	for (let cut = 1; cut < line.length; cut++) {
		const r = render(line, [cut]);
		if (r.pane !== whole.pane) bad.push(cut + ': ' + JSON.stringify(r.pane));
		// The return is checked at every boundary too, not only at the few this
		// file names. It is what update.js matches its markers against, and a
		// defect that only shows at one cut would otherwise sit behind a green
		// suite exactly the way the original fault sat behind a working pane.
		if (r.returned !== whole.returned) {
			badRet.push(cut + ': ' + JSON.stringify(r.returned));
		}
	}
	check('split at any single byte, the pane is unchanged', bad.length === 0,
		bad.slice(0, 3).join('  '));
	check('and what write() gave back is unchanged too', badRet.length === 0,
		badRet.slice(0, 3).join('  '));

	// The worst case a stream can produce, and the cheapest to state.
	const perChar = render(line, line.split('').map((_, i) => i));
	check('delivered one character at a time, the pane is unchanged',
		perChar.pane === whole.pane, JSON.stringify(perChar.pane));

	// Two boundaries inside one sequence — an escape spread over three frames.
	const thrice = render(line, [2, 4]);
	check('an escape spread over three frames is still removed',
		thrice.pane === whole.pane, JSON.stringify(thrice.pane));

	// A sequence far longer than a colour code, because the tail this holds is
	// bounded and the bound has to clear the longest thing anyone emits. Sized
	// for the seven characters a plain colour takes, it broke a 24-bit
	// foreground-and-background set at eleven of its split points — and passed
	// every short case while doing it, which is how a bound like this goes wrong.
	const long = ESC + '[38;2;255;128;0;48;2;0;0;0mHELLO' + ESC + '[0m\n';
	const longWhole = render(long, []);
	check('a long parameter list renders to its text', longWhole.pane === 'HELLO\n',
		JSON.stringify(longWhole.pane));
	bad = [];
	badRet = [];
	for (let cut = 1; cut < long.length; cut++) {
		const r = render(long, [cut]);
		if (r.pane !== longWhole.pane) bad.push(cut);
		if (r.returned !== longWhole.returned) badRet.push(cut);
	}
	check('and survives a split at any byte of it', bad.length === 0,
		'pane corrupted at ' + bad.join(','));
	check('return value included', badRet.length === 0,
		'return corrupted at ' + badRet.join(','));

	// The longest sequence the writer recognises at all, which is what the hold
	// bound is sized from. Sizing the two separately is what let a 24-bit set
	// through, so the limit is pinned rather than left to a comment.
	const maxSeq = ESC + '[' + Array.from({ length: 16 }, (_, i) => i).join(';') + 'm';
	const maxWhole = render(maxSeq + 'END\n', []);
	check('a sequence at the recognised maximum renders to its text',
		maxWhole.pane === 'END\n', JSON.stringify(maxWhole.pane));
	bad = [];
	for (let cut = 1; cut < maxSeq.length + 4; cut++) {
		const r = render(maxSeq + 'END\n', [cut]);
		if (r.pane !== maxWhole.pane || r.returned !== maxWhole.returned) bad.push(cut);
	}
	check('and survives a split at any byte of it', bad.length === 0,
		'corrupted at ' + bad.join(','));

	group('what write() hands back does not depend on the framing');

	// The return is the STRIPPED STREAM, which is not the same thing as the pane:
	// a \r redraw overwrites a line, so the pane keeps one copy of it and the
	// return keeps every one. update.js matches its markers against the return
	// precisely because of that — a marker must not be missed because a later
	// redraw painted over the line carrying it.
	check('unsplit, the return is the stream with the escapes taken out',
		whole.returned === '\nUnconditional reboot\n', JSON.stringify(whole.returned));
	check('and however it is split, the returns concatenate to the same thing',
		perChar.returned === whole.returned && render(line, [2, 4]).returned ===
		whole.returned, JSON.stringify(perChar.returned));

	// The distinction the group name is about, stated so it cannot be quietly
	// lost: three redraws of one line are three readings in the return and one
	// line in the pane.
	const meter = 'a: 1%\ra: 2%\ra: 3%';
	const redrawn = render(meter, []);
	check('a redrawn line is one line in the pane and every reading in the return',
		redrawn.pane === 'a: 3%' && redrawn.returned === meter,
		JSON.stringify(redrawn));
	check('and that holds when the redraws are split across frames',
		render(meter, [3, 7, 11]).returned === meter &&
		render(meter, [3, 7, 11]).pane === 'a: 3%',
		JSON.stringify(render(meter, [3, 7, 11])));

	group('nothing that is not an escape is ever held back');

	// The fix's own failure mode. A pane that stops one character short of what
	// the camera has said, during a flash, reads as a camera that has stopped —
	// which is worse than the stray letter this replaced.
	let term = load();
	term.write('Erasing block: 41/79 (51%) ');
	check('ordinary text appears in the frame it arrived in',
		term._pane() === 'Erasing block: 41/79 (51%) ', JSON.stringify(term._pane()));

	term = load();
	term.write('Writing kb: 300/2006 (14%)');
	check('a line ending in a digit is not mistaken for a waiting escape',
		/\(14%\)$/.test(term._pane()), JSON.stringify(term._pane()));

	// A meter redraw with no newline, which is most of what these panes carry.
	term = load();
	term.write('Erasing block: 1/32 (3%)');
	term.write('\rErasing block: 2/32 (6%)');
	check('a redraw still rewinds the line rather than appending to it',
		term._pane() === 'Erasing block: 2/32 (6%)', JSON.stringify(term._pane()));

	group('an escape that never finishes does not seize the pane');

	// A held tail is bounded, so a stream carrying a stray introducer spoils at
	// most a line instead of stopping the pane. Past the bound the writer gives
	// the old wrong answer rather than no answer at all.
	//
	// Checked with nothing after it that could release the hold on its own: a
	// newline or a letter ends it whatever the bound is, so a case carrying one
	// would pass with no bound at all and say nothing about this.
	term = load();
	term.write(ESC + '[');
	term.write('0123456789'.repeat(12));
	check('a parameter run past the bound is painted rather than held',
		term._pane().length > 0, JSON.stringify(term._pane()));

	// And the ordinary way a hold ends: something arrives that cannot be part of
	// a sequence.
	term = load();
	term.write(ESC + '[1;3');
	term.write('7m' + 'next line\n');
	check('a hold ends when the rest of the sequence turns up',
		term._pane() === 'next line\n', JSON.stringify(term._pane()));

	// The stream simply ends mid-escape: the bytes are meaningless, and what
	// matters is that everything before them was shown.
	term = load();
	term.write('RootFS updated\n' + ESC + '[1;3');
	check('a stream cut mid-escape still shows the text before it',
		term._pane() === 'RootFS updated\n', JSON.stringify(term._pane()));

	done();
})();
