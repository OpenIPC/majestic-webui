// The smallest thing that can fail a build.
//
// No framework on purpose: this repo ships to a camera's rootfs and has no
// build step, so a test dependency would be the only reason anyone needed npm
// to work on it. Node alone runs these.
'use strict';

let failures = 0;

function check(name, cond, detail) {
	if (cond) {
		console.log('  ok   ' + name);
	} else {
		failures++;
		console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
	}
}

function group(name) {
	console.log(name);
}

// Call once at the end. Exits non-zero if anything failed, which is what makes
// `npm test` mean something.
function done() {
	console.log(failures ? '\n' + failures + ' failed' : '\nall passed');
	process.exit(failures ? 1 : 0);
}

module.exports = { check: check, group: group, done: done };
