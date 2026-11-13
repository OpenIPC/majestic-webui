// The camera-wide lock that stops two browsers swapping one card.
//
// This is the failure with a filesystem at the end of it. Two tabs can each be
// sure they are the only one: the second to reach the unmount finds the card
// already gone, treats that as a failure, mounts it back and resumes -- while
// the first is still displaying SAFE TO REMOVE over a card the camera has
// started writing to. Somebody reads that word and pulls the card.
//
// The lock is shell, and shell is what is run here. Extracting the functions
// and driving them with real `sh` tests the code that ships; asserting on a
// JavaScript transcription of it would test the transcription.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, group, done } = require('./assert');

const CGI = path.join(__dirname, '..', 'www', 'cgi-bin', 'j', 'sdcard.cgi');
const src = fs.readFileSync(CGI, 'utf8');
const lock = src.slice(src.indexOf('SWAP_LOCK=/tmp/webui'), src.indexOf('do_speedtest() {'));
if (!lock || lock.indexOf('swap_guard()') < 0) {
	throw new Error('the lock functions were not found in the CGI; this test is testing nothing');
}

// Run a fragment against the real functions, in a lock directory of its own.
function sh(body) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swaplock-'));
	const script = lock + '\nSWAP_LOCK=' + dir + '/sdswap.lock\nerr=""\n' + body + '\n';
	try {
		return execFileSync('sh', ['-c', script], { encoding: 'utf8' }).trim();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function main() {
	group('an unheld lock lets anybody through');
	{
		check('a free camera accepts a swap',
			sh('POST_swap=A; swap_guard; echo "[$err]"') === '[]', sh('POST_swap=A; swap_guard; echo "[$err]"'));
	}

	group('a held lock admits its owner and nobody else');
	{
		const out = sh([
			'POST_swap=A; swap_take',
			'POST_swap=A; err=""; swap_guard; echo "owner:[$err]"',
			'POST_swap=B; err=""; swap_guard; echo "other:[$err]"',
			'POST_swap=;  err=""; swap_guard; echo "manual:[$err]"',
		].join('\n'));
		check('the owner may carry on', out.indexOf('owner:[]') >= 0, out);
		// This is the one that matters: B is the browser that would mount the
		// card back under A's "safe to remove".
		check('a second swap is refused', /other:\[.+\]/.test(out), out);
		// The manual Mount and Unmount buttons are the same hazard by another
		// route, so they are refused too rather than being trusted to be a
		// person who knows what the other person is doing.
		check('and so is a manual mount from another page', /manual:\[.+\]/.test(out), out);
	}

	group('only the holder can let go');
	{
		const out = sh([
			'POST_swap=A; swap_take',
			// A request arriving late from an abandoned run must not unlock
			// somebody else's swap.
			'POST_swap=B; swap_release',
			'POST_swap=B; err=""; swap_guard; echo "afterB:[$err]"',
			'POST_swap=A; swap_release',
			'POST_swap=B; err=""; swap_guard; echo "afterA:[$err]"',
		].join('\n'));
		check('a stranger cannot release the lock', /afterB:\[.+\]/.test(out), out);
		check('the owner can', out.indexOf('afterA:[]') >= 0, out);
	}

	group('a browser that goes away does not hold the slot for ever');
	{
		// The wizard refreshes the lock from the status poll it is already
		// making. Stop polling -- closed tab, dead browser, someone carrying
		// the laptop out of range -- and it must become reclaimable, or the
		// card is left unmounted and unmountable by anyone.
		const out = sh([
			'POST_swap=A; swap_take',
			'printf %s 1 > "$SWAP_LOCK/at"',
			'POST_swap=B; err=""; swap_guard; echo "stale:[$err]"',
		].join('\n'));
		check('a stale lock is reclaimed', out.indexOf('stale:[]') >= 0, out);
	}
	{
		const out = sh([
			'POST_swap=A; swap_take',
			'printf %s 1 > "$SWAP_LOCK/at"',
			'POST_swap=A; swap_take',
			'POST_swap=B; err=""; swap_guard; echo "refreshed:[$err]"',
		].join('\n'));
		check('but a refreshed one is not', /refreshed:\[.+\]/.test(out), out);
	}

	group('nonsense in the lock is not a licence');
	{
		// A truncated or garbled timestamp read as a number is how "0 seconds
		// ago" and "never" become the same thing.
		const out = sh([
			'POST_swap=A; swap_take',
			'printf %s "not-a-number" > "$SWAP_LOCK/at"',
			'POST_swap=B; err=""; swap_guard; echo "garbled:[$err]"',
		].join('\n'));
		check('an unreadable timestamp frees the lock rather than wedging it',
			out.indexOf('garbled:[]') >= 0, out);
	}

	done();
}

main();
