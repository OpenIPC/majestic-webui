// PurgeCSS config for the shipped www/a/bootstrap.min.css.
//
// Full Bootstrap 5.3 CSS is ~227 KB; the webui uses only a fraction of it. We ship
// the purged subset so the rootfs fits the smallest-flash boards (e.g. a 5120 KB
// rootfs partition, where the full file alone is the difference between fit and
// overflow). Regenerate with tools/regen-bootstrap-css.sh whenever you add Bootstrap
// classes to a page or bump the Bootstrap version — CI diffs a fresh regeneration
// against the committed file, so a stale bootstrap.min.css fails the PR rather than
// shipping classes that silently do nothing (ms-auto and col-md-8 both did, for
// months).
//
// content scans every page (.cgi/.html) and our JS. There is no vendor JS any more —
// the Bootstrap bundle is gone — so everything the scanner sees is markup or code
// this tree owns, and the safelist below only needs to cover class names built by
// string concatenation that the scanner cannot see literally.
module.exports = {
	content: [
		'www/**/*.cgi',
		'www/**/*.html',
		'www/a/*.js',
	],
	// Bootstrap leans on CSS custom properties, keyframes and @font-face — never strip these.
	variables: false,
	keyframes: false,
	fontFace: false,
	safelist: {
		// `'alert alert-' + result` (fw-reset.js / fw-update.js) — never appears as a literal token.
		standard: [
			'alert-success', 'alert-danger', 'alert-warning', 'alert-info',
			'alert-primary', 'alert-secondary', 'alert-light', 'alert-dark',
		],
		// Only what is genuinely built by concatenation. Every state class our
		// JS toggles (show, active, disabled…) appears as a literal string in
		// that JS, so the content scan keeps it; the old greedy entries for
		// modal/offcanvas/dropdown/tooltip/popover/carousel/collaps… covered
		// the Bootstrap JS bundle this tree no longer ships, and each of them
		// also dragged whole unused components back in (a greedy match keeps
		// every selector the class appears in — /(^|-)show$/ alone preserved
		// the offcanvas and modal-backdrop machinery).
		greedy: [
			/text-bg-/,        // 'text-bg-' + tone (status.js badge())
		],
	},
};
