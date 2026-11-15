// Which block device the SD card page manages (card_name in j/sdcard.cgi).
//
// It was fixed at mmcblk0, and a camera whose card hangs off the SoC's second
// SD controller has no mmcblk0 at all: the HI3516D_N81820 speed dome's
// built-in card is mmcblk1, so the page called a card
// absent while majestic recorded to it, and the menu hid Recordings and SD Card.
//
// The shipped shell is what runs here, against a fake /sys/block, /proc/mounts
// and /proc/cmdline.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, group, done } = require('./assert');

const CGI = path.join(__dirname, '..', 'www', 'cgi-bin', 'j', 'sdcard.cgi');
const src = fs.readFileSync(CGI, 'utf8');
const frag = src.slice(src.indexOf('card_name() {'), src.indexOf('CARD=$(card_name)'));
if (frag.indexOf('mmcblk[0-9]') < 0) {
	throw new Error('card_name was not found in the CGI; this test is testing nothing');
}

// disks: names under the fake /sys/block; mounts / cmdline: file contents.
function pick(disks, mounts, cmdline) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sddev-'));
	try {
		fs.mkdirSync(path.join(dir, 'block'));
		for (const d of disks) fs.mkdirSync(path.join(dir, 'block', d));
		fs.writeFileSync(path.join(dir, 'mounts'), mounts || '');
		fs.writeFileSync(path.join(dir, 'cmdline'), cmdline || '');
		const script = [
			'SDC_SYS_BLOCK=' + dir + '/block',
			'SDC_MOUNTS=' + dir + '/mounts',
			'SDC_CMDLINE=' + dir + '/cmdline',
			frag,
			'card_name',
		].join('\n');
		return execFileSync('sh', ['-c', script], { encoding: 'utf8' }).trim();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function main() {
	group('the card is whichever MMC disk holds it');
	check('the usual slot', pick(['mmcblk0']) === 'mmcblk0', pick(['mmcblk0']));
	check('the second controller (the HI3516D_N81820 dome): mmcblk1',
		pick(['mmcblk1'], '/dev/mmcblk1p1 /mnt/mmcblk1p1 vfat rw 0 0\n') === 'mmcblk1',
		pick(['mmcblk1']));
	check('both: the first', pick(['mmcblk0', 'mmcblk1']) === 'mmcblk0', '');

	group('not what the camera runs from, nor an eMMC\'s special areas');
	check('an SD-rooted camera (cmdline): the other disk',
		pick(['mmcblk0', 'mmcblk1'], '', 'console=ttyAMA0 root=/dev/mmcblk0p2 rootwait') === 'mmcblk1',
		pick(['mmcblk0', 'mmcblk1'], '', 'root=/dev/mmcblk0p2'));
	check('the root mounted from it: the other disk',
		pick(['mmcblk0', 'mmcblk1'], '/dev/mmcblk0p2 / ext4 rw 0 0\n') === 'mmcblk1', '');
	check('the squashfs at /rom on it: the other disk',
		pick(['mmcblk0', 'mmcblk1'], '/dev/mmcblk0p1 /rom squashfs ro 0 0\n') === 'mmcblk1', '');
	check('a card mounted under /mnt is still the card',
		pick(['mmcblk0'], '/dev/mmcblk0p1 /mnt/mmcblk0p1 vfat rw 0 0\n') === 'mmcblk0', '');
	check('boot and RPMB areas are skipped',
		pick(['mmcblk0boot0', 'mmcblk0boot1', 'mmcblk0rpmb', 'mmcblk1']) === 'mmcblk1', '');

	group('no card at all');
	check('falls back to mmcblk0, so the slot reads absent as before',
		pick([]) === 'mmcblk0', pick([]));
	done();
}

main();
