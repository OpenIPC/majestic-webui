/*
 * The raw capture page.
 *
 * Everything here works with no route out of the network: capture a frame from
 * majestic, keep it in the tab, hand it to the browser as a file. The editor is
 * an extra on top, fetched only when someone asks for it, and its absence
 * leaves an ordinary working page rather than a broken one.
 *
 * Frames are never written to the camera. A raw frame is 4.9 MB and the flash
 * it would land on is the one holding the firmware.
 */
(function () {
	const $ = (id) => document.getElementById(id);
	const shots = [];          // { name, bytes, at }
	let selected = -1;
	let editor = null;

	function fmtBytes(n) {
		return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB'
			: Math.round(n / 1024) + ' kB';
	}

	function note(kind, text, actionText, action) {
		const box = $('raw-note');
		if (!box) return;
		box.className = 'mj-notice mj-notice-' + kind;
		box.textContent = '';
		const txt = document.createElement('div');
		txt.className = 'mj-notice-txt';
		txt.textContent = text;
		box.append(txt);
		if (actionText) {
			const acts = document.createElement('span');
			acts.className = 'mj-notice-acts';
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'btn btn-sm btn-primary';
			b.textContent = actionText;
			b.addEventListener('click', action);
			acts.append(b);
			box.append(acts);
		}
		box.hidden = false;
	}

	function renderStrip() {
		const strip = $('raw-strip');
		if (!strip) return;
		strip.textContent = '';
		if (!shots.length) {
			const p = document.createElement('p');
			p.className = 'hint text-secondary mb-0';
			p.textContent = 'Frames you capture stay in this tab until you leave it.';
			strip.append(p);
			return;
		}
		// Built from classes the stylesheet already carries: PurgeCSS keeps
		// only what this repository's markup literally contains, so a class
		// invented here would need the whole sheet regenerated to survive.
		shots.forEach(function (s, i) {
			const card = document.createElement('button');
			card.type = 'button';
			card.className = 'btn btn-sm me-2 mb-2 ' +
				(i === selected ? 'btn-primary' : 'btn-outline-secondary');
			card.textContent = s.at + '  ' + fmtBytes(s.bytes.length);
			card.addEventListener('click', function () { selected = i; sync(); });
			strip.append(card);
		});
	}

	function sync() {
		const has = selected >= 0 && shots[selected];
		$('raw-download').disabled = !has;
		const open = $('raw-open');
		if (open) open.disabled = !has || !window.MajesticRaw || !MajesticRaw.available;
		renderStrip();
	}

	function capture() {
		const btn = $('raw-capture');
		btn.disabled = true;
		const began = Date.now();
		apiFetch('/image.dng', { credentials: 'same-origin' })
			.then(function (r) {
				if (r.status === 501)
					return Promise.reject(new Error('Raw capture is switched off on this camera.'));
				if (!r.ok) return Promise.reject(new Error('The camera answered ' + r.status + '.'));
				return r.arrayBuffer();
			})
			.then(function (buf) {
				const d = new Date();
				shots.unshift({
					name: 'raw-' + d.toISOString().replace(/[-:]/g, '').slice(0, 15) + '.dng',
					bytes: new Uint8Array(buf),
					at: d.toTimeString().slice(0, 8),
				});
				selected = 0;
				$('raw-note').hidden = true;
				$('raw-took').textContent = ((Date.now() - began) / 1000).toFixed(2) + ' s';
				sync();
			})
			.catch(function (e) { note('danger', e.message); })
			.then(function () { btn.disabled = false; });
	}

	function download() {
		const s = shots[selected];
		if (!s) return;
		const url = URL.createObjectURL(new Blob([s.bytes],
			{ type: 'application/octet-stream' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = s.name;
		a.click();
		// Revoked on a turn of the event loop: a download that has not started
		// by then never will.
		setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
	}

	function openEditor() {
		const s = shots[selected];
		if (!s) return;
		const btn = $('raw-open');
		btn.disabled = true;
		const host = $('raw-editor-host');
		host.hidden = false;
		MajesticRaw.mount(host, {
			onExit: function () {
				if (editor) { editor.destroy(); editor = null; }
				host.hidden = true;
				sync();
			},
		}).then(function (ed) {
			editor = ed;
			// A copy: the editor takes ownership of what it is given, and this
			// frame stays in the strip for a second look.
			return ed.open(s.bytes.slice(), s.name);
		}).catch(function (e) {
			host.hidden = true;
			note('warn',
				'The editor could not be loaded — it is fetched from the internet the first ' +
				'time it is opened, and this camera has no route out. Capture and download ' +
				'still work.' + (e && e.message === 'unsupported-browser'
					? ' This browser is also missing what it needs to run.' : ''),
				'Try again', function () { $('raw-note').hidden = true; openEditor(); });
			sync();
		});
	}

	document.addEventListener('DOMContentLoaded', function () {
		if (!$('raw-capture')) return;
		$('raw-capture').addEventListener('click', capture);
		$('raw-download').addEventListener('click', download);
		$('raw-open').addEventListener('click', openEditor);
		sync();

		// What the camera says about itself. Until it answers, the page claims
		// nothing: a config that did not arrive is not a camera without raw.
		MajesticRaw.support().then(function (s) {
			$('raw-mode').textContent = s.mode === null ? 'not available' : s.mode;
			if (s.mode === null) {
				note('info', 'This firmware does not serve raw frames. Raw capture needs a ' +
					'HiSilicon or Goke part whose SDK exposes the sensor’s own data.');
				$('raw-capture').disabled = true;
			} else if (!s.serves) {
				note('info', 'Raw capture is switched off for this camera. Turn it on in ' +
					'Settings to capture frames.');
				$('raw-capture').disabled = true;
			}
		});
	});
})();
