// Web-UI settings: live theme preview (Auto follows the OS color scheme).
(function () {
	function resolve(t) {
		return t === 'auto'
			? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
			: t;
	}
	$$('#theme-choice input[name="webui_theme"]').forEach(el => {
		el.addEventListener('change', () => {
			if (el.checked) document.documentElement.setAttribute('data-bs-theme', resolve(el.value));
		});
	});
})();
