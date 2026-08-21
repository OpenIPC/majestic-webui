// Camera switcher: a navbar dropdown, present on every authenticated page, that
// lists the other OpenIPC cameras on this link and jumps to any of them in one
// click. The feature it surfaces already exists — browsing openipc.local shows
// the same list — but nobody administering a camera by its IP would ever know
// that, so this makes the fleet reachable from wherever they already are.
//
// Fed by GET /api/v1/peers, the same roster the openipc.local selector uses. It
// is subnet-gated (404 off-link) and absent on older majestic (404), and either
// way the switcher simply stays hidden: no new disclosure, no hard dependency.
//
// The href helpers below are copied verbatim from www/cameras.html. That page is
// served before authentication and so cannot pull /a/*.js, which is why the two
// cannot share a file. The peer roster is untrusted network input in both, so
// the validation MUST stay identical — change one, change the other.
(function () {
	'use strict';

	// How often to re-read the roster. Discovery sweeps server-side every 30s and
	// the list changes slowly, so this is deliberately lazy — nothing hangs off
	// main.js's 2s heartbeat.
	var REFRESH_MS = 60000;

	// --- validated hrefs (keep in step with www/cameras.html) -----------------

	function isIPv4(s) {
		var p = s.split('.');
		return p.length === 4 && p.every(function (o) {
			// No leading zeros: "010" is octal to some URL parsers, so a value
			// that looks like the shown address could resolve to a different host.
			return /^(0|[1-9]\d{0,2})$/.test(o) && +o <= 255;
		});
	}

	function ipv6Host(s) {
		if (s.indexOf(':') === -1) return null;
		try {
			var h = new URL('http://[' + s + ']/').hostname;
			return h.charAt(0) === '[' ? h : null;
		} catch (e) { return null; }
	}

	function addressHref(address) {
		if (typeof address !== 'string' || !address) return null;
		if (isIPv4(address)) return 'http://' + address + '/';
		var v6 = ipv6Host(address);
		return v6 ? 'http://' + v6 + '/' : null;
	}

	// A published url is honoured only when its host is a literal address equal to
	// the one the entry shows and it carries no userinfo, so a hostile
	// announcement cannot display one camera and send the click to another.
	function cameraHref(cam) {
		var shown = addressHref(cam.address);
		if (cam.url && /^https?:\/\//i.test(cam.url)) {
			try {
				var u = new URL(cam.url);
				var host = u.hostname.replace(/^\[|\]$/g, '');
				var canon = isIPv4(host) ? host : ipv6Host(host);
				if (!u.username && !u.password && canon
						&& addressHref(host) === shown) {
					return cam.url;
				}
			} catch (e) { /* unparseable: fall through to the address */ }
		}
		return shown;
	}

	// --- the switcher ---------------------------------------------------------

	function hide(box) {
		if (box) box.classList.add('d-none');
	}

	function build(box, cameras) {
		if (!Array.isArray(cameras)) { hide(box); return; }

		var self = null;
		var others = [];
		cameras.forEach(function (cam) {
			if (!cam || typeof cam !== 'object') return;
			if (cam.self) { if (!self) self = cam; return; }
			var href = cameraHref(cam);
			if (href) others.push({ cam: cam, href: href });
		});

		// Nothing to switch to: leave the control hidden, so a lone camera or an
		// off-link admin sees nothing new, and its presence means "others exist".
		if (!others.length) { hide(box); return; }

		var name = box.querySelector('#cam-switch-name');
		if (name) name.textContent = (self && self.name) || 'This camera';

		var count = box.querySelector('#cam-switch-count');
		if (count) count.textContent = '+' + others.length;

		var menu = box.querySelector('#cam-switch-menu');
		menu.replaceChildren();

		others.forEach(function (entry) {
			var a = document.createElement('a');
			a.className = 'dropdown-item d-flex align-items-center gap-2';
			a.href = entry.href;
			// Open peers in a new tab, matching how the rest of the UI treats
			// external http links. main.js sets target=_blank on the anchors
			// present at load, but the switcher builds these later (async, and
			// again on every refresh), so set it here rather than rely on that
			// one-time pass. rel=noopener severs window.opener so the peer page
			// cannot reach back and navigate this admin tab (tabnabbing).
			a.target = '_blank';
			a.rel = 'noopener noreferrer';

			var label = document.createElement('span');
			label.textContent = entry.cam.name || entry.cam.address;
			a.appendChild(label);

			var addr = document.createElement('span');
			addr.className = 'ms-auto small text-secondary';
			addr.textContent = entry.cam.address;
			a.appendChild(addr);

			var li = document.createElement('li');
			li.appendChild(a);
			menu.appendChild(li);
		});

		var sep = document.createElement('li');
		sep.innerHTML = '<hr class="dropdown-divider">';
		menu.appendChild(sep);

		var allLi = document.createElement('li');
		var all = document.createElement('a');
		all.className = 'dropdown-item';
		all.href = '/cameras.html';
		all.textContent = 'See all cameras…';
		allLi.appendChild(all);
		menu.appendChild(allLi);

		box.classList.remove('d-none');
	}

	// The interval, so a definitive 404 can stop it (see refresh()).
	var timer = null;

	function stop() {
		if (timer) { clearInterval(timer); timer = null; }
	}

	function refresh() {
		var box = document.getElementById('cam-switch');
		if (!box) return;

		// Plain fetch, not apiFetch, and without credentials — matching
		// www/cameras.html. The roster needs no session (the camera answers on
		// the caller's address, and the endpoint is subnet-gated, not
		// auth-gated), and on the shared openipc.local origin a cookie could
		// otherwise be handed to whichever camera replies next. apiFetch's only
		// extra — a redirect to login on 401 — is wrong here anyway: this runs
		// unprompted in the background, not on a user action.
		//
		// Bounded so a stalled reply self-terminates well before the next tick
		// rather than piling up behind the timer. 200 on-link, 404 off it or on
		// a majestic without the endpoint; anything else hides the switcher.
		var ctl = new AbortController();
		var giveUp = setTimeout(function () { ctl.abort(); }, 5000);

		fetch('/api/v1/peers', {
			credentials: 'omit',
			signal: ctl.signal,
			headers: { 'Accept': 'application/json' }
		})
			.then(function (r) {
				// A 404 is definitive: either this majestic has no peers
				// endpoint (older build) or we are off its subnet. Neither
				// changes while the page is open, so stop the timer rather than
				// 404 every minute for the life of the tab.
				if (r.status === 404) { stop(); return null; }
				return r.ok ? r.json() : null;
			})
			.then(function (data) { build(box, data && data.cameras); })
			.catch(function () { hide(box); })
			.finally(function () { clearTimeout(giveUp); });
	}

	function start() {
		refresh();
		timer = setInterval(refresh, REFRESH_MS);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start);
	} else {
		start();
	}
}());
