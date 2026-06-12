function $(n) {
	return document.querySelector(n)
}

function $$(n) {
	return document.querySelectorAll(n)
}

function refresh() {
	window.location.reload()
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

let _mjCfg;
function mjConfig() {
	if (!_mjCfg)
		_mjCfg = fetch('/api/v1/config.json', { credentials: 'same-origin' })
			.then(r => r.ok ? r.json() : {}).catch(() => ({}));
	return _mjCfg;
}

function mjGet(cfg, dot) {
	return dot.split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg);
}

function mjHeifGate(sel) {
	mjConfig().then(cfg => {
		if (mjGet(cfg, 'video0.codec') !== 'h265') {
			const el = $(sel);
			if (el) { el.checked = false; el.disabled = true; }
		}
	});
}

function setProgressBar(id, value, name) {
	$(id).setAttribute('aria-valuenow', value);
	$(id).title = name + ': ' + value + '%'
	const pb = $(id + ' .progress-bar');
	pb.style.width = value + '%';
	pb.classList = 'progress-bar';
	if (value > 95) {
		pb.classList.add('bg-danger');
	} else if (value > 90) {
		pb.classList.add('bg-warning');
	} else {
		pb.classList.add('bg-success');
	}
}

async function* makeTextFileLineIterator(url) {
	const td = new TextDecoder('utf-8');
	const response = await fetch(url);
	const rd = response.body.getReader();
	let { value: chunk, done: readerDone } = await rd.read();
	chunk = chunk ? td.decode(chunk) : '';
	const re = /\r?\n/gm;
	let startIndex = 0;
	let result;

	for (;;) {
		result = re.exec(chunk);
		if (!result) {
			if (readerDone) {
				break;
			}

			let remainder = chunk.substr(startIndex);
			({ value: chunk, done: readerDone } = await rd.read());
			chunk = remainder + (chunk ? td.decode(chunk) : '');
			startIndex = re.lastIndex = 0;
			continue;
		}

		yield chunk.substring(startIndex, result.index);
		startIndex = re.lastIndex;
	}

	if (startIndex < chunk.length) {
		yield chunk.substr(startIndex);
	}

	if (el.dataset['reboot'] === "true") {
		location.href = '/cgi-bin/fw-restart.cgi'
	}

	if ($('form input[type=submit]')) {
		$('form input[type=submit]').disabled = false;
	}
}

async function runCmd(msg) {
	for await (let line of makeTextFileLineIterator('/cgi-bin/j/run.cgi?' + msg + '=' + btoa(el.dataset['cmd']))) {
		const regex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
		line = line.replace(regex, '');
		el.innerHTML += line + '\n';
	}
}

function heartbeat() {
	fetch('/cgi-bin/j/pulse.cgi')
		.then((response) => response.json())
		.then((json) => {
			if (json.soc_temp !== '') {
				const st = $('#soc-temp')
				st.textContent = json.soc_temp;
				st.classList.add(['text-primary','bg-white','rounded','small']);
				st.title = 'SoC temperature ' + json.soc_temp;
			}

			if (json.time_now !== '') {
				const d = new Date(json.time_now * 1000);
				$('#time-now').textContent = d.toLocaleString() + ' ' + json.timezone;
			}

			if (json.mem_used !== '') {
				setProgressBar('#pb-memory', json.mem_used, 'Memory Usage');
			}

			if (json.overlay_used !== '') {
				setProgressBar('#pb-overlay', json.overlay_used, 'Overlay Usage');
			}

			if (json.daynight_value !== '-1') {
				$('#daynight_value').textContent = '🌟 ' + json.daynight_value;
			}

			if (typeof(json.uptime) !== 'undefined' && json.uptime !== '') {
				$('#uptime').textContent = 'Uptime:️ ' + json.uptime;
			}
		})
		.then(setTimeout(heartbeat, 2000));
}

function initAll() {
	$$('form').forEach(el => el.autocomplete = 'off');

	// For .warning and .danger buttons, ask confirmation on action.
	$$('.btn-danger, .btn-warning, .confirm').forEach(el => {
		// for input, find its parent form and attach listener to it submit event
		if (el.nodeName === "INPUT") {
			while (el.nodeName !== "FORM") el = el.parentNode
			el.addEventListener('submit', ev => (!confirm("Are you sure?")) ? ev.preventDefault() : null)
		} else {
			el.addEventListener('click', ev => (!confirm("Are you sure?")) ? ev.preventDefault() : null)
		}
	});

	$$('.refresh').forEach(el => el.addEventListener('click', refresh));

	// open links to external resources in a new window.
	$$('a[href^=http]').forEach(el => el.target = '_blank');

	// add auto toggle button and value display for range elements.
	$$('input[type=range]').forEach(el => {
		el.addEventListener('input', ev => {
			const id = ev.target.id.replace(/-range/, '');
			$('#' + id + '-show').textContent = ev.target.value;
			$('#' + id).value = ev.target.value;
		})
	});

	// show password when "show" checkbox is checked
	$$(".password input[type=checkbox]").forEach(el => {
		el.addEventListener('change', ev => {
			const pw = $('#' + ev.target.dataset['for']);
			pw.type = (el.checked) ? 'text' : 'password';
			pw.focus();
		});
	});

	// click-to-copy for .cp2cb snippets (HTTPS uses the clipboard API, plain
	// http falls back to a hidden textarea + execCommand)
	$$('.cp2cb').forEach(el => {
		el.title = 'Click to copy';
		el.addEventListener('click', () => {
			const text = el.textContent.trim();
			const flash = () => { el.title = 'Copied!'; setTimeout(() => el.title = 'Click to copy', 1000); };
			if (navigator.clipboard && window.isSecureContext) {
				navigator.clipboard.writeText(text).then(flash).catch(() => {});
			} else {
				const ta = document.createElement('textarea');
				ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
				document.body.appendChild(ta); ta.focus(); ta.select();
				try { document.execCommand('copy'); flash(); } catch (e) {}
				document.body.removeChild(ta);
			}
		});
	});

	heartbeat();
}

window.addEventListener('load', initAll);
