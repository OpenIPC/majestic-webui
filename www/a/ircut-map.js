// The pin map: the camera's GPIO pads, drawn, clickable, one role each.
//
// It replaces four number fields that asked the owner of a freshly converted
// camera for facts about their board's wiring that nothing on the page could
// help them find. Four inputs can only take an answer; a map can also SHOW
// things — which pads already have an owner, which the scan is walking through
// right now, and which pad a role landed on.
//
// Pads are numbered exactly as majestic's config numbers them: plain running
// integers, the same 11 that goes into nightMode.irCutPin1. The kernel's
// bank_pin form (GPIO1_3) is not shown anywhere — it is a second numbering
// nobody can map to the one they must type into a config file or read off the
// wiki, and having two is worse than having the harder one.
//
// The pad COUNT is never assumed. j/gpio.cgi reports every bank the kernel
// registered, which is 9 banks on most HiSilicon V2/V3, 10 on EV300/DV200, 17
// on a 3516AV100, and pads numbered from 224 on Novatek. The grid grows a row
// per bank rather than laying out a fixed silhouette, which is also why it is a
// pad array and not a chip outline: a package drawing would have to re-pitch
// itself per SoC, and on a BGA its pin numbers would be a fiction anyway.
(function () {
	'use strict';

	const PAD_W = 28, PAD_H = 24, GAP_X = 4, GAP_Y = 4, LABEL_W = 44, INSET = 16;

	// Pure: where every pad sits, given the banks the kernel reported. Split out
	// because it is the part that has to be right on hardware nobody here has —
	// a 17-bank SoC, or one whose pads start at 224.
	function geometry(banks) {
		const rows = [];
		const pads = [];
		let row = 0;
		(banks || []).forEach((b) => {
			// A bank wider than 8 wraps rather than running off the card: the
			// kernel is free to register 16 or 32 in one chip and does on some
			// vendors.
			for (let i = 0; i < b.n; i++) {
				const c = i % 8;
				const r = row + Math.floor(i / 8);
				pads.push({
					pin: b.base + i,
					x: LABEL_W + INSET + c * (PAD_W + GAP_X),
					y: INSET + r * (PAD_H + GAP_Y),
				});
			}
			const used = Math.ceil(b.n / 8);
			for (let k = 0; k < used; k++)
				rows.push({ y: INSET + (row + k) * (PAD_H + GAP_Y), label: String(b.base + k * 8) });
			row += used;
		});
		const bodyW = INSET * 2 + 8 * PAD_W + 7 * GAP_X;
		const bodyH = INSET + row * (PAD_H + GAP_Y) - GAP_Y + INSET + 14;
		return {
			pads: pads, rows: rows,
			bodyX: LABEL_W, bodyW: bodyW, bodyH: bodyH,
			w: LABEL_W + bodyW, h: bodyH,
		};
	}

	// The four things a pad can be. Colours are the dashboard's validated
	// series set, so a pad and its row in the list always agree.
	const ROLES = [
		{ key: 'irCutPin1', label: 'Filter, closing coil', hint: 'pulls the shutter in for daylight', color: '#4c60d8' },
		{ key: 'irCutPin2', label: 'Filter, opening coil', hint: 'lets infrared through at night', color: '#0d9488' },
		{ key: 'backlightPin', label: 'Infrared lamp', hint: 'the illuminator ring', color: '#c96a2e' },
		{ key: 'lightSensorPin', label: 'Daylight sensor', hint: 'photocell that says when it is dark', color: '#8a5cd8' },
	];
	const byKey = {};
	ROLES.forEach((r) => { byKey[r.key] = r; });

	function el(tag, cls) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		return e;
	}

	// `opts`: {info} from j/gpio.cgi, {assign} map of role -> pin, and
	// onChange(assign). The map owns no config: it reports, the page saves.
	function mount(host, opts) {
		opts = opts || {};
		const info = opts.info || { banks: [] };
		const geo = geometry(info.banks);
		let assign = Object.assign({}, opts.assign || {});
		let sel = null;
		let sweeping = null;

		// Pads with an owner that is not one of our four roles.
		//
		// Two different claims, and only one of them is real ownership.
		// /sys/kernel/debug/gpio names who holds each line: a DRIVER holds
		// hardware somebody wired on purpose — a reset, a regulator enable —
		// and that pad is untouchable. "sysfs" is only an export, which on
		// OpenIPC is majestic's, and majestic never releases a pad when its
		// nightMode key is deleted; treating that as ownership would lock a
		// camera out of the pad a rescan needs most.
		const owned = {};
		(info.assigned || []).forEach((a) => {
			if (a.role === 'ptz') owned[a.pin] = 'used by the PTZ driver';
		});
		(info.held || []).forEach((h) => {
			if (h.owner && h.owner !== 'sysfs') owned[h.pin] = 'held by ' + h.owner;
		});
		// Pads the mux has as something else. Absent unless majestic offers it.
		const notGpio = opts.notGpio || {};

		const wrap = el('div', 'mj-pinmap');
		const chip = el('div', 'mj-pinmap-chip');
		chip.style.width = geo.w + 'px';
		chip.style.height = geo.h + 'px';

		const body = el('div', 'mj-pinmap-body');
		body.style.left = geo.bodyX + 'px';
		body.style.width = geo.bodyW + 'px';
		body.style.height = geo.bodyH + 'px';
		const cap = el('span', 'mj-pinmap-cap');
		cap.textContent = opts.soc || '';
		body.appendChild(cap);
		chip.appendChild(body);

		geo.rows.forEach((r) => {
			const l = el('span', 'mj-pinmap-row');
			l.style.top = r.y + 'px';
			l.textContent = r.label;
			chip.appendChild(l);
		});

		const padEls = {};
		geo.pads.forEach((p) => {
			const b = el('button', 'mj-pin');
			b.type = 'button';
			b.style.left = p.x + 'px';
			b.style.top = p.y + 'px';
			b.textContent = String(p.pin);
			b.dataset.pin = String(p.pin);
			b.addEventListener('click', () => {
				if (b.disabled) return;
				sel = (sel === p.pin) ? null : p.pin;
				paint();
			});
			padEls[p.pin] = b;
			chip.appendChild(b);
		});

		const pop = el('div', 'mj-pinmap-pop');
		pop.hidden = true;
		chip.appendChild(pop);
		wrap.appendChild(chip);

		function roleOf(pin) {
			const k = Object.keys(assign).filter((r) => assign[r] === pin)[0];
			return k || null;
		}

		function setRole(pin, key) {
			if (key === null) {
				const had = roleOf(pin);
				if (had) delete assign[had];
			} else {
				// One pad per role and one role per pad: assigning a role that
				// already lives somewhere MOVES it rather than duplicating it.
				delete assign[key];
				const had = roleOf(pin);
				if (had) delete assign[had];
				assign[key] = pin;
			}
			sel = null;
			paint();
			if (opts.onChange) opts.onChange(Object.assign({}, assign));
		}

		function buildPop(pin) {
			pop.innerHTML = '';
			const head = el('div', 'mj-pinmap-pop-head');
			const n = el('b');
			n.textContent = 'Pin ' + pin;
			head.appendChild(n);
			const note = el('span');
			note.textContent = notGpio[pin] ? ('carries ' + notGpio[pin] + ' right now')
				: (owned[pin] || 'free');
			head.appendChild(note);
			pop.appendChild(head);
			ROLES.forEach((r) => {
				const b = el('button', 'mj-pinmap-role');
				b.type = 'button';
				const dot = el('span', 'mj-pinmap-dot');
				dot.style.background = r.color;
				b.appendChild(dot);
				const t = el('span');
				t.textContent = r.label;
				b.appendChild(t);
				const tick = el('em');
				tick.textContent = assign[r.key] === pin ? 'set'
					: (assign[r.key] !== undefined ? 'move here' : '');
				b.appendChild(tick);
				b.addEventListener('click', () => setRole(pin, r.key));
				pop.appendChild(b);
			});
			const clr = el('button', 'mj-pinmap-role');
			clr.type = 'button';
			const d0 = el('span', 'mj-pinmap-dot');
			clr.appendChild(d0);
			const t0 = el('span');
			t0.textContent = 'Not connected';
			clr.appendChild(t0);
			clr.addEventListener('click', () => setRole(pin, null));
			pop.appendChild(clr);
		}

		function paint() {
			geo.pads.forEach((p) => {
				const b = padEls[p.pin];
				const role = roleOf(p.pin);
				b.className = 'mj-pin';
				b.style.background = '';
				b.style.borderColor = '';
				b.disabled = false;
				b.title = 'Pin ' + p.pin;
				if (notGpio[p.pin]) {
					b.classList.add('mj-pin-off');
					b.disabled = true;
					b.title = 'Pin ' + p.pin + ' — carries ' + notGpio[p.pin] + ' right now';
				} else if (owned[p.pin]) {
					b.classList.add('mj-pin-owned');
					b.disabled = true;
					b.title = 'Pin ' + p.pin + ' — ' + owned[p.pin];
				}
				if (role) {
					b.classList.add('mj-pin-on');
					b.style.background = byKey[role].color;
					b.style.borderColor = byKey[role].color;
					b.title = 'Pin ' + p.pin + ' — ' + byKey[role].label;
					b.disabled = false;
				}
				if (sweeping === p.pin) b.classList.add('mj-pin-try');
				if (sel === p.pin) b.classList.add('mj-pin-sel');
			});
			if (sel === null) { pop.hidden = true; return; }
			buildPop(sel);
			const p = geo.pads.filter((x) => x.pin === sel)[0];
			// Clamped so the panel never starts off the chip; it is allowed to
			// hang over the column to its right, which is what a popover does.
			pop.style.left = Math.max(0, Math.min(p.x, geo.w - 90)) + 'px';
			pop.style.top = (p.y + PAD_H + 6) + 'px';
			pop.hidden = false;
		}

		paint();
		host.appendChild(wrap);

		return {
			el: wrap,
			roles: ROLES,
			get: () => Object.assign({}, assign),
			set: (a) => { assign = Object.assign({}, a || {}); sel = null; paint(); },
			// Called by the scan so the pad being driven lights up on the same
			// map the person is about to click.
			sweep: (pin) => { sweeping = pin; paint(); },
			select: (pin) => { sel = pin; paint(); },
		};
	}

	const api = { geometry: geometry, mount: mount, ROLES: ROLES };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticIrcutMap = api;
})();
