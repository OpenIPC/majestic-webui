// Time Settings page: timezone autocomplete (over the bundled TZ table from
// timezone.js), NTP "Sync now" / offline "Set from browser", and a live device
// clock in the summary card. `$`/`$$` are the helpers from main.js.
(function () {
	function findTimezone(tz) {
		return tz.n === $('#tz_name').value;
	}
	function updateTimezone() {
		const m = TZ.filter(findTimezone);
		$('#tz_data').value = m.length ? m[0].v : '';
	}
	function useBrowserTimezone() {
		$('#tz_name').value = Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll('_', ' ');
		updateTimezone();
	}

	// Sync now / Set from browser — both report into #time-status.
	function call(url, btn) {
		const s = $('#time-status');
		btn.disabled = true;
		s.className = 'small text-secondary';
		s.textContent = 'working…';
		fetch(url)
			.then(r => r.json())
			.then(j => {
				s.className = 'small alert alert-' + j.result + ' py-1 px-2 mb-0';
				s.textContent = j.message;
			})
			.catch(() => {
				s.className = 'small alert alert-danger py-1 px-2 mb-0';
				s.textContent = 'Request failed.';
			})
			.finally(() => { btn.disabled = false; });
	}

	// Live device clock: grab the device epoch once, keep the offset to the
	// browser clock, then tick locally (no second 2s poller vs the header).
	let skew = 0, zone = '';
	function tick() {
		const el = $('#tz-now');
		if (el) el.textContent = new Date(Date.now() + skew).toLocaleString() + (zone ? ' ' + zone : '');
	}

	function init() {
		const tzn = $('#tz_name');
		if (tzn) {
			if (navigator.userAgent.includes('Android') && navigator.userAgent.includes('Firefox')) {
				const sel = document.createElement('select');
				sel.classList.add('form-select');
				sel.name = 'tz_name';
				sel.id = 'tz_name';
				sel.options.add(new Option());
				TZ.forEach(tz => {
					const opt = new Option(tz.n);
					opt.selected = (tz.n === tzn.value);
					sel.options.add(opt);
				});
				tzn.replaceWith(sel);
			} else {
				const el = $('#tz_list');
				el.innerHTML = '';
				TZ.forEach(tz => {
					const o = document.createElement('option');
					o.value = tz.n;
					el.appendChild(o);
				});
			}
			const field = $('#tz_name');
			field.addEventListener('focus', ev => ev.target.select());
			field.addEventListener('selectionchange', updateTimezone);
			field.addEventListener('change', updateTimezone);
			$('#frombrowser').addEventListener('click', useBrowserTimezone);
		}

		const sync = $('#sync-time');
		if (sync) sync.addEventListener('click', e => call('/cgi-bin/j/time.cgi', e.currentTarget));
		const set = $('#set-time');
		if (set) set.addEventListener('click', e => call('/cgi-bin/j/time.cgi?set=' + Math.floor(Date.now() / 1000), e.currentTarget));

		fetch('/cgi-bin/j/pulse.cgi')
			.then(r => r.json())
			.then(j => { skew = (Number(j.time_now) * 1000) - Date.now(); zone = j.timezone || ''; })
			.catch(() => {})
			.finally(() => { tick(); setInterval(tick, 1000); });
	}

	if (document.readyState !== 'loading') init();
	else document.addEventListener('DOMContentLoaded', init);
})();
