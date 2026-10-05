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

	// The Cellular modem card: every row the modem itself answers comes from
	// majestic's modem_* gauges and modem_info labels on the shared heartbeat,
	// graded and worded by main.js (mjLteGrade, mjLteState) exactly as the
	// Dashboard does. A row the modem has not answered keeps its dash rather
	// than turning into a zero. The IMEI and the SIM's ICCID are not in
	// /metrics, which answers without a login: they come from
	// /api/v1/modem, which does not.
	const cellSet = (id, text, cls) => {
		const el = $('#' + id);
		if (!el) return;
		// The markup's own classes (text-break on the long ones) stay; only
		// the state colour is swapped.
		if (el.dataset.base === undefined) el.dataset.base = el.className;
		el.textContent = text == null || text === '' ? '–' : text;
		el.className = (el.dataset.base + ' ' + (cls || '')).trim();
	};
	const cellState = (text, cls) => {
		const el = $('#cell-state');
		if (!el) return;
		el.textContent = text;
		el.className = 'x-small mb-2 ' + cls;
	};
	let cellIdAt = 0, cellIdDone = false;
	function cellIdentity() {
		// Asked again until both are known: a modem read for the first time,
		// or one without a SIM yet, answers with nulls.
		if (cellIdDone || Date.now() - cellIdAt < 30000) return;
		cellIdAt = Date.now();
		apiFetch('/api/v1/modem', { credentials: 'same-origin' })
			.then(r => r.ok ? r.json() : null)
			.then(d => {
				if (!d) return;
				cellSet('cell-imei', d.imei);
				cellSet('cell-iccid', d.iccid);
				cellIdDone = !!(d.imei && d.iccid);
			})
			.catch(() => {});
	}
	function cellular(s) {
		// A failed poll proves nothing about the modem, but the rows below
		// are no longer current either, and a green "data on usb0" left
		// standing would say they were. Two failures, as the banner waits.
		if (!s.ok) {
			if (s.fails >= 2)
				cellState('The camera is not answering — the readings below are the last ones received',
					'text-warning');
			return;
		}
		const v = s.m.v, i = s.m.info.modem_info || {};
		const num = (k, unit) => (k in v) ? v[k] + unit : null;
		const st = mjLteState(v, i);
		// No modem gauges is what majestic says when it finds no modem it
		// knows on USB -- which is not the same as no modem.
		cellState(st ? st[0]
			: 'majestic reads no modem on USB: it is powered down, unplugged, or a model majestic does not read',
			st ? st[1] : 'text-secondary');
		if (st) cellIdentity();
		const g = mjLteGrade(v);
		cellSet('cell-rsrp', num('modem_rsrp_dbm', ' dBm') != null
			? v.modem_rsrp_dbm + ' dBm' + (g ? ' · ' + g[0] : '') : null, g ? g[1] : '');
		cellSet('cell-rsrq', num('modem_rsrq_db', ' dB'));
		cellSet('cell-sinr', num('modem_sinr_db', ' dB'));
		cellSet('cell-rssi', num('modem_rssi_dbm', ' dBm'));
		cellSet('cell-csq', ('modem_csq' in v) ? v.modem_csq + ' of 31' : null);
		cellSet('cell-op', i.operator
			? i.operator + (i.mcc ? ' (' + i.mcc + '/' + i.mnc + ')' : '') : null);
		cellSet('cell-cell', i.cell
			? i.cell + (i.tac ? ' · TAC ' + i.tac : '') +
				('modem_pci' in v ? ' · PCI ' + v.modem_pci : '') +
				(i.state ? ' · ' + ({ NOCONN: 'idle', CONNECT: 'transferring',
					SEARCH: 'searching', LIMSRV: 'limited service' }[i.state] ||
					i.state.toLowerCase()) : '')
			: null);
		cellSet('cell-band', ('modem_band' in v)
			? (i.rat || '') + ' band ' + v.modem_band +
				('modem_earfcn' in v ? ' · EARFCN ' + v.modem_earfcn : '')
			: (i.rat || null));
		cellSet('cell-bearer', ('modem_bearer_active' in v)
			? (v.modem_bearer_active ? 'active' + (i.bearer_ip ? ', ' + i.bearer_ip : '') : 'none')
			: null);
		cellSet('cell-netdev', ('modem_data_connected' in v)
			? (v.modem_data_connected ? 'connected' : 'not connected — usb0 carries nothing')
			: null, ('modem_data_connected' in v)
			? (v.modem_data_connected ? 'text-success' : 'text-danger') : '');
		cellSet('cell-model', i.model);
		cellSet('cell-rev', i.revision);
		cellSet('cell-sim', i.sim ? i.sim.toLowerCase() : null,
			i.sim && i.sim !== 'READY' ? 'text-danger' : '');
		const age = $('#cell-age');
		if (age) age.textContent = ('modem_reading_age_seconds' in v)
			? 'Read from the modem ' + Math.round(v.modem_reading_age_seconds) + ' s ago.' : '';
	}
	if ($('#cellular') && typeof mjMetricsSubscribe === 'function')
		mjMetricsSubscribe(cellular);

	toggleStatic();
})();
