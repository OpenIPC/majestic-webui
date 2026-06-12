// Network settings: DHCP/interface field toggles + Wi-Fi scan.
(function () {
	const iface = $('#network_interface'), dhcp = $('#network_dhcp');

	function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

	function toggleStatic() {
		const on = dhcp && dhcp.checked;
		['network_address', 'network_netmask', 'network_gateway', 'network_nameserver'].forEach(id => {
			const inp = $('#' + id), wrap = $('#' + id + '_wrap');
			if (inp) inp.disabled = on;
			if (wrap) wrap.classList.toggle('d-none', on);
		});
	}

	function toggleInterface() {
		const sec = $('#wifi-section');
		if (sec) sec.classList.toggle('d-none', !(iface && iface.value === 'wlan0'));
	}

	function scan() {
		const btn = $('#wifi-scan'), st = $('#wifi-scan-status'), sel = $('#wifi-results');
		btn.disabled = true; st.textContent = 'scanning…'; sel.classList.add('d-none'); sel.innerHTML = '';
		fetch('/cgi-bin/j/network.cgi?scan=1', { credentials: 'same-origin' })
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

	if (iface) iface.addEventListener('change', toggleInterface);
	if (dhcp) dhcp.addEventListener('change', toggleStatic);
	const scanBtn = $('#wifi-scan');
	if (scanBtn) scanBtn.addEventListener('click', scan);
	const sel = $('#wifi-results');
	if (sel) sel.addEventListener('change', () => { const i = $('#network_wlan_ssid'); if (sel.value && i) i.value = sel.value; });

	toggleInterface();
	toggleStatic();
})();
