// Which MMC disk is the SD card, and which controller its slot is on
// (p/sdcard-dev.sh, shared by j/sdcard.cgi and the menu in p/common.cgi).
//
// Both were fixed: the disk at mmcblk0 and the slot at mmc0. A camera whose card
// hangs off the SoC's second SD controller has neither -- the HI3516D_N81820
// speed dome's built-in card is mmcblk1 on mmc1 -- so the SD card page called
// the card absent while majestic recorded to it, and the menu hid Recordings and
// SD Card. And a disk that is not a card must never be picked: an eMMC's user
// area, or the SD the camera boots from, is a format away from being wiped.
//
// The shipped shell is what runs here, against a fake /sys and /proc.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, group, done } = require('./assert');

const LIB = path.join(__dirname, '..', 'www', 'cgi-bin', 'p', 'sdcard-dev.sh');

// hosts: { mmc0: [{ name: 'mmc0:0001', type: 'SDIO', disk: null }], ... };
// a card with `disk` gets /sys/block/<disk>/device -> its node under the host.
function run(fn, hosts, opt) {
	opt = opt || {};
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sddev-'));
	try {
		const block = path.join(dir, 'block'), host = path.join(dir, 'mmc_host');
		fs.mkdirSync(block); fs.mkdirSync(host);
		for (const [h, cards] of Object.entries(hosts)) {
			fs.mkdirSync(path.join(host, h));
			for (const c of cards) {
				const node = path.join(host, h, c.name);
				fs.mkdirSync(node);
				fs.writeFileSync(path.join(node, 'type'), c.type + '\n');
				if (c.disk) {
					fs.mkdirSync(path.join(block, c.disk));
					fs.symlinkSync(node, path.join(block, c.disk, 'device'));
					for (const extra of c.areas || []) fs.mkdirSync(path.join(block, extra));
				}
			}
		}
		fs.writeFileSync(path.join(dir, 'mounts'), opt.mounts || '');
		fs.writeFileSync(path.join(dir, 'cmdline'), opt.cmdline || '');
		const script = [
			'SDC_SYS_BLOCK=' + block, 'SDC_MMC_HOST=' + host,
			'SDC_MOUNTS=' + dir + '/mounts', 'SDC_CMDLINE=' + dir + '/cmdline',
			'. ' + LIB,
			'if r=$(' + fn + '); then echo "ok:$r"; else echo "none"; fi',
		].join('\n');
		return execFileSync('sh', ['-c', script], { encoding: 'utf8' }).trim();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
const card = (fn, hosts, opt) => run(fn, hosts, opt);
const sd = (h, n) => ({ name: h + ':aaaa', type: 'SD', disk: 'mmcblk' + n });

function main() {
	group('the card is whichever MMC disk holds one');
	check('the usual slot: mmcblk0', card('sd_card_name', { mmc0: [sd('mmc0', 0)] }) === 'ok:mmcblk0', '');
	{
		const r = card('sd_card_name', { mmc0: [{ name: 'mmc0:0001', type: 'SDIO' }], mmc1: [sd('mmc1', 1)] },
			{ mounts: '/dev/mmcblk1p1 /mnt/mmcblk1p1 vfat rw 0 0\n' });
		check('the second controller, Wi-Fi on the first (the HI3516D_N81820 dome): mmcblk1', r === 'ok:mmcblk1', r);
	}
	check('two cards: the first', card('sd_card_name', { mmc0: [sd('mmc0', 0)], mmc1: [sd('mmc1', 1)] }) === 'ok:mmcblk0', '');

	group('never a disk that is not the card');
	{
		const r = card('sd_card_name', {
			mmc0: [{ name: 'mmc0:0001', type: 'MMC', disk: 'mmcblk0', areas: ['mmcblk0boot0', 'mmcblk0boot1', 'mmcblk0rpmb'] }],
			mmc1: [sd('mmc1', 1)],
		});
		check('an eMMC is skipped, boot and RPMB areas with it', r === 'ok:mmcblk1', r);
	}
	check('an eMMC and no card: none',
		card('sd_card_name', { mmc0: [{ name: 'mmc0:0001', type: 'MMC', disk: 'mmcblk0' }] }) === 'none', '');
	check('the SD the camera boots from (cmdline): the other card',
		card('sd_card_name', { mmc0: [sd('mmc0', 0)], mmc1: [sd('mmc1', 1)] },
			{ cmdline: 'console=ttyAMA0 root=/dev/mmcblk0p2 rootwait' }) === 'ok:mmcblk1', '');
	check('the root mounted from it: the other card',
		card('sd_card_name', { mmc0: [sd('mmc0', 0)], mmc1: [sd('mmc1', 1)] },
			{ mounts: '/dev/mmcblk0p2 / ext4 rw 0 0\n' }) === 'ok:mmcblk1', '');
	check('the squashfs at /rom on it: the other card',
		card('sd_card_name', { mmc0: [sd('mmc0', 0)], mmc1: [sd('mmc1', 1)] },
			{ mounts: '/dev/mmcblk0p1 /rom squashfs ro 0 0\n' }) === 'ok:mmcblk1', '');
	check('booting from the only card: none, not that card',
		card('sd_card_name', { mmc0: [sd('mmc0', 0)] }, { cmdline: 'root=/dev/mmcblk0p2' }) === 'none', '');
	check('a card mounted under /mnt is still the card',
		card('sd_card_name', { mmc0: [sd('mmc0', 0)] },
			{ mounts: '/dev/mmcblk0p1 /mnt/mmcblk0p1 vfat rw 0 0\n' }) === 'ok:mmcblk0', '');
	check('no MMC disk at all: none', card('sd_card_name', {}) === 'none', '');

	group('the slot is the card\'s own controller, or an empty one');
	{
		const r = card('sd_slot_host', { mmc0: [{ name: 'mmc0:0001', type: 'SDIO' }], mmc1: [sd('mmc1', 1)] });
		check('with a card on mmc1: mmc1', r === 'ok:mmc1', r);
	}
	{
		const r = card('sd_slot_host', { mmc0: [{ name: 'mmc0:0001', type: 'SDIO' }], mmc1: [] });
		check('no card, Wi-Fi on mmc0: the empty mmc1, never the Wi-Fi', r === 'ok:mmc1', r);
	}
	{
		const r = card('sd_slot_host', { mmc0: [{ name: 'mmc0:0001', type: 'MMC', disk: 'mmcblk0' }] });
		check('only an eMMC host: none', r === 'none', r);
	}
	check('no card on a one-slot camera: mmc0', card('sd_slot_host', { mmc0: [] }) === 'ok:mmc0', '');
	done();
}

main();
