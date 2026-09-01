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

// A rejected promise anywhere in an async test chain used to log its failure
// through check() and then let node exit naturally with status 0, because
// done() — the only thing that reads the failure count — was never reached.
// The suite reported a pass while a test had thrown. Both hooks below end the
// process the way done() would.
process.on('unhandledRejection', (e) => {
	failures++;
	console.log('  FAIL unhandled rejection — ' + (e && e.stack ? e.stack : e));
	done();
});
process.on('uncaughtException', (e) => {
	failures++;
	console.log('  FAIL uncaught exception — ' + (e && e.stack ? e.stack : e));
	done();
});
// An async chain that simply stops — a forgotten done(), a promise that never
// settles — leaves node with nothing to do and it exits 0. Anything that
// counted a failure before that point has to be honoured.
process.on('exit', (code) => {
	if (code === 0 && failures) process.exitCode = 1;
});

// Call once at the end. Exits non-zero if anything failed, which is what makes
// `npm test` mean something.
function done() {
	console.log(failures ? '\n' + failures + ' failed' : '\nall passed');
	process.exit(failures ? 1 : 0);
}

module.exports = { check: check, group: group, done: done };
