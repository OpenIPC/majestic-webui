// Where the overlay sits: the arithmetic behind the Overlay leaf's placement.
//
// It is a module of its own, and tested, because it is the subject of #340 and
// because every one of its failures is silent. An overlay placed wrongly still
// renders, still records, and still looks like an overlay — the camera burns it
// into the stream whatever the numbers say. Nothing reports "this is 2% from the
// wrong edge"; you find out when the second camera does not match the first.
//
// Three ideas, and the whole file is them:
//
//   1. AN OFFSET IS MEASURED FROM ITS ANCHOR, and grows away from it. On a
//      right-anchored overlay a bigger offset moves the text LEFT. Get that
//      backwards and typing a number does the opposite of what it says.
//
//   2. THE UNIT IS THE OPERATOR'S. majestic accepts three spellings — a bare
//      number is pixels of the frame being drawn, `2%` is a share of it, `1.5em`
//      is a multiple of the text size — and they are not interchangeable. A
//      share lands in the same visual place on Main and Sub where a pixel count
//      does not, which is why `%` is the default; but a camera set up in pixels
//      must keep its pixels, so a drag converts INTO whatever unit is already
//      written rather than overwriting the choice. That was the concrete
//      complaint in #340: the old placer always wrote a percentage.
//
//   3. A DRAG DOES NOT CHANGE THE ANCHOR. It moves within the anchor already
//      chosen, and the magnet pulls an offset to ZERO rather than to a corner.
//      The placer this replaces snapped to a named anchor and rewrote it under
//      the drag — which is defensible (a named edge survives a change of
//      resolution where a raw offset does not) and was still wrong, because the
//      person dragging had not asked for their coordinate system to change. The
//      anchor is chosen on the pad and nowhere else.
//
// Everything here is pure: numbers in, numbers out, no DOM. `pic` is the
// letterboxed picture rectangle in stage pixels, `box` the overlay's own
// rectangle in the same space, and `span` a dimension of the STREAM frame —
// which is what majestic resolves a pixel or em offset against, per channel.
(function () {
	'use strict';

	// The nine named anchors, as majestic orders them. -1 is the near edge
	// (left or top), 0 centred, 1 the far edge — the same two tables the
	// camera's own overlay placement indexes, so a name picked here means the
	// same thing there.
	const ANCHORS = [
		['top-left', -1, -1], ['top', 0, -1], ['top-right', 1, -1],
		['left', -1, 0], ['center', 0, 0], ['right', 1, 0],
		['bottom-left', -1, 1], ['bottom', 0, 1], ['bottom-right', 1, 1],
	];

	const SAY = {
		'-1,-1': 'Top left', '0,-1': 'Top', '1,-1': 'Top right',
		'-1,0': 'Left', '0,0': 'Centre', '1,0': 'Right',
		'-1,1': 'Bottom left', '0,1': 'Bottom', '1,1': 'Bottom right',
	};

	// The legacy mode, and still the camera's default. posX/posY run 16 at the
	// near edge to -16 at the far one.
	const PROPORTIONAL = 'proportional';
	const POS_MAX = 16;

	// Within this many pixels of an anchored edge, the offset is zero. It is the
	// same magnet the old placer had; what changed is what it snaps TO.
	const SNAP = 12;

	// A share of the frame, because it is the one spelling that means the same
	// thing on every channel. Used only where nothing is written yet — a value
	// already carrying a unit keeps it.
	const DEFAULT_UNIT = '%';

	const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

	function nameOf(sx, sy) {
		const hit = ANCHORS.find(a => a[1] === sx && a[2] === sy);
		return hit ? hit[0] : 'top-left';
	}

	function sidesOf(name) {
		const hit = ANCHORS.find(a => a[0] === name);
		return hit ? { x: hit[1], y: hit[2] } : null;
	}

	const isProportional = (name) => !sidesOf(name);

	function sayOf(name) {
		const s = sidesOf(name);
		return s ? SAY[s.x + ',' + s.y] : 'Proportional';
	}

	// Which spelling a stored offset is written in.
	//
	// Returns null where there is nothing to infer — an empty field, or a bare
	// zero, which is the same position in all three units and so carries no
	// choice. The caller resolves null to DEFAULT_UNIT. A bare NON-zero really
	// is pixels and is reported as such: that is a camera someone set up in
	// pixels, and it keeps them.
	function unitOf(spec) {
		const t = String(spec == null ? '' : spec).trim();
		if (/%\s*$/.test(t)) return '%';
		if (/em\s*$/i.test(t)) return 'em';
		const v = parseFloat(t);
		if (!isFinite(v)) return null;
		if (v === 0) return null;
		return 'px';
	}

	// A stored offset as a fraction of the frame. `span` is the frame dimension
	// the offset is measured along; `emPx` the text size in those same pixels.
	function toFrac(spec, span, emPx) {
		const t = String(spec == null ? '' : spec).trim();
		const v = parseFloat(t);
		if (!isFinite(v)) return 0;
		if (/%\s*$/.test(t)) return v / 100;
		if (/em\s*$/i.test(t)) return span ? (v * emPx) / span : 0;
		return span ? v / span : 0;
	}

	// The inverse, written back in the unit asked for.
	//
	// One decimal on % and em: enough that a 1920-wide frame is addressable to
	// the pixel, few enough that a drag does not write a different number every
	// time the pointer jitters. Pixels are integers because a fractional pixel
	// is not a thing the camera can draw.
	function fromFrac(frac, unit, span, emPx) {
		const f = isFinite(frac) ? frac : 0;
		if (unit === 'px') return String(Math.round(f * span)) ;
		if (unit === 'em') return (emPx ? Math.round(f * span / emPx * 10) / 10 : 0) + 'em';
		return (Math.round(f * 1000) / 10) + '%';
	}

	// Convert a stored offset from one spelling to another WITHOUT moving it.
	// Changing the unit is a question about how the number is written down, and
	// it must never be answered by shifting the overlay.
	function convert(spec, unit, span, emPx) {
		return fromFrac(toFrac(spec, span, emPx), unit, span, emPx);
	}

	// ── anchored placement ────────────────────────────────────────────────

	// Where an anchored overlay's top-left corner lands, in stage pixels.
	function anchoredSpot(pic, box, sides, fx, fy) {
		const ax = sides.x < 0 ? fx * pic.w
			: sides.x > 0 ? pic.w - box.w - fx * pic.w
			: (pic.w - box.w) / 2;
		const ay = sides.y < 0 ? fy * pic.h
			: sides.y > 0 ? pic.h - box.h - fy * pic.h
			: (pic.h - box.h) / 2;
		return { x: pic.x + ax, y: pic.y + ay };
	}

	// A drag, resolved against an anchor that does not change.
	//
	// Returns fractions of the picture. A centred axis returns zero: the camera
	// centres it outright and never reads the offset, so writing one would put a
	// number in the form that nothing acts on.
	function dragWithin(pic, box, sides, at) {
		const one = (side, lo, hi, size, span) => {
			if (side === 0) return 0;
			const d = side < 0 ? at[lo] - pic[lo] : (pic[lo] + span) - (at[lo] + size);
			const floored = Math.max(0, d);
			return (floored <= SNAP ? 0 : floored) / span;
		};
		return {
			fx: one(sides.x, 'x', 'w', box.w, pic.w),
			fy: one(sides.y, 'y', 'h', box.h, pic.h),
		};
	}

	// ── proportional placement ────────────────────────────────────────────

	// posX/posY → the top-left corner, in stage pixels.
	function proportionalSpot(pic, box, posX, posY) {
		const one = (v, span, size) => {
			const t = (POS_MAX - clamp(+v || 0, -POS_MAX, POS_MAX)) / (POS_MAX * 2);
			return t * Math.max(0, span - size);
		};
		return {
			x: pic.x + one(posX, pic.w, box.w),
			y: pic.y + one(posY, pic.h, box.h),
		};
	}

	// And back: a drag in proportional mode writes posX/posY, never an anchor.
	function dragProportional(pic, box, at) {
		const one = (v, o, span, size) => {
			const room = Math.max(0, span - size);
			const t = room ? (v - o) / room : 0;
			return Math.round(clamp(POS_MAX - t * (POS_MAX * 2), -POS_MAX, POS_MAX));
		};
		return {
			posX: one(at.x, pic.x, pic.w, box.w),
			posY: one(at.y, pic.y, pic.h, box.h),
		};
	}

	// One step of an arrow key. Which arrow ADDS depends on which edge the
	// overlay is anchored to, because an offset grows away from its anchor.
	function nudge(sides, axis, dir) {
		const side = axis === 'x' ? sides.x : sides.y;
		if (side === 0) return 0;
		const towardsFar = axis === 'x' ? dir > 0 : dir > 0;
		return (towardsFar === (side < 0)) ? 1 : -1;
	}

	const api = {
		ANCHORS, SAY, SNAP, PROPORTIONAL, POS_MAX, DEFAULT_UNIT,
		nameOf, sidesOf, sayOf, isProportional,
		unitOf, toFrac, fromFrac, convert,
		anchoredSpot, dragWithin,
		proportionalSpot, dragProportional,
		nudge,
	};
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticPlace = api;
})();
