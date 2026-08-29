// FPV WFB settings page: wire the TX-power range slider to its hidden field +
// value display. The help badges carry title attributes, so the browser's own
// tooltip covers them — no widget needed.
(function () {
	function init() {
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
