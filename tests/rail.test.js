// Where the settings rail puts the section you picked (www/a/mj-rail.js).
//
// From md up the settings tree is taller than the window — six categories and
// twenty-three sections are 1083px of it against a 900px screen on an
// hi3516av300 — so the list scrolls inside a pane of its own and two pieces of
// arithmetic decide what you end up looking at.
//
// Both fail silently. A list scrolled to the wrong offset is still a list, a
// page moved when it should have held still is still a page, and nothing throws
// or logs either way: the only symptom is that the section asked for is not in
// front of the reader, which is exactly the report this was written from. And
// neither can be reproduced without a camera carrying enough sections to
// overflow a short window, which is the one thing a fixture can hold still.
//
// The boundaries are where both go wrong, so they are what is pinned here: an
// item flush against an edge is INSIDE, an item taller than the pane shows its
// beginning, a pane with nothing to scroll is left alone, and a column whose top
// edge is exactly at the top of the window is already in front of you.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const RAIL = require(path.join(__dirname, '..', 'www', 'a', 'mj-rail.js'));

// The rail as measured at 1280x900: a pane from y=161 to y=900 holding 1006px
// of list, so 267px of travel.
const PANE = { top: 161, bottom: 900 };
const MAX = 267;
// A row is 37px tall.
const row = (top) => ({ top: top, bottom: top + 37 });

group('a row already in front of the reader is left alone');
check('comfortably inside', RAIL.scrollTopFor(PANE, row(400), 120, MAX) === 120);
check('flush against the top edge is inside', RAIL.scrollTopFor(PANE, row(161), 120, MAX) === 120);
check('flush against the bottom edge is inside', RAIL.scrollTopFor(PANE, row(863), 120, MAX) === 120);

group('a row outside the pane is brought in by exactly the gap');
// Above: the row starts 40px over the pane's top edge, so the pane goes back 40.
check('above the pane', RAIL.scrollTopFor(PANE, row(121), 120, MAX) === 80);
// Below: the row ends 30px past the bottom edge, so the pane goes on 30.
check('below the pane', RAIL.scrollTopFor(PANE, row(893), 120, MAX) === 150);
// Nothing more than the gap: an item brought in must not also be centred, or
// every pick would shuffle the whole list under the pointer.
check('and by no more than the gap', RAIL.scrollTopFor(PANE, row(893), 120, MAX) - 120 === 30);

group('a row taller than the pane shows its beginning');
// A category and its sections on a very short window. Aligning the end of it
// would put the reader at the bottom of something they have not seen the top of.
const tall = { top: 100, bottom: 1200 };
check('the top is what lands in the pane', RAIL.scrollTopFor(PANE, tall, 120, MAX) === 59);

group('a pane with nothing to scroll keeps the offset it has');
// This is what stops it touching the rail below md, where the tree is the
// page's own navigation and scrolls with the page rather than inside a box.
check('max of 0', RAIL.scrollTopFor(PANE, row(1400), 0, 0) === 0);
check('a negative max', RAIL.scrollTopFor(PANE, row(1400), 0, -18) === 0);

group('the answer stays inside the pane it is for');
// The browser would clamp these anyway; returning one it has to correct makes
// the function a thing you cannot reason about from its own output.
check('never past the end', RAIL.scrollTopFor(PANE, row(2000), 260, MAX) === MAX);
check('never before the start', RAIL.scrollTopFor(PANE, row(-500), 10, MAX) === 0);

group('whether a pick has to move the page');
// Below md with the tree open, the rail is stacked ABOVE the form, so a tap
// always leaves the reader looking at navigation with the fields below the
// fold (#199).
check('rail open above the form, always', RAIL.revealsForm(false, 110) === true);
check('rail open above the form, even with the column at the top', RAIL.revealsForm(false, 0) === true);
// From md up the rail is beside the form, and below md a pick folds it behind
// its button (#587): either way it is out of the form's way, so the page is
// corrected only when the column's top edge is off the top of the window —
// which is what a long section read to the bottom leaves behind. Scrolling a
// column already in view would only push the fold's button off the screen.
check('rail out of the way, when the column is above the window', RAIL.revealsForm(true, -282) === true);
check('rail out of the way, not when it is already at the top', RAIL.revealsForm(true, 0) === false);
check('rail out of the way, not when it is in view', RAIL.revealsForm(true, 271) === false);

done();
