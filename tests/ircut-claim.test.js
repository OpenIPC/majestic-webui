// "This camera has no IR-cut filter" — the one claim the WebUI lets an owner
// make about hardware, and the rule that takes it back.
//
// The claim silences a banner, so every way it can go wrong is a banner that
// does not appear, which is indistinguishable from a camera that is fine. That
// is the whole reason there is a file here: the fault has no symptom on the
// page, and the only symptom anywhere is a magenta picture at midday, on
// somebody else's camera, some other time.
//
// Reproducing it for real needs an owner who pressed Dismiss, a filter wired
// after that and taken away again — the sequence that got the claim to outlive
// its own premise and kept the warning hidden on a camera that had just lost
// the ability to move the filter (#367).
//
// The rule is stated twice and has to read the same both times: j/ircut.cgi
// decides whether a pad contradicts the claim, and ircut-check.js's diagnose()
// decides whether to raise the banner the claim suppresses. If those two ever
// disagree, the camera either hides a live fault or shows a warning nobody can
// dismiss. So this drives the real shell script against a stub yaml-cli and
// asks diagnose() the same question about the same config.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, group, done } = require('./assert');

const ic = require(path.join(__dirname, '..', 'www', 'a', 'ircut-check.js'));
const CGI = path.join(__dirname, '..', 'www', 'cgi-bin', 'j', 'ircut.cgi');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ircut-claim-'));
const conf = path.join(tmp, 'ircut.conf');
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);

// The script's own text with only the config path redirected, so what runs is
// the shipped logic rather than a paraphrase of it — the same cut notice.test.js
// makes on p/common.cgi, for the same reason.
const script = (() => {
	const src = fs.readFileSync(CGI, 'utf8');
	const out = src.replace(/^CONF=.*$/m, 'CONF=' + JSON.stringify(conf));
	if (out === src) throw new Error('j/ircut.cgi no longer sets CONF= on its own line');
	return out;
})();

// Stand in for yaml-cli. It answers for .nightMode.irCutPin1 and for nothing
// else — the opening coil is the pad the whole rule turns on, so a script that
// started reading a different key must fail here rather than quietly answer
// about something majestic does not drive. An absent key exits 1 and prints
// nothing, which is what the real one does (measured on an hi3516ev200).
function stubYamlCli(value) {
	fs.writeFileSync(path.join(bin, 'yaml-cli'),
		'#!/bin/sh\n' +
		'[ "$1" = "-g" ] && [ "$2" = ".nightMode.irCutPin1" ] || exit 1\n' +
		(value === null ? 'exit 1\n'
			: 'printf \'%s\\n\' ' + JSON.stringify(String(value)) + '\n'));
	fs.chmodSync(path.join(bin, 'yaml-cli'), 0o755);
}

// One request. Returns the parsed body.
function ircut(query) {
	const out = execFileSync('sh', ['-c', script], {
		encoding: 'utf8',
		env: Object.assign({}, process.env, {
			QUERY_STRING: query || '',
			PATH: bin + ':' + process.env.PATH,
		}),
	});
	const body = out.slice(out.indexOf('\n\n') + 2);
	return JSON.parse(body);
}

const claimed = () => fs.existsSync(conf);

group('the claim is recorded on the camera, not in the browser');
{
	stubYamlCli(null);
	fs.rmSync(conf, { force: true });
	check('nothing recorded to begin with', ircut('').noFilter === false);
	check('and no file to read it out of', !claimed());

	check('dismiss records it', ircut('dismiss=1').noFilter === true);
	check('a later read still says so', ircut('').noFilter === true);
	check('because it is on the camera', claimed());

	check('clear takes it back', ircut('clear=1').noFilter === false);
	check('and the file goes with it', !claimed());
}

group('a pad wired to the filter drops the claim, whoever wired it');
{
	// The sequence from #367, with the wiring done where wiring is done: on the
	// Day / Night page, which never speaks to this endpoint. Nothing but the
	// camera sees both halves, so the camera is what has to decide.
	stubYamlCli(null);
	ircut('dismiss=1');
	check('the owner has said there is no filter', ircut('').noFilter === true);

	stubYamlCli(11);
	check('wiring the opening coil contradicts that', ircut('').noFilter === false);
	check('and the claim is gone rather than merely overruled', !claimed());

	stubYamlCli(null);
	check('so taking the pad away again brings the warning back',
		ircut('').noFilter === false);
}

group('what counts as a pad here counts as one in the finding, and the reverse');
{
	// The shell says "not wired" exactly when diagnose() raises the banner the
	// claim suppresses. Anything else is a camera that hides a live fault, or
	// one showing a warning its owner can no longer dismiss.
	const cases = [
		{ what: 'no pad at all', yaml: null, nm: {} },
		{ what: 'the opening coil', yaml: 11, nm: { irCutPin1: 11 } },
		// GPIO 0 is a real pad — the wiki lists RESET=0 on several XM boards —
		// so neither side may test a pin for truthiness.
		{ what: 'pad 0', yaml: 0, nm: { irCutPin1: 0 } },
		// majestic returns early without the opening coil whatever else is
		// set, so this camera moves nothing and is still the one the banner is
		// raised on (#273).
		{ what: 'the closing coil alone', yaml: null, nm: { irCutPin2: 10 } },
		// A hand-edited majestic.yaml can leave anything here, and yaml-cli
		// does not normalise it. `true` is not a pad however true it is.
		{ what: 'a hand-edited true', yaml: 'true', nm: { irCutPin1: true } },
		{ what: 'an empty value', yaml: '', nm: { irCutPin1: '' } },
	];
	cases.forEach((c) => {
		stubYamlCli(c.yaml);
		fs.rmSync(conf, { force: true });
		ircut('dismiss=1');
		const shellSaysPad = ircut('').noFilter === false;
		const banner = ic.diagnose(c.nm, null, null).some((f) => f.id === 'no-pins');
		check(c.what + ': the endpoint and the finding agree',
			shellSaysPad === !banner,
			'endpoint sees a pad: ' + shellSaysPad + ', banner raised: ' + banner);
	});
}

group('a claim can only ever silence the one finding it answers');
{
	// The endpoint answers a question about wiring; it is diagnose() that
	// decides there is nothing else wrong. A filter wired backwards, or one
	// parked, is a configured filter — not an absent one — so no dismissal
	// reaches those, and there is nothing here that could make one.
	stubYamlCli(11);
	fs.rmSync(conf, { force: true });
	check('a wired camera cannot even hold the claim', ircut('dismiss=1').noFilter === false);
	check('so nothing is left on disk to suppress anything', !claimed());
}

fs.rmSync(tmp, { recursive: true, force: true });
done();
