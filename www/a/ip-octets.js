// An IPv4 address as four boxes, one per octet (#695).
//
// Drawn in front of the text field it replaces, which stays in the form with
// its name, hidden, and is what is posted: every edit here writes the joined
// address back into it. The page's save, setnetwork and the server's own
// checks are untouched, and without script the text field is simply there.
// The same deal as the other controls that stand in for fields
// (mj-settings.js): the fields are kept, the control only drives them.
//
// A segmented field is only better if it edits at least as well as the box
// it replaces, so the habits of a text field are kept. A whole address
// pasted into any box fills all four. A dot, a space or a third digit moves
// on. Backspace in an empty box goes back, and the arrow keys cross from box
// to box at the edges. A number over 255 is refused in the box that holds
// it, when it is typed, not at Save.
//
// A value that is not an IPv4 address is left as text: a resolver can be an
// IPv6 one, and four boxes cannot hold it. For the same reason a field that
// allows it turns back into text when one is pasted or typed.
//
// The pure half (split, join, problem, next) is exported for
// tests/ip-octets.test.js; mount() is the browser's.
(function (root, factory) {
	const api = factory();
	root.MajesticIpOctets = api;
	if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	// The four parts of a value, or null where it is not an IPv4 address in
	// the making. Empty is four empty parts: a field nobody has filled.
	function split(v) {
		const s = String(v == null ? '' : v).trim();
		if (s === '') return ['', '', '', ''];
		const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
		return m ? [m[1], m[2], m[3], m[4]] : null;
	}

	// The address the parts make. All empty is an empty field, not "...".
	// Leading zeros are dropped: 010 is ten to a person, and eight to some
	// parsers that read it as octal.
	function join(parts) {
		if (parts.every((p) => p === '')) return '';
		return parts.map((p) => (p === '' ? '' : String(parseInt(p, 10)))).join('.');
	}

	// What is wrong with the parts, as a sentence, or '' when nothing is.
	function problem(parts) {
		if (parts.every((p) => p === '')) return '';
		for (let i = 0; i < 4; i++) {
			if (parts[i] === '') return 'Fill in all four parts of the address.';
			if (+parts[i] > 255) return 'Each part of an address is a number from 0 to 255.';
		}
		return '';
	}

	// Whether a box holding `v` is finished and the caret should move on: three
	// digits, or a number that one more digit would take past 255 -- but never
	// a number already over it, so that the caret stays where the fault is.
	function next(v) {
		return /^\d+$/.test(v) && +v <= 255 && (v.length >= 3 || +v > 25);
	}

	// Four boxes in front of `input`. `opts.textOk`: a pasted value that is
	// not IPv4 turns the field back into text rather than being refused.
	function mount(input, opts) {
		const o = opts || {};
		if (!input || input.dataset.octets) return null;
		const start = split(input.value);
		if (!start) return null;
		input.dataset.octets = '1';
		const hint = split(input.placeholder || '') || ['', '', '', ''];
		const label = input.id && document.querySelector('label[for="' + input.id + '"]');
		const name = label ? label.textContent.trim() : 'Address';

		const wrap = document.createElement('span');
		wrap.className = 'mj-ip4';
		wrap.setAttribute('role', 'group');
		wrap.setAttribute('aria-label', name);
		const boxes = [];
		for (let i = 0; i < 4; i++) {
			if (i) {
				const dot = document.createElement('span');
				dot.className = 'mj-ip4-dot';
				dot.setAttribute('aria-hidden', 'true');
				dot.textContent = '.';
				wrap.appendChild(dot);
			}
			const b = document.createElement('input');
			b.type = 'text';
			b.className = 'form-control mj-ip4-in';
			b.inputMode = 'numeric';
			b.autocomplete = 'off';
			b.maxLength = 3;
			b.value = start[i];
			b.placeholder = hint[i];
			b.setAttribute('aria-label', name + ', part ' + (i + 1) + ' of 4');
			if (i === 0 && input.id) b.id = input.id + '_o1';
			boxes.push(b);
			wrap.appendChild(b);
		}
		// The label names the first box now; the hidden field is not focusable.
		if (label && boxes[0].id) label.htmlFor = boxes[0].id;
		input.hidden = true;
		input.insertAdjacentElement('beforebegin', wrap);

		const parts = () => boxes.map((b) => b.value);
		// Writes the address back, and says what is wrong where it is wrong.
		// The first box at fault carries the message, so the browser's own
		// refusal at Save points at it. A number over 255 is marked as it is
		// typed; a box left empty in an address otherwise begun only once the
		// caret has left all four, so the box being filled in is not called
		// wrong for being empty.
		// Gone once the field is text again: a check still queued from the
		// box the caret just left must not write the boxes' value over what
		// is now being typed into the field itself.
		let gone = false;
		const sync = () => {
			if (gone) return;
			input.value = join(parts());
			// A read-only field is a reading (Automatic), not something the
			// save is waiting on: an address half-typed under Manual must not
			// stop the switch back to DHCP from being saved.
			const why = input.readOnly ? '' : problem(parts());
			const away = !wrap.contains(document.activeElement);
			boxes.forEach((b) => {
				b.classList.toggle('mj-ip4-bad', +b.value > 255 || (why !== '' && away && b.value === ''));
				b.setCustomValidity('');
			});
			if (why) {
				const at = boxes.find((b) => b.value === '' || +b.value > 255) || boxes[3];
				at.setCustomValidity(why);
			}
			input.dispatchEvent(new Event('input', { bubbles: true }));
		};
		const go = (i, where) => {
			const b = boxes[i];
			if (!b) return;
			b.focus();
			const at = where === 'end' ? b.value.length : 0;
			try { b.setSelectionRange(at, where === 'all' ? b.value.length : at); } catch (e) { /* not a text box */ }
		};
		// Back to text, keeping the value: a resolver given as IPv6.
		const toText = (v) => {
			gone = true;
			wrap.remove();
			input.hidden = false;
			delete input.dataset.octets;
			if (label) label.htmlFor = input.id;
			input.value = v;
			input.dispatchEvent(new Event('input', { bubbles: true }));
			input.focus();
			try { input.setSelectionRange(v.length, v.length); } catch (e) { /* not a text box */ }
		};

		boxes.forEach((b, i) => {
			b.addEventListener('input', () => {
				// Digits only; anything else typed is a separator, handled on
				// keydown, or junk.
				const clean = b.value.replace(/\D/g, '').slice(0, 3);
				if (clean !== b.value) b.value = clean;
				sync();
				if (next(b.value) && i < 3 && b.selectionStart === b.value.length) go(i + 1, 'all');
			});
			b.addEventListener('keydown', (e) => {
				if (e.ctrlKey || e.metaKey || e.altKey) return;
				const at = b.selectionStart, to = b.selectionEnd;
				// An IPv6 address being typed, where text is allowed: a colon
				// or a hex letter is no part of IPv4, so the field turns back
				// into text with what was typed in it. Digits typed so far are
				// the start of that address, run together as typed (the boxes
				// moved on after three); a whole IPv4 address already there is
				// kept as it was written, to be edited as text.
				if (o.textOk && !b.readOnly && /^[:a-fA-F]$/.test(e.key)) {
					e.preventDefault();
					const p = parts();
					const whole = p.every((x) => x !== '') && problem(p) === '';
					toText((whole ? join(p) : p.join('')) + e.key);
					return;
				}
				if (e.key === '.' || e.key === ' ' || e.key === ',') {
					e.preventDefault();
					if (b.value !== '' && i < 3) go(i + 1, 'all');
				} else if (e.key === 'Backspace' && at === 0 && to === 0 && i > 0) {
					e.preventDefault();
					go(i - 1, 'end');
				} else if (e.key === 'ArrowLeft' && at === 0 && to === 0 && i > 0) {
					e.preventDefault();
					go(i - 1, 'end');
				} else if (e.key === 'ArrowRight' && at === b.value.length && i < 3) {
					e.preventDefault();
					go(i + 1, 'start');
				}
			});
			b.addEventListener('paste', (e) => {
				const t = ((e.clipboardData || window.clipboardData).getData('text') || '').trim();
				const whole = split(t);
				if (whole && t !== '') {
					e.preventDefault();
					if (b.readOnly) return;
					boxes.forEach((x, k) => { x.value = whole[k]; });
					sync();
					go(3, 'end');
				} else if (o.textOk && t.indexOf(':') >= 0) {
					e.preventDefault();
					if (!b.readOnly) toText(t);
				}
				// Anything else is pasted as typing, and input cleans it.
			});
			// After the focus has landed, so that moving between the boxes
			// is not leaving them.
			b.addEventListener('focusout', () => setTimeout(sync, 0));
		});

		// Read-only follows the field it stands for: the page sets it there
		// (Automatic), and the boxes are what is on screen.
		const follow = () => {
			boxes.forEach((b) => { b.readOnly = input.readOnly; });
			sync();
		};
		new MutationObserver(follow).observe(input, { attributes: true, attributeFilter: ['readonly'] });
		follow();
		return { boxes: boxes, sync: sync };
	}

	return { split: split, join: join, problem: problem, next: next, mount: mount };
});
