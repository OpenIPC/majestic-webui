// Whether System / Network says a saved setting is waiting for a restart.
//
// net_pending in network.cgi holds the file an interface boots from against
// what the kernel is doing, and its answer raises the restart banner across
// the top of every page. Wrong in one direction, a change sits unapplied with
// nothing saying so; wrong in the other, the banner asks for a restart that
// cannot clear it, and asks again after every one. That second fault shipped:
// a camera on Wi-Fi with the cable out has eth0 up, dark and empty -- the
// firmware reads eth0's file only once a cable arrives -- and the page read
// "no address" as "not what the file says" (#720). Reaching it needs a
// wireless adapter, a saved network and an unplugged cable, so it is checked
// here: the shipped function is lifted out of the page and run under sh with
// each reading set by hand.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { check, group, done } = require('./assert');

const PAGE = path.join(__dirname, '..', 'www', 'cgi-bin', 'network.cgi');

// wpa_passphrase as the page calls it: the PSK is a stand-in that changes
// with the password, which is all net_pending compares.
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'net-pending-'));
fs.writeFileSync(path.join(BIN, 'wpa_passphrase'),
	'#!/bin/sh\n[ "$2" = secret ] && p=abc123 || p=fff000\nprintf \'network={\\n\\tssid="%s"\\n\\tpsk=%s\\n}\\n\' "$1" "$p"\n');
fs.chmodSync(path.join(BIN, 'wpa_passphrase'), 0o755);

function lift(src, name) {
	const lines = src.split('\n');
	const start = lines.indexOf(name + '() {');
	if (start < 0) return null;
	const end = lines.indexOf('}', start);
	return end < 0 ? null : lines.slice(start, end + 1).join('\n');
}

const fn = lift(fs.readFileSync(PAGE, 'utf8'), 'net_pending');
check('net_pending is found in network.cgi', fn !== null);

// Every reading net_read leaves behind, as an interface that is up, on DHCP,
// and doing what its file says.
const BASE = {
	booted: 1, cable: 1,
	cfg_mode: 'dhcp', now_mode: 'dhcp', now_carrier: '1',
	cfg_address: '', now_address: '192.0.2.20',
	cfg_netmask: '', now_netmask: '255.255.255.0',
	cfg_gateway: '', now_gateway: '192.0.2.1',
	cfg_nameserver: '', now_nameserver: '192.0.2.1',
	network_wlan_ssid: '', network_wlan_password: '', now_ssid: '', now_psk: '',
};

function pending(iface, over) {
	const v = Object.assign({}, BASE, over);
	const env = { PATH: BIN + ':' + process.env.PATH };
	for (const k of Object.keys(v)) env[k] = String(v[k]);
	const script = `iface_is_booted() { [ -n "$booted" ]; }\nwaits_for_cable() { [ "$1" = eth0 ] && [ -n "$cable" ]; }\n${fn}\nnet_pending "$1" && echo yes || echo no`;
	const r = spawnSync('sh', ['-c', script, 'sh', iface], { env, encoding: 'utf8' });
	return r.stdout.trim();
}

if (fn) {
	group('a link with nothing on it has nothing to hold the file against');
	const dark = { now_mode: '', now_address: '', now_netmask: '', now_gateway: '', now_nameserver: '', now_carrier: '0' };
	check('eth0 on DHCP, cable out, Wi-Fi carrying the camera: no banner', pending('eth0', dark) === 'no');
	check('eth0 with a fixed address in its file, cable out and empty: no banner',
		pending('eth0', Object.assign({}, dark, { cfg_mode: 'static', cfg_address: '192.0.2.30' })) === 'no');

	group('but only a link known to be dark');
	check('cable in and no lease: the file is not in effect, and that is a banner',
		pending('eth0', Object.assign({}, dark, { now_carrier: '1' })) === 'yes');
	check('carrier unreadable (interface down) is not "no cable": still judged',
		pending('eth0', Object.assign({}, dark, { now_carrier: '' })) === 'yes');
	check('a fixed address held on a dark link is still compared with the file',
		pending('eth0', { cfg_mode: 'static', cfg_address: '192.0.2.31', cfg_netmask: '255.255.255.0',
			cfg_gateway: '192.0.2.1', cfg_nameserver: '192.0.2.1', now_mode: 'static', now_carrier: '0' }) === 'yes');

	check('eth0 dark and empty where the boot script read it at boot: still judged',
		pending('eth0', Object.assign({}, dark, { cable: '' })) === 'yes');
	check('wlan0 dark and empty is still judged: its file was read at boot',
		pending('wlan0', dark) === 'yes');
	check('wlan0 dark, empty, with no supplicant file to read credentials from: still judged',
		pending('wlan0', Object.assign({}, dark, { network_wlan_ssid: 'home', now_ssid: '', now_psk: '' })) === 'yes');

	group('what it judged before is unchanged');
	check('DHCP in the file and in the kernel: no banner', pending('eth0', {}) === 'no');
	check('file says static, kernel holds a lease: banner',
		pending('eth0', { cfg_mode: 'static', cfg_address: '192.0.2.30' }) === 'yes');
	check('an interface the boot script does not read is never pending',
		pending('eth0', Object.assign({}, dark, { booted: '', now_carrier: '1' })) === 'no');
	check('no file at all is never pending', pending('eth0', { cfg_mode: '' }) === 'no');

	group('wireless credentials are judged even on a dark link');
	// A wrong password leaves wlan0 dark, and the right one takes effect on
	// the restart -- so the dark-link exemption must not swallow this check.
	// As the boot script leaves it: udhcpc is running whether or not the
	// access point lets it in, so the mode reads DHCP with nothing leased.
	const wifi = Object.assign({}, dark, { now_mode: 'dhcp', network_wlan_ssid: 'home', network_wlan_password: 'secret', now_ssid: 'home', now_psk: 'abc123' });
	check('the saved network is the one in use: no banner', pending('wlan0', wifi) === 'no');
	check('a new network name saved while wlan0 has no access point: banner',
		pending('wlan0', Object.assign({}, wifi, { network_wlan_ssid: 'other' })) === 'yes');
	check('a new password saved while wlan0 has no access point: banner',
		pending('wlan0', Object.assign({}, wifi, { network_wlan_password: 'changed' })) === 'yes');
}

fs.rmSync(BIN, { recursive: true, force: true });
done();
