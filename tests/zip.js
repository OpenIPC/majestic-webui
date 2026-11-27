'use strict';

// A store-only zip, built by hand: the point is that the camera's own unzip
// opens it, so nothing here may pre-digest it. `entries` is [[name, text], ...].
function zipWith(entries) {
	const tbl = [];
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		tbl[n] = c >>> 0;
	}
	const crc32 = (b) => {
		let c = 0xffffffff;
		for (const x of b) c = tbl[(c ^ x) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const locals = [];
	const central = [];
	let off = 0;
	for (const [name, text] of entries) {
		const n = Buffer.from(name);
		const d = Buffer.from(text);
		const c = crc32(d);
		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0);
		lh.writeUInt16LE(20, 4);
		lh.writeUInt32LE(c, 14);
		lh.writeUInt32LE(d.length, 18);
		lh.writeUInt32LE(d.length, 22);
		lh.writeUInt16LE(n.length, 26);
		locals.push(lh, n, d);
		const ch = Buffer.alloc(46);
		ch.writeUInt32LE(0x02014b50, 0);
		ch.writeUInt16LE(20, 4);
		ch.writeUInt16LE(20, 6);
		ch.writeUInt32LE(c, 16);
		ch.writeUInt32LE(d.length, 20);
		ch.writeUInt32LE(d.length, 24);
		ch.writeUInt16LE(n.length, 28);
		ch.writeUInt32LE(0o100755 * 0x10000, 38); // << 16 goes negative in a 32-bit signed shift
		ch.writeUInt32LE(off, 42);
		central.push(ch, n);
		off += 30 + n.length + d.length;
	}
	const body = Buffer.concat(locals);
	const dir_ = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(dir_.length, 12);
	end.writeUInt32LE(body.length, 16);
	return Buffer.concat([body, dir_, end]);
}

module.exports = { zipWith };
