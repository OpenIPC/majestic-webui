#!/usr/bin/haserl
<%in p/common.cgi %>
<%
page_title="Console"
%>

<%in p/header.cgi %>
<!-- Two consoles share this page: the interactive xterm.js terminal over
     /ws/terminal, and a one-command-at-a-time runner over j/run.cgi. Which one
     you get depends only on whether the CDN answered — everything below is
     inert until the loader script at the bottom decides. -->
<p class="text-secondary" id="console-loading">Loading terminal&hellip;</p>

<div id="terminal" class="border rounded mb-3 d-none" style="height:72vh"></div>

<div id="console-fallback" class="d-none">
	<p class="text-secondary small">The interactive terminal loads from a CDN this camera cannot reach right now, so commands run one at a time, each with a 3-second timeout.</p>
	<form id="console-form" class="row g-2 mb-3">
		<div class="col-10">
			<input autocomplete="off" class="form-control" id="command" placeholder="Command" type="text">
		</div>
		<div class="col-auto">
			<input class="btn btn-secondary" type="submit" value="Run">
		</div>
	</form>
	<pre id="console-output"></pre>
</div>

<script>
(function () {
	'use strict';
	// xterm.js is ~300 KB and lives on jsDelivr rather than on the camera
	// because the smallest boards have no flash to spare for it. The price is
	// that the load can fail (no internet) or stall for minutes (a route that
	// blackholes instead of refusing — the case #31 was opened on), so the
	// scripts are injected with an error path and a deadline instead of being
	// <script src> tags that would gate the whole page on the CDN.
	const CDN = 'https://cdn.jsdelivr.net/npm/';
	let mode = null;

	function load(src) {
		return new Promise(res => {
			const s = document.createElement('script');
			s.src = src;
			s.onload = () => res(true);
			s.onerror = () => res(false);
			document.head.appendChild(s);
		});
	}

	// The stylesheet is not awaited: if the scripts made it, the CSS from the
	// same host did too.
	const css = document.createElement('link');
	css.rel = 'stylesheet';
	css.href = CDN + '@xterm/xterm@5.5.0/css/xterm.min.css';
	document.head.appendChild(css);

	const scripts = load(CDN + '@xterm/xterm@5.5.0/lib/xterm.min.js')
		.then(ok => ok && load(CDN + '@xterm/addon-fit@0.10.0/lib/addon-fit.min.js'))
		.then(ok => ok && !!(window.Terminal && window.FitAddon));

	// Nobody watches a blank page while a blackholed connection waits out the
	// browser's own timeout. Eight seconds is enough for a slow but working
	// link to win the race, and losing it only costs the richer console: the
	// fallback still runs commands, and if the scripts land late a switch is
	// offered rather than forced.
	const deadline = new Promise(res => setTimeout(res, 8000, false));

	Promise.race([scripts, deadline]).then(ok => {
		if (ok) startTerminal();
		else {
			startFallback();
			scripts.then(late => { if (late && mode !== 'terminal') offerTerminal(); });
		}
	});

	function startTerminal() {
		mode = 'terminal';
		const loading = $('#console-loading');
		if (loading) loading.remove();
		$('#console-fallback').classList.add('d-none');
		$('#terminal').classList.remove('d-none');

		const term = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 5000 });
		const fit = new FitAddon.FitAddon();
		term.loadAddon(fit);
		term.open($('#terminal'));
		fit.fit();

		const proto = location.protocol === 'https:' ? 'wss' : 'ws';
		const ws = new WebSocket(proto + '://' + location.host + '/ws/terminal');
		ws.binaryType = 'arraybuffer';
		const enc = new TextEncoder();
		const sendResize = () =>
			ws.readyState === 1 &&
			ws.send(JSON.stringify({ resize: { cols: term.cols, rows: term.rows } }));

		ws.onopen = () => { sendResize(); term.focus(); };
		ws.onmessage = e => term.write(new Uint8Array(e.data));
		ws.onclose = () => term.write('\r\n\x1b[31m[session closed]\x1b[0m\r\n');
		ws.onerror = () => term.write('\r\n\x1b[31m[connection error]\x1b[0m\r\n');

		term.onData(d => ws.readyState === 1 && ws.send(enc.encode(d)));
		term.onResize(sendResize);
		addEventListener('resize', () => fit.fit());
	}

	function startFallback() {
		mode = 'fallback';
		const loading = $('#console-loading');
		if (loading) loading.remove();
		$('#console-fallback').classList.remove('d-none');

		const form = $('#console-form'), input = $('#command'), out = $('#console-output');
		const dec = new TextDecoder();

		// run.cgi wraps the output in its own <b>prompt</b> lines. The stream
		// is never handed to innerHTML — each complete line becomes a text
		// node, or a <strong> when it is one of those prompt lines — so shell
		// output cannot smuggle markup into the page.
		let buf = '';
		function addLine(ln) {
			const m = ln.match(/^<b>(.*)<\/b>\r?$/);
			if (m) {
				const b = document.createElement('strong');
				b.textContent = m[1] + '\n';
				out.appendChild(b);
			} else {
				out.appendChild(document.createTextNode(ln + '\n'));
			}
		}
		function put(chunk, last) {
			buf += chunk;
			const lines = buf.split('\n');
			buf = lines.pop();
			lines.forEach(addLine);
			if (last && buf) { addLine(buf); buf = ''; }
		}

		form.addEventListener('submit', async ev => {
			ev.preventDefault();
			const c = input.value.trim();
			if (!c) return;
			const btn = form.querySelector('[type=submit]');
			btn.disabled = true;
			out.textContent = '';
			try {
				// Not encodeURIComponent()'d: run.cgi reads QUERY_STRING raw,
				// so base64's + / = must arrive as they are (see fw-reset.js).
				const r = await apiFetch('/cgi-bin/j/run.cgi?web=' + btoa(c));
				if (!r.ok) throw new Error('run.cgi answered ' + r.status);
				const rd = r.body.getReader();
				for (;;) {
					const { value, done } = await rd.read();
					if (done) break;
					put(dec.decode(value, { stream: true }), false);
				}
				put(dec.decode(), true);
			} catch (e) {
				put(String(e), true);
			}
			btn.disabled = false;
			input.select();
		});
		input.focus();
	}

	// The deadline fired but the CDN answered afterwards — a slow link, not a
	// dead one. Switching flushes whatever the one-shot console shows, so it
	// is the user's call, not ours.
	function offerTerminal() {
		const p = document.createElement('p');
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'btn btn-sm btn-outline-secondary';
		b.textContent = 'The full terminal has finished loading — switch to it';
		b.addEventListener('click', () => { p.remove(); startTerminal(); });
		p.appendChild(b);
		$('#console-fallback').prepend(p);
	}
})();
</script>

<%in p/footer.cgi %>
