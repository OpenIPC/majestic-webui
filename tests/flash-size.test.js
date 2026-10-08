// How big the flash is, as the Dashboard and the OpenWall upload report it.
//
// It used to be the sum of the partitions, which is the chip only when they
// tile it end to end. mtdparts may define partitions that overlap, and then the
// overlap counts twice: a gk7205v500 showed "29 MB" (#642). Any layout gives a
// plausible-looking number, so nothing on the page says it is wrong.
//
// The shipped p/flash.sh runs here against fake sysfs trees. A transcription
// would be a test of the transcription.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, group, done } = require('./assert');

const SH = path.join(__dirname, '..', 'www', 'cgi-bin', 'p', 'flash.sh');
const K = 1024, M = 1024 * 1024;

// parts: [{ type, size, offset?, chip? }]; an entry of null is an mtdNro-like
// directory with no type file.
function tree(parts, cmdline) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-'));
	const mtd = path.join(root, 'sys', 'class', 'mtd');
	fs.mkdirSync(mtd, { recursive: true });
	parts.forEach((p, i) => {
		const d = path.join(mtd, 'mtd' + i);
		fs.mkdirSync(d);
		if (!p) return;
		fs.writeFileSync(path.join(d, 'type'), p.type + '\n');
		fs.writeFileSync(path.join(d, 'size'), p.size + '\n');
		if (p.offset !== undefined) fs.writeFileSync(path.join(d, 'offset'), p.offset + '\n');
		const chip = path.join(root, 'devices', p.chip || 'hisi_spi_nor.0');
		fs.mkdirSync(chip, { recursive: true });
		fs.symlinkSync(chip, path.join(d, 'device'));
	});
	// The ro twin of mtd0 sits beside it on a real camera, with no type.
	fs.mkdirSync(path.join(mtd, 'mtd0ro'));
	fs.mkdirSync(path.join(root, 'proc'));
	if (cmdline !== undefined) fs.writeFileSync(path.join(root, 'proc', 'cmdline'), cmdline + '\n');
	return root;
}

function bytes(root) {
	return execFileSync('sh', ['-c', '. "$1"; flash_bytes "$2"', 'sh', SH, root], { encoding: 'utf8' }).trim();
}

// Lay out a list of [name, size] end to end, as the kernel would.
function tiled(list, extra) {
	let pos = 0;
	return list.map(([, size]) => {
		const p = Object.assign({ type: 'nor', size, offset: pos }, extra);
		pos += size;
		return p;
	});
}

group('offsets in sysfs');
// The lab hi3516av300: 32 MB NOR, ultimate layout.
const av300 = [['boot', 256 * K], ['env', 64 * K], ['kernel', 3072 * K], ['rootfs', 24576 * K], ['rootfs_data', 4800 * K]];
check('a chip tiled end to end is its size', bytes(tree(tiled(av300))) === String(32 * M));

// 16 MB with an upgrade span over kernel and rootfs: the sum is 29 MB.
const sixteen = tiled([['boot', 256 * K], ['env', 64 * K], ['kernel', 2048 * K], ['rootfs', 8192 * K], ['rootfs_data', 5824 * K]]);
sixteen.push({ type: 'nor', size: 13 * M, offset: 320 * K });
check('an overlapping partition is not counted twice', bytes(tree(sixteen)) === String(16 * M));

const whole = tiled([['boot', 256 * K], ['env', 64 * K], ['kernel', 2048 * K], ['rootfs', 13952 * K]]);
whole.push({ type: 'nor', size: 16 * M, offset: 0 });
check('a whole-chip "all" partition is not counted twice', bytes(tree(whole)) === String(16 * M));

const two = tiled([['boot', 256 * K], ['env', 64 * K], ['rest', 7872 * K]])
	.concat(tiled([['ubi', 128 * M]], { type: 'nand', chip: 'nand.0' }));
check('two chips add up', bytes(tree(two)) === String(8 * M + 128 * M));

const ram = tiled(av300);
ram.push({ type: 'ram', size: 64 * M, offset: 0, chip: 'ram.0' });
check('a partition that is not flash is not counted', bytes(tree(ram)) === String(32 * M));

check('no flash at all says nothing, not zero', bytes(tree([])) === '');

group('no offsets in sysfs (3.x kernels)');
const strip = (list) => list.map(({ offset, ...p }) => p);
check('rebuilt from mtdparts, "-" taking the rest',
	bytes(tree(strip(tiled(av300)),
		'mem=64M console=ttyAMA0,115200 mtdparts=hi_sfc:256k(boot),64k(env),3072k(kernel),24576k(rootfs),-(rootfs_data)')) === String(32 * M));
check('an @offset span is not counted twice',
	bytes(tree(strip(sixteen),
		'mtdparts=hi_sfc:256k(boot),64k(env),2048k(kernel),8192k(rootfs),-(rootfs_data),13M@0x50000(upgrade) rootfstype=squashfs')) === String(16 * M));
check('a command line that does not match sysfs is not trusted: the sum',
	bytes(tree(strip(tiled(av300)), 'mtdparts=hi_sfc:256k(boot),64k(env),2048k(kernel),-(rootfs)')) === String(32 * M));
check('no mtdparts at all: the sum', bytes(tree(strip(sixteen), 'console=ttyS0')) === String(29 * M));

done();
