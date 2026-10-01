#!/usr/bin/haserl
<%in p/common.cgi %>
<%
%>

<%in p/header.cgi %>
<!-- The console is xterm.js over /ws/terminal. xterm comes from a CDN, so a
     camera with no route to it has no console page; the shell is still an ssh
     away. -->
<p id="console-status" class="text-secondary">Loading the terminal&hellip;</p>
<div id="terminal" class="border rounded mb-3 d-none" style="height:72vh"></div>

<script>
(function () {
	'use strict';
	// xterm.js is ~300 KB and lives on jsDelivr rather than on the camera
	// because the smallest boards have no flash to spare for it. The scripts are
	// injected with an error path, never as <script src> tags that would gate
	// the page on the CDN (#31), so a camera without internet says so instead
	// of spinning.
	const CDN = 'https://cdn.jsdelivr.net/npm/';

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

	load(CDN + '@xterm/xterm@5.5.0/lib/xterm.min.js')
		.then(ok => ok && load(CDN + '@xterm/addon-fit@0.10.0/lib/addon-fit.min.js'))
		.then(ok => {
			if (ok && window.Terminal && window.FitAddon) return startTerminal();
			$('#console-status').textContent = 'The terminal could not be loaded from cdn.jsdelivr.net. ' +
				'This page needs the browser to reach it; without that, use ssh.';
		});

	function startTerminal() {
		$('#console-status').remove();
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
})();
</script>

<%in p/footer.cgi %>
