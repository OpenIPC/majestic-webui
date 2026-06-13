// Ntfy extension page: send a test notification
// (via ?send=test, which runs /usr/bin/ntfy.sh against the saved config).
// `$` is a global from main.js.
(function () {
	const btn = $('#ntfy-test');
	const out = $('#ntfy-status');
	if (!btn) return;

	btn.addEventListener('click', () => {
		btn.disabled = true;
		out.className = 'small ms-2 text-secondary';
		out.textContent = 'Sending…';
		fetch('?send=test')
			.then(r => r.text())
			.then(d => {
				const ok = d.trim() === 'OK';
				out.className = 'small ms-2 ' + (ok ? 'text-success' : 'text-danger');
				out.textContent = ok ? 'Test notification sent.' : 'Failed to send — check the settings.';
			})
			.catch(() => { out.className = 'small ms-2 text-danger'; out.textContent = 'Request error.'; })
			.finally(() => { btn.disabled = false; });
	});
})();
