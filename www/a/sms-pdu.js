// SMS and USSD, decoded and encoded in the browser.
//
// The camera's side of the SMS page is a transport: sbin/modem-at sends the AT
// commands and j/sms.cgi hands back what the modem printed, line for line.
// Everything that depends on the operator lives here, because the operator is
// what changes and a camera cannot be asked to carry a table for each one.
// Russian operators send their notices in UCS2 split over five parts, others
// send GSM 7-bit, some modems print a USSD reply as packed septets in hex and
// others as text. 3GPP TS 23.040 and 23.038 say how to read every one of
// those, and that is what this file follows -- no vendor command, no operator
// name.
//
// Pure, no DOM: tests/sms-pdu.test.js feeds it captured PDUs. The messages are
// read in PDU mode (AT+CMGF=0) rather than text mode for the same reason: text
// mode hands over whatever the modem made of the alphabet under its current
// character set, which is a different thing on every firmware, while a PDU is
// the bytes the network sent.
(function () {
	'use strict';

	// GSM 03.38 default alphabet, by septet value. 0x1B is the escape into the
	// extension table below, never a character of its own.
	const GSM7 =
		'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
		'¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
	const GSM7_EXT = {
		0x0A: '\f', 0x14: '^', 0x28: '{', 0x29: '}', 0x2F: '\\',
		0x3C: '[', 0x3D: '~', 0x3E: ']', 0x40: '|', 0x65: '€',
	};
	const GSM7_INDEX = {};
	for (let i = 0; i < GSM7.length; i++) if (i !== 0x1B) GSM7_INDEX[GSM7[i]] = [i];
	for (const k in GSM7_EXT) GSM7_INDEX[GSM7_EXT[k]] = [0x1B, +k];

	const hexBytes = (hex) => {
		const out = [];
		for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
		return out;
	};
	const toHex = (bytes) => bytes.map((b) => (b < 16 ? '0' : '') + b.toString(16)).join('').toUpperCase();
	const isHex = (s) => /^[0-9A-Fa-f]*$/.test(s) && s.length % 2 === 0;

	// Septets packed LSB-first, starting `bit` bits into the octets. Reading a
	// user-data field from bit 0 and dropping the septets the header occupies
	// lands on the text exactly, fill bits included -- the header plus its fill
	// is by construction a whole number of septets.
	function unpack7(bytes, count, bit) {
		const out = [];
		bit = bit || 0;
		for (let i = 0; i < count; i++, bit += 7) {
			const at = bit >> 3, shift = bit & 7;
			if (at >= bytes.length) break;
			let v = bytes[at] >> shift;
			if (shift > 1 && at + 1 < bytes.length) v |= bytes[at + 1] << (8 - shift);
			out.push(v & 0x7F);
		}
		return out;
	}

	// The inverse, after `head` octets of user-data header: fill to the next
	// septet boundary, then the septets.
	function pack7(septets, head) {
		head = head || [];
		const startBit = Math.ceil(head.length * 8 / 7) * 7;
		const out = head.slice();
		const total = Math.ceil((startBit + septets.length * 7) / 8);
		while (out.length < total) out.push(0);
		let bit = startBit;
		for (const s of septets) {
			const at = bit >> 3, shift = bit & 7;
			out[at] |= (s << shift) & 0xFF;
			if (shift > 1) out[at + 1] |= s >> (8 - shift);
			bit += 7;
		}
		return out;
	}

	function gsm7Text(septets) {
		let s = '';
		for (let i = 0; i < septets.length; i++) {
			const c = septets[i];
			if (c === 0x1B && i + 1 < septets.length) {
				const e = GSM7_EXT[septets[++i]];
				s += e === undefined ? ' ' : e;
			} else {
				s += c === 0x1B ? ' ' : GSM7[c];
			}
		}
		return s;
	}

	// UTF-16BE, so an emoji arrives as the surrogate pair the operator sent and
	// JS strings hold it as one.
	function ucs2Text(bytes) {
		let s = '';
		for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
		return s;
	}

	// Semi-octets: each octet holds two decimal digits, low nibble first.
	function semiOctets(bytes) {
		let s = '';
		for (const b of bytes) {
			s += (b & 0x0F).toString(16);
			s += (b >> 4).toString(16);
		}
		return s.replace(/f+$/i, '');
	}

	// The alphabet a DCS selects (23.038 §4). The general groups 00xx and 01xx
	// carry it in bits 3..2; F0 is the old data-coding group, E0 the UCS2
	// message-waiting group. Anything else is GSM 7-bit by definition.
	function alphabet(dcs) {
		const group = dcs & 0xC0;
		if (group === 0x00 || group === 0x40) {
			if (dcs & 0x20) return 'compressed';
			return ['gsm7', '8bit', 'ucs2', 'gsm7'][(dcs >> 2) & 3];
		}
		if ((dcs & 0xF0) === 0xF0) return dcs & 0x04 ? '8bit' : 'gsm7';
		if ((dcs & 0xF0) === 0xE0) return 'ucs2';
		return 'gsm7';
	}

	// An address field (TP-OA / TP-DA): length in digits, type, digits. Type
	// 0x5x is alphanumeric -- a sender like "T2" or "Bank" -- and its length
	// counts semi-octets of GSM 7-bit text.
	function readAddress(bytes, at) {
		const len = bytes[at], toa = bytes[at + 1];
		const octets = Math.ceil(len / 2);
		const raw = bytes.slice(at + 2, at + 2 + octets);
		let addr;
		if ((toa & 0x70) === 0x50) {
			addr = gsm7Text(unpack7(raw, Math.floor(len * 4 / 7)));
		} else {
			addr = semiOctets(raw).slice(0, len);
			if ((toa & 0x70) === 0x10) addr = '+' + addr;
		}
		return { addr: addr, next: at + 2 + octets };
	}

	// TP-SCTS: seven semi-octet fields, the last a signed quarter-hour offset
	// from UTC whose sign is bit 3 of the octet as stored.
	function readTimestamp(b) {
		const d = (x) => (x & 0x0F) * 10 + (x >> 4);
		const tzRaw = b[6];
		let tz = (tzRaw & 0x07) * 10 + (tzRaw >> 4);
		if (tzRaw & 0x08) tz = -tz;
		const p = (n) => (n < 10 ? '0' : '') + n;
		const zone = (tz < 0 ? '-' : '+') + p(Math.floor(Math.abs(tz) / 4)) + ':' + p((Math.abs(tz) % 4) * 15);
		return '20' + p(d(b[0])) + '-' + p(d(b[1])) + '-' + p(d(b[2])) + 'T' +
			p(d(b[3])) + ':' + p(d(b[4])) + ':' + p(d(b[5])) + zone;
	}

	// One PDU as listed by AT+CMGL in PDU mode: SMSC, then an SMS-DELIVER (a
	// message received) or an SMS-SUBMIT (one stored for sending). Returns null
	// for anything it cannot read, so a status report in the store does not take
	// the whole inbox down with it.
	function decodePdu(hex) {
		if (!isHex(hex) || hex.length < 4) return null;
		const b = hexBytes(hex);
		try {
			let at = 1 + b[0];
			const fo = b[at++];
			const mti = fo & 0x03;
			const msg = { type: mti === 1 ? 'submit' : 'deliver', time: null, addr: '' };
			if (mti === 1) {
				at++; // TP-MR
				const a = readAddress(b, at);
				msg.addr = a.addr; at = a.next;
			} else if (mti === 0) {
				const a = readAddress(b, at);
				msg.addr = a.addr; at = a.next;
			} else {
				return null;
			}
			at++; // TP-PID
			const dcs = b[at++];
			if (mti === 0) {
				msg.time = readTimestamp(b.slice(at, at + 7));
				at += 7;
			} else {
				const vpf = (fo >> 3) & 3;
				at += vpf === 2 ? 1 : vpf === 0 ? 0 : 7;
			}
			const udl = b[at++];
			const ud = b.slice(at);
			const alpha = alphabet(dcs);
			msg.encoding = alpha;
			let headLen = 0;
			if (fo & 0x40) {
				headLen = ud[0] + 1;
				const parts = readUdh(ud.slice(1, headLen));
				if (parts) Object.assign(msg, parts);
			}
			if (alpha === 'gsm7') {
				const skip = Math.ceil(headLen * 8 / 7);
				msg.text = gsm7Text(unpack7(ud, udl).slice(skip));
			} else if (alpha === 'ucs2') {
				msg.text = ucs2Text(ud.slice(headLen, udl));
			} else {
				msg.text = '';
				msg.binary = toHex(ud.slice(headLen, udl));
			}
			return msg;
		} catch (e) {
			return null;
		}
	}

	// Concatenation, 23.040 §9.2.3.24.1 and .8: IE 00 with an 8-bit reference,
	// IE 08 with a 16-bit one. Every other IE is skipped.
	function readUdh(h) {
		for (let i = 0; i + 1 < h.length; ) {
			const iei = h[i], len = h[i + 1], d = h.slice(i + 2, i + 2 + len);
			if (iei === 0x00 && len === 3) return { ref: d[0], total: d[1], seq: d[2] };
			if (iei === 0x08 && len === 4) return { ref: (d[0] << 8) | d[1], total: d[2], seq: d[3] };
			i += 2 + len;
		}
		return null;
	}

	// AT+CMGL in PDU mode lists `+CMGL: <idx>,<stat>,[<alpha>],<length>` and
	// the PDU on the next line. The transcript is what j/sms.cgi returns:
	// sbin/modem-at writes each command it sends as "=> <command>", so a reply
	// is attributed to the storage the AT+CPMS before it selected, whatever the
	// modem echoes or does not.
	const STAT = ['unread', 'read', 'unsent', 'sent'];
	function parseList(lines) {
		const out = [];
		let mem = '';
		for (let i = 0; i < lines.length; i++) {
			const sel = /^=> AT\+CPMS="([A-Z]{2})"/.exec(lines[i]);
			if (sel) { mem = sel[1]; continue; }
			const m = /^\+CMGL:\s*(\d+),(\d+)/.exec(lines[i]);
			if (!m || i + 1 >= lines.length) continue;
			const pdu = lines[++i].trim();
			const msg = decodePdu(pdu);
			const loc = { mem: mem, idx: +m[1] };
			if (!msg) { out.push({ unreadable: true, pdu: pdu, stat: STAT[+m[2]] || '', parts: [loc] }); continue; }
			msg.stat = STAT[+m[2]] || '';
			msg.loc = loc;
			out.push(msg);
		}
		return out;
	}

	// Join the parts of a multi-part message: same sender, same reference, same
	// part count. A part that never arrived leaves a visible gap rather than a
	// silently shorter text, and a part delivered twice is kept once for reading
	// but both copies are listed for deleting, or the second would stay on the
	// SIM taking a slot nobody can see.
	function joinParts(msgs) {
		const groups = new Map();
		const out = [];
		for (const m of msgs) {
			if (m.unreadable || !m.total || m.total < 2) {
				out.push(Object.assign({}, m, { parts: m.parts || [m.loc], missing: 0 }));
				continue;
			}
			const key = m.type + '|' + m.addr + '|' + m.ref + '|' + m.total;
			let g = groups.get(key);
			if (!g) {
				g = { msg: Object.assign({}, m, { parts: [], bySeq: {} }) };
				groups.set(key, g);
				out.push(g.msg);
			}
			g.msg.parts.push(m.loc);
			if (!g.msg.bySeq[m.seq]) g.msg.bySeq[m.seq] = m;
			if (m.stat === 'unread') g.msg.stat = 'unread';
			if (m.time && (!g.msg.time || m.time < g.msg.time)) g.msg.time = m.time;
		}
		for (const g of groups.values()) {
			const m = g.msg;
			let text = '', missing = 0;
			for (let s = 1; s <= m.total; s++) {
				if (m.bySeq[s]) text += m.bySeq[s].text;
				else { text += ' […] '; missing++; }
			}
			m.text = text;
			m.missing = missing;
			delete m.bySeq;
			delete m.seq;
		}
		return out.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
	}

	// ---- sending ----

	function gsm7Septets(text) {
		const out = [];
		for (const ch of text) {
			const s = GSM7_INDEX[ch];
			if (!s) return null;
			out.push.apply(out, s);
		}
		return out;
	}

	// Split for sending: one part if it fits (160 septets / 70 UTF-16 units),
	// otherwise parts of 153 / 67 that leave room for the concatenation header.
	// Never splits an escape pair or a surrogate pair across two parts.
	function split(text) {
		const septets = gsm7Septets(text);
		if (septets) {
			if (septets.length <= 160) return { encoding: 'gsm7', parts: [septets] };
			const parts = [];
			for (let i = 0; i < septets.length; ) {
				let end = Math.min(i + 153, septets.length);
				if (end < septets.length && septets[end - 1] === 0x1B) end--;
				parts.push(septets.slice(i, end));
				i = end;
			}
			return { encoding: 'gsm7', parts: parts };
		}
		const units = [];
		for (let i = 0; i < text.length; i++) units.push(text.charCodeAt(i));
		if (units.length <= 70) return { encoding: 'ucs2', parts: [units] };
		const parts = [];
		for (let i = 0; i < units.length; ) {
			let end = Math.min(i + 67, units.length);
			if (end < units.length && units[end - 1] >= 0xD800 && units[end - 1] <= 0xDBFF) end--;
			parts.push(units.slice(i, end));
			i = end;
		}
		return { encoding: 'ucs2', parts: parts };
	}

	// The number as typed: spaces, dashes, dots and brackets are dropped; a
	// leading + makes it international. Anything else is not a number.
	function normaliseNumber(s) {
		const t = String(s || '').replace(/[\s\-().]/g, '');
		return /^\+?[0-9]{3,20}$/.test(t) ? t : null;
	}

	// SMS-SUBMIT PDUs for AT+CMGS, each { len, pdu }. The SMSC field is empty
	// ("00"), which tells the modem to use the centre stored on the SIM -- the
	// one the operator put there -- and is why `len` excludes that first octet.
	function encodeSubmit(number, text, ref) {
		const num = normaliseNumber(number);
		if (!num) throw new Error('bad number');
		const digits = num.replace('+', '');
		const toa = num[0] === '+' ? 0x91 : 0x81;
		const addr = [digits.length, toa];
		const padded = digits.length % 2 ? digits + 'F' : digits;
		for (let i = 0; i < padded.length; i += 2) addr.push(parseInt(padded[i + 1] + padded[i], 16));
		const sp = split(text);
		if (sp.parts.length > 10) throw new Error('too long');
		ref = (ref === undefined ? Math.floor(Math.random() * 256) : ref) & 0xFF;
		const multi = sp.parts.length > 1;
		return sp.parts.map((part, n) => {
			const head = multi ? [0x05, 0x00, 0x03, ref, sp.parts.length, n + 1] : [];
			// SUBMIT, relative validity period present, UDHI when parts follow.
			const fo = 0x01 | 0x10 | (multi ? 0x40 : 0);
			const dcs = sp.encoding === 'gsm7' ? 0x00 : 0x08;
			let udl, ud;
			if (sp.encoding === 'gsm7') {
				ud = pack7(part, head);
				udl = Math.ceil(head.length * 8 / 7) + part.length;
			} else {
				ud = head.slice();
				for (const u of part) ud.push(u >> 8, u & 0xFF);
				udl = ud.length;
			}
			// Validity 0xA7: 24 hours, after which the centre gives up.
			const tpdu = [fo, 0x00].concat(addr, [0x00, dcs, 0xA7, udl], ud);
			return { len: tpdu.length, pdu: '00' + toHex(tpdu) };
		});
	}

	// What the person is about to send, for the counter under the box.
	function measure(text) {
		const sp = split(text || '');
		const n = sp.parts.reduce((a, p) => a + p.length, 0);
		return { encoding: sp.encoding, units: n, parts: text ? sp.parts.length : 0 };
	}

	// ---- USSD ----

	// The +CUSD line in the transcript: `+CUSD: <m>[,"<str>"[,<dcs>]]`.
	// <m> 0 is a final answer, 1 means the network expects a reply (a menu),
	// 2 the network ended the session, 4 unsupported, 5 timed out.
	function parseUssd(lines) {
		for (const l of lines) {
			const m = /^\+CUSD:\s*(\d)(?:,"([^"]*)"(?:,(\d+))?)?/.exec(l);
			if (m) {
				const dcs = m[3] === undefined ? null : +m[3];
				return { status: +m[1], raw: m[2] || '', dcs: dcs, text: decodeUssd(m[2] || '', dcs) };
			}
		}
		return null;
	}

	// The reply string means different things depending on the DCS and on what
	// the modem made of it. Asked under AT+CSCS="GSM", which sbin/modem-at
	// arranges: a UCS2 reply comes as hex of UTF-16 (T2 does this, DCS 17 or
	// 72); a GSM 7-bit reply comes as text on most modems and as hex of packed
	// septets on some Huawei and SIMCom firmware. Hex that decodes cleanly is
	// taken as hex; anything else is the text it already is.
	function decodeUssd(str, dcs) {
		const alpha = dcs === null || dcs === undefined ? null : ussdAlphabet(dcs);
		const hex = isHex(str) && str.length >= 4;
		const utf16 = hex && str.length % 4 === 0;
		if (alpha === 'ucs2') return utf16 ? ucs2Text(hexBytes(str)) : str;
		// No usable DCS, or a 7-bit reply that a modem left in UCS2 mode
		// re-encoded on the way out.
		if (utf16 && looksUcs2(str)) return ucs2Text(hexBytes(str));
		if (hex && str.length >= 8 && alpha !== '8bit') {
			const bytes = hexBytes(str);
			const t = gsm7Text(unpack7(bytes, Math.floor(bytes.length * 8 / 7))).replace(/@+$/, '');
			if (/^[\x20-\x7E -ÿΑ-Ω\n\r€]+$/.test(t) && /[A-Za-z]{2}/.test(t)) return t;
		}
		return str;
	}

	// USSD uses the cell-broadcast coding scheme, which agrees with the SMS one
	// for 01xx and differs elsewhere (23.038 §5): 0000 and 0010-0011 are GSM
	// 7-bit with a language, 0001 is GSM 7-bit (0x10) or UCS2 (0x11).
	function ussdAlphabet(dcs) {
		const hi = dcs >> 4;
		if (hi === 0x0 || hi === 0x2 || hi === 0x3) return 'gsm7';
		if (hi === 0x1) return dcs === 0x11 ? 'ucs2' : 'gsm7';
		if ((dcs & 0xC0) === 0x40) return alphabet(dcs);
		if (hi === 0x9) return alphabet(dcs & 0x0F);
		if (hi === 0xF) return dcs & 0x04 ? '8bit' : 'gsm7';
		return null;
	}

	// UTF-16 of a real language has a high byte that repeats -- 00 for Latin, 04
	// for Cyrillic -- while packed septets look like noise.
	function looksUcs2(str) {
		const highs = {};
		let n = 0;
		for (let i = 0; i < str.length; i += 4, n++) highs[str.substr(i, 2)] = (highs[str.substr(i, 2)] || 0) + 1;
		const top = Math.max.apply(null, Object.values(highs));
		return top / n >= 0.6;
	}

	// The codes a person types for a balance or a package: digits, * and #.
	// Nothing else is passed to the modem.
	const validUssd = (code) => /^[0-9*#]{1,32}$/.test(code || '');

	const api = {
		decodePdu: decodePdu, parseList: parseList, joinParts: joinParts,
		encodeSubmit: encodeSubmit, measure: measure, normaliseNumber: normaliseNumber,
		parseUssd: parseUssd, decodeUssd: decodeUssd, validUssd: validUssd,
		pack7: pack7, unpack7: unpack7, GSM7: GSM7,
	};
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticSms = api;
})();
