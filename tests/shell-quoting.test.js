// A value the WebUI writes down must come back as the value it wrote.
//
// Two files here are written by the interface and then SOURCED by it: the
// extension configs under /etc/webui and the sysinfo cache in /tmp/webui. That
// makes every value in them a piece of shell on its way back in, and the whole
// class of bug this guards failed silently in both directions -- a caption
// stored as `Motion at the "front door"` came back as `Motion at the front`
// and left `door` to be run as a command; one holding a $(...) ran it on every
// page load; `eval echo` globbed a stored `*` into a directory listing. None
// of that shows up as an error. The page renders, the file sources, the
// notification just says something else, and reproducing it needs a camera and
// a value with the right character in it (#547).
//
// The functions are taken out of the file that ships and driven with a real
// `sh`, because asserting against a JavaScript transcription of them would
// test the transcription -- the same rule webui-conf.test.js follows, for the
// same reason. A round trip through an actual sourced file is the production
// loop, so that is what runs here rather than a check of what shq prints.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, group, done } = require('./assert');

const CGI = path.join(__dirname, '..', 'www', 'cgi-bin', 'p', 'common.cgi');
const src = fs.readFileSync(CGI, 'utf8');

function extract(name) {
	const start = src.indexOf(name + '() {');
	if (start < 0)
		throw new Error(name + ' was not found in p/common.cgi; this test is testing nothing');
	const end = src.indexOf('\n}\n', start);
	if (end < 0) throw new Error(name + ' has no end in p/common.cgi');
	return src.slice(start, end + 3);
}

const shq = extract('shq');
const confWrite = extract('conf_write');
const tValue = extract('t_value');

// extract() throwing is the only "this test is testing nothing" guard here.
// There is deliberately no check on HOW shq is spelled: the round trips below
// fail on any spelling that does not preserve the value, and a structural
// assertion would only get in their way -- an earlier draft asserted that the
// body contained a quoted '%s', which made every rewrite fail as "testing
// nothing" before the case that would have named the real fault could run.

// The awkward values, each for a reason. The last four are the ones that were
// actually reaching cameras: a caption is free prose, and an apostrophe, a
// quote, a run of spaces and a glob are all ordinary things to type into one.
const VALUES = [
	['plain', 'hi3516'],
	['a space', 'front door'],
	['runs of spaces', 'front   door'],
	['a tab', 'front\tdoor'],
	['a newline', 'front\ndoor'],
	['empty', ''],
	['a leading dash', '-n'],
	['a backslash', 'C:\\cams\\front'],
	['a semicolon', 'front; reboot'],
	['a dollar sign', 'p@$$word'],
	['a variable reference', 'home is $HOME'],
	['a command substitution', 'x$(touch SENTINEL)y'],
	['backticks', 'x`touch SENTINEL`y'],
	['an apostrophe', "Ivan's yard"],
	['a double quote', 'Motion at the "front door"'],
	['a glob', 'snap *'],
	['non-ascii', 'двор'],
	// Command substitution strips every trailing newline from what it
	// captures, so a writer that captures the value -- or captures the
	// quoted form -- rewrites these two without saying so.
	['a trailing newline', 'front door\n'],
	['several trailing newlines', 'front door\n\n\n'],
];

// Write the value the way a config writer does, source the file back the way
// every reader of it does, and report what the second shell ended up with.
// SENTINEL is watched throughout: a value that RUNS on the way in or out is a
// different failure from one that merely comes back wrong, and the round-trip
// assertion alone would not separate them.
//
// The line is written by the shipped conf_write rather than by a spelling of
// it invented here, because two of the faults this guards are in the WRITER
// and not in shq: an `echo` whose dash implementation eats the backslashes in
// `C:\cams\front`, and a `$(...)` anywhere on the path that silently drops a
// trailing newline.
//
// The write and the read are two separate shells launched from here rather
// than one nested inside the other: a nested `sh -c` would have its $caption
// expanded by the outer shell before the inner one ever ran, which is the same
// too-many-passes mistake the code under test is about. Both run with the temp
// directory as their cwd, so a value that globs has files to glob against and
// a value that executes leaves its SENTINEL where it can be seen.
function roundTrip(value) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shq-'));
	const conf = path.join(dir, 'test.conf');
	const out = path.join(dir, 'out');
	fs.writeFileSync(path.join(dir, 'decoy-a'), '');
	fs.writeFileSync(path.join(dir, 'decoy-b'), '');
	try {
		execFileSync('sh', ['-c',
			shq + '\n' + confWrite + '\nconf_write caption "$1" > "$2"\n', 'sh', value, conf],
			{ cwd: dir, encoding: 'utf8' });
		const line = fs.readFileSync(conf, 'utf8');
		// A file that will not parse is the loudest form of this failure and
		// the one that took the whole WebUI down, so it is reported as a
		// wrong answer rather than thrown: the run should go on to say which
		// of the other values are affected too.
		let back = null;
		try {
			execFileSync('sh', ['-c',
				'. "$1"\nprintf \'%s\' "$caption" > "$2"\n', 'sh', conf, out],
				{ cwd: dir, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
			back = fs.readFileSync(out, 'utf8');
		} catch (e) {
			back = '<the file did not source: ' +
				String(e.stderr || e.message).trim().split('\n')[0] + '>';
		}
		return { back, line, ran: fs.existsSync(path.join(dir, 'SENTINEL')) };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

group('a value survives being written to a sourced file and read back');
for (const [what, value] of VALUES) {
	const r = roundTrip(value);
	check(what, r.back === value,
		'wrote ' + JSON.stringify(r.line) + ', got back ' + JSON.stringify(r.back));
	if (value.indexOf('SENTINEL') >= 0)
		check(what + ' does not execute', r.ran === false,
			'sourcing the file ran the command in the value');
}

// t_value is how the field_* helpers read a stored value on its way to the
// page. It was `eval echo $var`, which word-split and globbed before echo saw
// anything, so a password of `p@ss  word` reached the form with one space and
// one of `*` reached it as a listing of the current directory.
group('t_value reads a value without splitting or globbing it');
function readBack(value) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-'));
	const out = path.join(dir, 'out');
	// Files to glob against, so a surviving glob has something to expand to.
	fs.writeFileSync(path.join(dir, 'decoy-a'), '');
	fs.writeFileSync(path.join(dir, 'decoy-b'), '');
	const script = [
		tValue,
		'cd ' + JSON.stringify(dir),
		'socks5_password=$1',
		't_value socks5_password > ' + JSON.stringify(out),
	].join('\n');
	try {
		execFileSync('sh', ['-c', script, 'sh', value], { encoding: 'utf8' });
		return fs.readFileSync(out, 'utf8');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
for (const [what, value] of [
	['runs of spaces', 'p@ss  word'],
	['a glob', '*'],
	['a glob with a prefix', 'decoy-*'],
	['a leading dash', '-n'],
	['a backslash', 'a\\tb'],
	['a tab', 'a\tb'],
]) {
	const back = readBack(value);
	check(what, back === value, 'got back ' + JSON.stringify(back));
}

done();
