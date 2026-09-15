// How the WebUI mounts a card, which until now was "however the kernel feels".
//
// An unqualified `mount` is `-t auto`, and auto walks /proc/filesystems in the
// order the kernel lists it. On an hi3516av300 that order is
//
//   squashfs  yaffs  yaffs2  vfat
//
// so every FAT card this page mounted was offered to yaffs2 first. yaffs2
// accepts a block device rather than refusing one, and the camera's kernel log
// carries a run of `yaffs: Attempting MTD mount of 179.1,"mmcblk0p1"` for every
// mount the page ever did. Nothing noticed, because the card did land on vfat
// eventually -- which is the whole problem with it.
//
// The shipped shell is what runs here. A transcription would be a test of the
// transcription.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, group, done } = require('./assert');

const CGI = path.join(__dirname, '..', 'www', 'cgi-bin', 'j', 'sdcard.cgi');
const src = fs.readFileSync(CGI, 'utf8');
const frag = src.slice(src.indexOf('MOUNT_FSTYPES='), src.indexOf('do_mount() {'));
if (frag.indexOf('mount_card()') < 0) {
	throw new Error('mount_card was not found in the CGI; this test is testing nothing');
}

// Drive the real helper with `mount` and `mountpoint` replaced, so what it asks
// the kernel for is recorded rather than done.
function run(body) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdmount-'));
	const script = [
		'CALLS=' + dir + '/calls',
		'logln() { :; }',
		// Every attempt is recorded; success is decided by the caller's stub.
		'mount() { echo "$*" >> "$CALLS"; mount_result "$@"; }',
		'mountpoint() { [ -f ' + dir + '/mounted ]; }',
		frag,
		body,
		'echo "--calls--"; cat "$CALLS" 2>/dev/null',
	].join('\n');
	try {
		return execFileSync('sh', ['-c', script], { encoding: 'utf8' });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function calls(out) {
	const i = out.indexOf('--calls--');
	return out.slice(i + 9).split('\n').map((s) => s.trim()).filter(Boolean);
}

function main() {
	group('every mount names the filesystem it wants');
	{
		// The card is FAT, which is the first type tried, so exactly one
		// attempt should reach the kernel.
		const out = run([
			'mount_result() { touch ' + '"$(dirname "$CALLS")"/mounted; return 0; }',
			'mount_card /dev/mmcblk0p1 /mnt/mmcblk0p1',
			'echo "err:[$mt_err]"',
		].join('\n'));
		const c = calls(out);
		check('a FAT card mounts', out.indexOf('err:[]') >= 0, out);
		check('on the first attempt', c.length === 1, JSON.stringify(c));
		check('and that attempt asks for vfat', /^-t vfat /.test(c[0]), String(c[0]));
	}

	{
		// Nothing mounts. This is the case that used to walk the kernel's own
		// list, and the one that must still never leave the named set.
		const out = run([
			'mount_result() { echo "no"; return 1; }',
			'mount_card /dev/mmcblk0p1 /mnt/mmcblk0p1',
			'echo "err:[$mt_err]"',
		].join('\n'));
		const c = calls(out);
		check('a card nothing can read is reported', /err:\[.+\]/.test(out), out);
		check('every attempt named a filesystem',
			c.length > 1 && c.every((x) => x.indexOf('-t ') === 0), JSON.stringify(c));
		// The named list is the point. yaffs2 must never be among them, and
		// neither must the unqualified form that would reach it.
		check('yaffs is never offered the card',
			!c.some((x) => /-t yaffs/.test(x)), JSON.stringify(c));
		check('and neither is auto',
			!c.some((x) => /-t auto/.test(x)), JSON.stringify(c));
	}

	group('a known filesystem is asked for by name and nothing else is tried');
	{
		// The fsck path already read the type out of /proc/mounts. Trying the
		// whole list after a repair would offer a just-repaired card to nine
		// drivers that have no business with it.
		const out = run([
			'mount_result() { echo "no"; return 1; }',
			'mount_card /dev/mmcblk0p1 /mnt/mmcblk0p1 ext4',
		].join('\n'));
		const c = calls(out);
		check('only the known type is tried', c.length === 1, JSON.stringify(c));
		check('and it is the one that was known', /^-t ext4 /.test(c[0]), String(c[0]));
	}

	group('the first refusal is what gets reported');
	{
		// vfat saying "invalid argument" means a damaged filesystem. The tail
		// of the list only ever says the kernel lacks that driver, and
		// reporting the last one turns a repairable card into "no such device".
		const out = run([
			'mount_result() { case "$1 $2" in "-t vfat") echo "invalid argument";; *) echo "no such device";; esac; return 1; }',
			'mount_card /dev/mmcblk0p1 /mnt/mmcblk0p1',
			'echo "err:[$mt_err]"',
		].join('\n'));
		check('the diagnosis survives the rest of the list',
			out.indexOf('invalid argument') >= 0 && out.indexOf('err:[no such device]') < 0, out);
	}

	done();
}

main();
