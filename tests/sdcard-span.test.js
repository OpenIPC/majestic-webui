// Does this card keep what it is given across its WHOLE size?
//
// The fault this covers is the one nothing else on the page can see. A card
// that reports 64 GB and holds 8 accepts every write, returns no error, logs
// nothing, and reads each address back correctly at the moment it is written --
// because the write that destroys the earlier one has not happened yet. It only
// shows when the whole span has been written and is then read back, which is
// what probe_span does and what these cases pin.
//
// It cannot be reproduced on demand: it needs a counterfeit card, and the
// verdict is a confident English sentence whichever branch it takes. So the
// card is simulated -- a `dd` on PATH that folds every address past a real size
// back onto the start, which is exactly what the controller in one of these
// does -- and the real shell out of the real CGI is run against it.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, group, done } = require('./assert');

const CGI = path.join(__dirname, '..', 'www', 'cgi-bin', 'j', 'sdcard.cgi');
const src = fs.readFileSync(CGI, 'utf8');

// Sliced, not re-typed: a change inside these shows up here as changed
// behaviour rather than as a pattern that quietly stopped matching.
function slice(from, to, must) {
	const a = src.indexOf(from), b = src.indexOf(to);
	if (a < 0 || b < 0 || b <= a) {
		throw new Error('could not find ' + JSON.stringify(from) + ' in the CGI; this test is testing nothing');
	}
	const out = src.slice(a, b);
	if (out.indexOf(must) < 0) {
		throw new Error(JSON.stringify(must) + ' is no longer in that slice; this test is testing nothing');
	}
	return out;
}

const LOGLN = slice('logln() {', '# Said whenever something', '"');
const UNCACHE = slice('uncache() {', '# Is there a partition table', 'drop_caches');
const SPAN = slice('span_offsets() {', '# Kernel complaints about this card', 'probe_span() {');
if (SPAN.indexOf('so_off * 2') < 0) {
	throw new Error('the ladder is no longer doubling; this test is testing nothing');
}

// A `dd` that lies about the size of the thing behind it.
//
// `real` bytes of storage presented as any size you like: every seek and skip
// is taken modulo `real` before the genuine dd sees it, so an address past the
// end silently aliases onto the start. That is the counterfeit card. With
// `real` larger than the whole span it is an honest one, and with MJ_DROP set
// it takes writes and keeps none -- the card that has stopped storing.
// A `dd` that lies about the size of the thing behind it.
//
// `MJ_REAL` bytes of storage presented as any size you like: every seek and
// skip into the card image is taken modulo that before the genuine dd sees it,
// so an address past the end silently aliases onto the start. That is the
// counterfeit card. Unset, it is an honest one; with MJ_DROP set it takes
// writes to the card and keeps none, which is the card that has stopped
// storing. Reads and writes to anything else -- the scratch file probe_span
// reads through, /dev/urandom -- pass through untouched.
const SHIM = (realDd, dev) => `#!/bin/sh
real=\${MJ_REAL:-0}
touches=0
bs=1
for a in "$@"; do
	case "$a" in
		bs=*) bs=\${a#bs=};;
		if=${dev}|of=${dev}) touches=1;;
	esac
done
if [ "$touches" = 1 ] && [ -n "$MJ_DROP" ]; then
	case " $* " in *" of=${dev} "*) exec ${realDd} if=/dev/null of=/dev/null;; esac
fi
if [ "$touches" = 1 ] && [ -n "$MJ_BLIND" ]; then
	for a in "$@"; do
		case "$a" in skip=*) [ $((\${a#skip=} * bs)) -ge "$MJ_BLIND" ] && exit 1;; esac
	done
fi
args=""
for a in "$@"; do
	case "$a" in
	seek=*|skip=*)
		k=\${a%%=*}; v=\${a#*=}
		off=$((v * bs))
		[ "$touches" = 1 ] && [ "$real" -gt 0 ] && off=$((off % real))
		args="$args $k=$((off / bs))"
		;;
	*) args="$args $a";;
	esac
done
exec ${realDd} $args
`;

const REAL_DD = require('child_process')
	.execFileSync('sh', ['-c', 'command -v dd'], { encoding: 'utf8' }).trim();
if (!REAL_DD) throw new Error('no dd on this machine; this test cannot run');

function stage(dir, dev, bytes) {
	fs.mkdirSync(path.join(dir, 'bin'));
	fs.writeFileSync(path.join(dir, 'bin', 'dd'), SHIM(REAL_DD, dev), { mode: 0o755 });
	// Sparse, so a "32 GB" card costs nothing on the test machine.
	fs.writeFileSync(dev, Buffer.alloc(0));
	fs.truncateSync(dev, bytes);
}

function env(dir, opts) {
	const e = Object.assign({}, process.env, {
		PATH: path.join(dir, 'bin') + ':' + process.env.PATH,
		MJ_REAL: String(opts.aliasAt || 0),
	});
	if (opts.drop) e.MJ_DROP = '1';
	if (opts.blindAbove) e.MJ_BLIND = String(opts.blindAbove);
	return e;
}

function run(opts) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdspan-'));
	const dev = path.join(dir, 'card.img');
	try {
		stage(dir, dev, opts.real);
		const script = [
			LOGLN, UNCACHE, SPAN,
			'L=""',
			'probe_span ' + JSON.stringify(dev) + ' ' + opts.span,
			'echo "state=$span_state kept=$span_kept seen=$span_seen total=$span_total at=$span_at from=$span_from"',
		].join('\n');
		const out = execFileSync('sh', ['-c', script], {
			encoding: 'utf8', env: env(dir, opts),
		}).trim();
		const m = {};
		out.split(/\s+/).forEach((kv) => { const i = kv.indexOf('='); m[kv.slice(0, i)] = kv.slice(i + 1); });
		m.raw = out;
		return m;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const GB = 1073741824;

function main() {
	group('an honest card passes, and that is the control');
	{
		const r = run({ span: 2 * GB, real: 2 * GB });
		check('every point held its own stamp', r.state === 'ok', r.raw);
		check('all of them were read back',
			Number(r.kept) === Number(r.total) && Number(r.seen) === Number(r.total), r.raw);
		check('there was more than one point to read', Number(r.total) > 4, r.raw);
		check('nothing is flagged', Number(r.at) === -1, r.raw);
	}

	group('a card that claims four times what it holds is caught');
	{
		// 8 GB of flash sold as 32 GB -- the commonest counterfeit there is.
		const r = run({ span: 32 * GB, real: 8 * GB, aliasAt: 8 * GB });
		check('the verdict is that it wrapped, not merely that it failed',
			r.state === 'wrapped', r.raw);
		// The whole point of the index inside the stamp: the finding names the
		// address the card really wrote to, which is what turns "broken" into
		// "smaller than it says". It is also the field a shorter read silently
		// truncated away once, so it is asserted as a number and not merely as
		// present.
		check('it names where the stamp it found had been written',
			Number(r.from) > 0 && Number(r.from) !== Number(r.at), r.raw);
		check('and that address is past the real end of the flash',
			Number(r.from) >= 8 * GB, r.raw);
		check('and where the lie starts', Number(r.at) >= 0, r.raw);
		check('it does not report a clean span', Number(r.kept) < Number(r.total), r.raw);
	}

	group('the write-all-then-read-all order is what does the catching');
	{
		// Same card, checked one point at a time the way probe_card does it:
		// write, read back, move on. Every point passes, because the write that
		// destroys it has not happened yet. This is the bug this function
		// exists to not have, so it is pinned as a property of the code rather
		// than left to a comment.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdspan1-'));
		const dev = path.join(dir, 'card.img');
		try {
			stage(dir, dev, 8 * GB);
			const body = [
				SPAN.slice(0, SPAN.indexOf('# Does this card keep')),
				'bad=0',
				'for off in $(span_offsets ' + (32 * GB) + '); do',
				'  printf "one-at-a-time %s" "$off" | dd of=' + JSON.stringify(dev) +
					' bs=512 seek=$((off / 512)) count=1 conv=notrunc 2>/dev/null',
				'  got=$(dd if=' + JSON.stringify(dev) + ' bs=512 skip=$((off / 512)) count=1 2>/dev/null | head -c 64)',
				'  case "$got" in "one-at-a-time $off"*) ;; *) bad=$((bad + 1));; esac',
				'done',
				'echo "bad=$bad"',
			].join('\n');
			const out = execFileSync('sh', ['-c', body], {
				encoding: 'utf8', env: env(dir, { aliasAt: 8 * GB }),
			}).trim();
			check('checking each point as it is written finds nothing wrong', out === 'bad=0', out);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	group('a card that keeps nothing is told apart from one that wraps');
	{
		const r = run({ span: 2 * GB, real: 2 * GB, drop: true });
		check('it is unstored, not wrapped', r.state === 'unstored', r.raw);
		check('no point held its stamp', Number(r.kept) === 0, r.raw);
		check('and the first bad offset is named', Number(r.at) >= 0, r.raw);
	}

	group('a span too small to place the points is not a pass');
	{
		const r = run({ span: 1024, real: 1024 });
		check('it says it could not look', r.state === 'unknown', r.raw);
	}

	group('a look that could not happen is never a pass');
	{
		// The card answers up to a point and then stops answering at all --
		// the device falling off the bus mid-probe. That is not evidence
		// against the card and must never come out as `ok`.
		const r = run({ span: 4 * GB, real: 4 * GB, blindAbove: 512 * 1024 * 1024 });
		check('an unreadable span is unknown, not ok', r.state !== 'ok', r.raw);
		check('and fewer points were seen than were written',
			Number(r.seen) < Number(r.total), r.raw);
	}

	group('the ladder never stamps one sector twice');
	{
		// Where the span is a power of two plus one MiB, the near-the-end point
		// lands exactly on a rung already emitted. That duplicate is not
		// harmless: the write pass stamps the sector twice, the read pass finds
		// the later point's stamp where the earlier one's belongs, and that is
		// precisely the signature probe_span convicts a card on. A healthy card
		// would be reported as folding one address onto another.
		const body = [
			SPAN.slice(0, SPAN.indexOf('# Does this card keep')),
			'for mb in 3 5 9 17 33 65 8 64 29880; do',
			'  span=$((mb * 1048576))',
			'  n=$(span_offsets $span | wc -l)',
			'  u=$(span_offsets $span | sort -u | wc -l)',
			'  [ "$n" = "$u" ] || echo "dup at ${mb}MiB: $n points, $u distinct"',
			'done',
			'echo done',
		].join('\n');
		const out = execFileSync('sh', ['-c', body], { encoding: 'utf8' }).trim();
		check('no span emits the same offset twice', out === 'done', out);

		// And the point near the end is still there on an ordinary card, or the
		// ladder would stop covering the top of the device -- which is the one
		// address a wrapping card is most likely to alias.
		const tail = execFileSync('sh', ['-c',
			SPAN.slice(0, SPAN.indexOf('# Does this card keep')) +
			'\nspan_offsets $((29880 * 1048576)) | tail -1'], { encoding: 'utf8' }).trim();
		check('the near-the-end point survives on a real card',
			Number(tail) > 17179869184 && Number(tail) < 29880 * 1048576, tail);
	}

	done();
}

main();
