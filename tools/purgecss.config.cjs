// PurgeCSS config for the shipped www/a/bootstrap.min.css.
//
// Full Bootstrap 5.3 CSS is ~227 KB; the webui uses only a fraction of it. We ship
// the purged subset so the rootfs fits the smallest-flash boards (e.g. a 5120 KB
// rootfs partition, where the full file alone is the difference between fit and
// overflow). Regenerate with tools/regen-bootstrap-css.sh whenever you add Bootstrap
// classes to a page or bump the Bootstrap version.
//
// content scans every page (.cgi/.html) AND all JS — including bootstrap.bundle.min.js,
// so the classes Bootstrap's own JS toggles at runtime (show/fade/collapsing/…)
// survive. The safelist below only needs to cover classes built by string
// concatenation that the scanner can't see literally.
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
		// `'alert alert-' + result` (fw-time.js / fw-update.js) — never appears as a literal token.
		standard: [
			'alert-success', 'alert-danger', 'alert-warning', 'alert-info',
			'alert-primary', 'alert-secondary', 'alert-light', 'alert-dark',
		],
		// Belt-and-suspenders for JS component state + concatenated utility families.
		greedy: [
			/(^|-)show$/, /fade/, /collaps/, /modal/, /offcanvas/, /dropdown/,
			/tooltip/, /popover/, /carousel/, /tab-pane/, /(^|-)active$/, /disabled/,
			/alert-/, /text-bg-/,
		],
	},
};
