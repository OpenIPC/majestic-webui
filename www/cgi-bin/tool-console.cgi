#!/usr/bin/haserl
<%in p/common.cgi %>
<%
page_title="Console"
%>

<%in p/header.cgi %>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<div id="terminal" class="border rounded mb-3" style="height:72vh"></div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<script>
(function () {
	const term = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 5000 });
	const fit = new FitAddon.FitAddon();
	term.loadAddon(fit);
	term.open(document.getElementById('terminal'));
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
})();
</script>

<%in p/footer.cgi %>
