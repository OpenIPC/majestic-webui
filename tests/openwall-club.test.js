// The OpenWall page's Club code reaches openipc.org as the upload's own
// `club` field, and only when there is one.
//
// openipc.org links the camera to the club account whose code it carries
// (service/internal/wallstars in OpenIPC/website). The field is written by the
// page's generic params loop, so a code survives being sourced back like any
// other value (shell-quoting.test.js); what this pins is that the page offers
// it and the sender sends it -- and sends nothing when it is empty, because the
// site's upload contract is frozen and a camera without a code must send
// exactly what it sent before.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, group, done } = require('./assert');

const root = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'www', 'cgi-bin', 'openwall.cgi'), 'utf8');
const sender = fs.readFileSync(path.join(root, 'sbin', 'openwall'), 'utf8');

group('the page');
check('saves the code with the other settings', /^params="[^"]*\bclub\b[^"]*"/m.test(page));
check('offers a Club code field', page.includes('field_text "openwall_club" "Club code"'));

group('the sender');
const line = sender.split('\n').find((l) => l.includes('club=${openwall_club}'));
check('has a line that sends the club field', Boolean(line));

// Run that line with a real sh and see what it adds to the argument list.
function argsWith(code) {
	const script = `set -- curl\nopenwall_club=${JSON.stringify(code)}\n${line}\nprintf '%s\\n' "$@"`;
	return execFileSync('sh', ['-c', script], { encoding: 'utf8' }).trim().split('\n');
}
check('sends -F club=<code> when there is a code',
	JSON.stringify(argsWith('club-7K3Q-9XPA')) === JSON.stringify(['curl', '-F', 'club=club-7K3Q-9XPA']));
check('sends nothing more when there is none', JSON.stringify(argsWith('')) === JSON.stringify(['curl']));

done();
