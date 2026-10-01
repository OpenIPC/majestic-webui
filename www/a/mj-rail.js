// How much of the window the settings rail may take, where its list has to sit,
// and when a pick has to move the page.
//
// Three decisions, all arithmetic over rectangles. From md up the tree is taller
// than the pane it lives in: one decision sizes that pane to the window as the
// page scrolls, and the two made every time somebody picks a section scroll the
// pane and decide whether the page has to move at all.
//
// Its own file, and pure, for the reason mj-fps.js and mj-place.js are: both
// fail SILENTLY and in the same direction. A rail scrolled to the wrong place
// still renders a rail, a page moved when it should have stayed still is still a
// page, and the reader's only complaint is that the thing they asked for is not
// in front of them — which is the report this module was written from. Nothing
// throws, nothing logs, and reproducing either needs a camera with twenty-three
// sections and a window short enough to run out of room, which is the one thing
// a fixture can hold still. tests/rail.test.js is what can ask it.
(() => {
	'use strict';

	// The scroll offset `pane` must be at for `item` to be inside it.
	//
	// `pane` and `item` are rectangles in VIEWPORT coordinates (what
	// getBoundingClientRect returns) and `scrollTop` is the pane's current
	// offset, so the answer is the current offset plus however far the item is
	// outside the pane. That is the whole reason this is arithmetic rather than
	// scrollIntoView({ block: 'nearest' }): that walks every scrollable ancestor
	// and would move the page as well, and not moving the page is what the rail's
	// own scroller exists for.
	//
	// `max` is scrollHeight - clientHeight. A pane with nothing to scroll (max at
	// or below zero) keeps the offset it has, which is also what stops this
	// touching the rail below md, where the tree is the page's own navigation and
	// scrolls with it.
	//
	// An item already inside is left alone: a section that is in front of the
	// reader must not be jumped at, and every pick made with the pointer is one
	// of those.
	function scrollTopFor(pane, item, scrollTop, max) {
		const at = num(scrollTop);
		const ceiling = num(max);
		if (!pane || !item || ceiling <= 0) return at;

		let want = at;
		// Above first, so an item TALLER than the pane — a category and its
		// sections, on a very short window — lands showing its beginning rather
		// than its end.
		if (item.top < pane.top) want = at - (pane.top - item.top);
		else if (item.bottom > pane.bottom) want = at + (item.bottom - pane.bottom);

		return Math.max(0, Math.min(ceiling, want));
	}

	// Does picking a section have to move the PAGE to put the form in front of
	// the reader?
	//
	// Below md the rail is stacked above the form rather than beside it, so a tap
	// always leaves them looking at navigation with the fields they asked for
	// below the fold (#199), and the answer is always yes.
	//
	// From md up the rail is beside the form and scrolls inside itself, so
	// picking a section moves nothing and there is usually nothing to correct.
	// Usually: a long section is taller than the window, and reading one to the
	// bottom leaves the page scrolled past the form column's top edge. Pick a
	// short section from there and the document the scroll is clamped against has
	// just become much shorter, so the browser lands wherever it can — measured
	// on an hi3516av300 at 1280x900, 282px above the card it was asked for, with
	// an empty column on screen.
	//
	// So it is asked of the geometry rather than of the breakpoint: bring the
	// column back when its top edge is off the top of the window, and never when
	// it is already there.
	//
	// `clear` is whether the rail is out of the form's way: beside it from md up,
	// or folded behind its button below md (#587). Folded, the form starts one
	// button under the title, so the stacked-rail answer would only scroll that
	// button — the way back to the list — off the top of the screen.
	function revealsForm(clear, colTop) {
		return !clear || num(colTop) < 0;
	}

	// How much of the window the rail must leave free, so that the whole of it —
	// scrollport included — is on screen at the scroll offset the page is at NOW.
	//
	// `above` is how far the rail's column sits from the top of the DOCUMENT
	// (the navbar, and any banner over the row), `top` and `end` are that
	// column's top and bottom edges in the window, and `height` is the window's
	// height. All in px.
	//
	// The rail is sticky, so what it has to share the window with changes as the
	// page scrolls. At the top it sits under the navbar, and the strip the navbar
	// takes is the gap. Once it has stuck there is nothing above it, and the gap
	// is nothing. Leaving it at the scroll-0 answer — which the page did — left a
	// strip of the same height EMPTY under the stuck list, so the tree appeared
	// to stop at whatever row the window happened to cut at: on a MacBook Air,
	// with a 1470x830 window, at Record, with Image through Pins under the edge.
	// A sticky box cannot leave its column, so where the column ends above the
	// bottom of the window the strip below it is the gap too, or the rail would be
	// shoved up by it and take the title and the search box off the top of the
	// screen. The stylesheet takes everything out from under the column so that
	// strip is nothing at the end of the page as well: when it was 48px of margin
	// and padding, reaching the end shrank the list and hid its last visible row.
	//
	// Never more than `above`. That is the scroll-0 answer, and it is always
	// enough to keep the rail on screen. It is also what keeps this out of a
	// loop: the column is stretched to the taller of the rail and the form, so on
	// a short section its end moves with the rail, and an answer bounded by a
	// value the rail does not move cannot chase its own tail.
	function railGap(above, top, end, height) {
		const cap = Math.max(0, num(above));
		const gap = Math.max(0, num(top)) + Math.max(0, num(height) - num(end));
		return Math.round(Math.min(cap, gap));
	}

	function num(v) { return typeof v === 'number' && !isNaN(v) ? v : 0; }

	const api = { scrollTopFor, revealsForm, railGap };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticRail = api;
})();
