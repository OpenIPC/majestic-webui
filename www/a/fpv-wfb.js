// FPV WFB settings page: enable Bootstrap tooltips on the help badges and wire
// the TX-power range slider to its hidden field + value display.
(function () {
	function init() {
		document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(el => new bootstrap.Tooltip(el));

		const slider = document.getElementById('txpower-range');
		const show = document.getElementById('txpower-show');
		const hidden = document.getElementById('txpower');
		if (slider && show && hidden) {
			slider.addEventListener('input', function () {
				show.textContent = this.value;
				hidden.value = this.value;
			});
		}
	}
	if (document.readyState !== 'loading') init();
	else document.addEventListener('DOMContentLoaded', init);
})();
