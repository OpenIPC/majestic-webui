// Network settings: address-mode presentation + Wi-Fi scan.
//
// Which interface the page is about is a tab the server renders, so wlan0's
// fields exist only on wlan0's tab -- they used to be hidden markup on every
// tab, toggled by a select that also decided which file a save landed in
// (#458).
//
// Nothing here is load-bearing. Without script the address fields are plain
// editable inputs holding the lease, the radios still post, and the save is
// unaffected; the script only marks the Automatic ones as the reading they
// are, so that a field you cannot change does not look like one you can.
(function () {
	const auto = $('#network_dhcp_auto'), manual = $('#network_dhcp_manual');

	function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

	// Automatic is not "these fields are gone" -- it is "these are what the
	// router gave you". They stay on screen and stay readable; readonly rather
	// than disabled, because a disabled input is dropped from the submission
	// and skipped by the keyboard, and neither is true of a value the page is
	// showing you on purpose.
	function toggleStatic() {
		const on = auto && auto.checked;
		const grid = $('.mj-ip-grid');
		if (grid) grid.classList.toggle('is-auto', on);
		['network_address', 'network_netmask', 'network_gateway', 'network_nameserver'].forEach(id => {
			const inp = $('#' + id);
			if (inp) inp.readOnly = on;
		});
		const note = $('#ip-auto-note');
		if (note) note.hidden = !on;
	}

	function scan() {
		const btn = $('#wifi-scan'), st = $('#wifi-scan-status'), sel = $('#wifi-results');
		btn.disabled = true; st.textContent = 'scanning…'; sel.classList.add('d-none'); sel.innerHTML = '';
		apiFetch('/cgi-bin/j/network.cgi?scan=1', { credentials: 'same-origin' })
			.then(r => r.json()).then(d => {
				btn.disabled = false;
				const nets = (d.networks || []).sort((a, b) => b.signal - a.signal);
				if (!nets.length) { st.textContent = d.error || 'no networks found'; return; }
				st.textContent = nets.length + ' found';
				sel.innerHTML = '<option value="">— pick a network —</option>' + nets.map(n =>
					'<option value="' + esc(n.ssid) + '">' + esc(n.ssid) + '  ·  ' + (n.signal | 0) + ' dBm  ·  ' + esc(n.security) + '</option>').join('');
				sel.classList.remove('d-none');
			}).catch(() => { btn.disabled = false; st.textContent = 'scan failed'; });
	}

	// A locally-administered unicast address: bit 1 of the first octet set,
	// bit 0 clear. It used to live in the placeholder-MAC banner's own include,
	// alongside a second copy of this card's form; the banner links here now and
	// carries no control of its own, so the include went with it.
	function generateMac(ev) {
		ev.preventDefault();
		const el = $('#mac_address');
		if (!el) return;
		// defaultValue is what the page loaded with, so this asks only when
		// there is something typed to lose. The old guard compared against the
		// empty string, which was right in a banner whose field started empty
		// and would have refused every time on this card, where the field is
		// pre-filled with the address the camera is using.
		if (el.value !== '' && el.value !== el.defaultValue &&
			!confirm('Replace the address you have typed with a random one?')) return;
		let mac = '';
		for (let i = 1; i <= 6; i++) {
			let b = (Math.random() * 255) >>> 0;
			if (i === 1) { b = b | 2; b = b & ~1; }
			mac += b.toString(16).toUpperCase().padStart(2, '0') + (i < 6 ? ':' : '');
		}
		el.value = mac;
	}

	const genMac = $('#generate-mac-address');
	if (genMac) genMac.addEventListener('click', generateMac);

	if (auto) auto.addEventListener('change', toggleStatic);
	if (manual) manual.addEventListener('change', toggleStatic);
	const scanBtn = $('#wifi-scan');
	if (scanBtn) scanBtn.addEventListener('click', scan);
	const sel = $('#wifi-results');
	if (sel) sel.addEventListener('change', () => { const i = $('#network_wlan_ssid'); if (sel.value && i) i.value = sel.value; });

	toggleStatic();
})();
