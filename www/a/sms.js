// The SMS page: list, delete, send, USSD. Decoding is sms-pdu.js's; this file
// asks j/sms.cgi, hands the transcript over, and draws the answer.
//
// Every string that came from the network -- a sender, a message, a USSD
// reply -- goes into the page as textContent and never as markup. An SMS is
// text anybody with a phone number can put on this page.
(function () {
	const S = window.MajesticSms;
	const list = $('#sms-list');
	if (!S || !list) return;

	const call = (qs, post) => apiFetch('/cgi-bin/j/sms.cgi?' + qs, {
		method: post ? 'POST' : 'GET', credentials: 'same-origin',
	}).then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)));

	// The answer has three outcomes and they read differently: the modem said
	// something (rc 0), the modem said no (rc 3, the transcript says why), or
	// nobody could ask (no port, port busy, request failed).
	const why = (j) => {
		if (j.error) return j.error;
		const bad = (j.lines || []).filter(l => /ERROR|no answer|no prompt/.test(l)).pop();
		return bad || 'the modem did not answer';
	};

	const el = (tag, cls, text) => {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	};

	const say = (node, text, cls) => {
		node.textContent = text;
		node.className = node.className.replace(/\btext-\S+/g, '') + ' text-' + (cls || 'secondary');
	};

	const when = (iso) => {
		if (!iso) return '';
		const d = new Date(iso);
		return isNaN(d) ? iso : d.toLocaleString();
	};

	// ---- inbox ----

	const msg = $('#sms-msg');
	const clear = $('#sms-clear');
	let busy = false;

	function storeSummary(lines) {
		// The +CPMS reply to selecting a storage is "<used>,<total>,…".
		const out = [];
		let mem = '';
		for (const l of lines) {
			const sel = /^=> AT\+CPMS="([A-Z]{2})"/.exec(l);
			if (sel) { mem = sel[1]; continue; }
			const m = /^\+CPMS:\s*(\d+),(\d+)/.exec(l);
			if (m && mem) out.push((mem === 'SM' ? 'SIM' : 'modem') + ' ' + m[1] + '/' + m[2]);
		}
		return out.join(' · ');
	}

	function draw(msgs) {
		list.replaceChildren();
		list.className = 'small';
		if (!msgs.length) {
			list.append(el('p', 'text-secondary mb-0', 'No messages.'));
			clear.disabled = true;
			return;
		}
		clear.disabled = false;
		for (const m of msgs) {
			const row = el('div', 'border-bottom py-2');
			const head = el('div', 'd-flex flex-wrap gap-2 align-items-baseline');
			head.append(el('b', '', m.addr || 'unknown sender'));
			head.append(el('span', 'x-small text-secondary', when(m.time)));
			if (m.type === 'submit') head.append(el('span', 'badge text-bg-secondary', 'outgoing'));
			if (m.stat === 'unread') head.append(el('span', 'badge text-bg-primary', 'new'));
			if (m.missing) head.append(el('span', 'badge text-bg-warning', m.missing + ' of ' + m.total + ' parts missing'));
			const del = el('button', 'btn btn-sm btn-link text-danger ms-auto p-0', 'Delete');
			del.type = 'button';
			del.addEventListener('click', () => remove(m.parts));
			head.append(del);
			row.append(head);
			let body;
			if (m.unreadable) body = el('div', 'text-secondary', 'A message this page cannot read.');
			else if (m.binary) body = el('div', 'text-secondary', 'Binary data, ' + m.binary.length / 2 + ' bytes.');
			else body = el('div', 'text-break', m.text);
			body.style.whiteSpace = 'pre-wrap';
			row.append(body);
			list.append(row);
		}
	}

	function load() {
		if (busy) return;
		busy = true;
		say(msg, 'Reading…');
		call('act=list').then(j => {
			if (j.rc !== 0) throw new Error(why(j));
			const store = $('#sms-store');
			if (store) store.textContent = storeSummary(j.lines);
			const msgs = S.joinParts(S.parseList(j.lines));
			draw(msgs);
			say(msg, '');
		}).catch(e => {
			list.replaceChildren(el('p', 'text-danger mb-0', 'Could not read the messages: ' + e.message));
			say(msg, '');
		}).finally(() => { busy = false; });
	}

	function remove(parts) {
		if (busy || !confirm('Delete this message?')) return;
		busy = true;
		say(msg, 'Deleting…');
		call('act=delete&del=' + parts.map(p => p.mem + '.' + p.idx).join(','), true).then(j => {
			busy = false;
			if (j.rc !== 0) { say(msg, 'Not deleted: ' + why(j), 'danger'); return; }
			load();
		}).catch(e => { busy = false; say(msg, 'Not deleted: ' + e.message, 'danger'); });
	}

	clear.addEventListener('click', () => {
		if (busy || !confirm('Delete every message on the SIM and in the modem?')) return;
		busy = true;
		say(msg, 'Deleting…');
		call('act=delete-all', true).then(j => {
			busy = false;
			if (j.rc !== 0) { say(msg, 'Not deleted: ' + why(j), 'danger'); return; }
			load();
		}).catch(e => { busy = false; say(msg, 'Not deleted: ' + e.message, 'danger'); });
	});
	$('#sms-reload').addEventListener('click', load);

	// ---- USSD ----

	const ussdForm = $('#ussd-form');
	const ussdOut = $('#ussd-reply');
	const ussdBtn = $('#ussd-send');
	const USSD_STATUS = {
		1: 'This is a menu. Answering it is not possible from here.',
		2: '', 0: '',
		3: 'Another client on the modem answered.',
		4: 'The network does not support this request.',
		5: 'The network did not answer in time.',
	};
	ussdForm.addEventListener('submit', () => {
		const code = $('#ussd-code').value.trim();
		if (!S.validUssd(code)) return;
		ussdBtn.disabled = true;
		ussdOut.hidden = false;
		ussdOut.replaceChildren(el('span', 'text-secondary', 'Asking the operator… this can take up to half a minute.'));
		call('act=ussd&code=' + encodeURIComponent(code), true).then(j => {
			const u = S.parseUssd(j.lines || []);
			ussdOut.replaceChildren();
			if (!u) {
				ussdOut.append(el('span', 'text-danger', 'No answer: ' + why(j)));
				return;
			}
			if (u.text) {
				const t = el('div', 'text-break p-2 rounded bg-body-tertiary', u.text);
				t.style.whiteSpace = 'pre-wrap';
				ussdOut.append(t);
			}
			const note = USSD_STATUS[u.status];
			if (note) ussdOut.append(el('div', 'x-small text-secondary mt-1', note));
		}).catch(e => {
			ussdOut.replaceChildren(el('span', 'text-danger', 'No answer: ' + e.message));
		}).finally(() => { ussdBtn.disabled = false; });
	});

	// ---- send ----

	const to = $('#send-to');
	const text = $('#send-text');
	const count = $('#send-count');
	const sendMsg = $('#send-msg');
	const sendBtn = $('#send-go');

	const recount = () => {
		const m = S.measure(text.value);
		if (!m.parts) { count.innerHTML = '&nbsp;'; return; }
		const per = m.encoding === 'gsm7' ? (m.parts > 1 ? 153 : 160) : (m.parts > 1 ? 67 : 70);
		count.textContent = m.units + ' characters, ' + m.parts + (m.parts > 1 ? ' messages' : ' message') +
			' (' + per + ' each' + (m.encoding === 'ucs2' ? ', Unicode' : '') + ')' +
			(m.parts > 10 ? ' — too long to send' : '');
	};
	text.addEventListener('input', recount);

	$('#send-form').addEventListener('submit', () => {
		if (!S.normaliseNumber(to.value)) { say(sendMsg, 'That is not a phone number.', 'danger'); return; }
		let pdus;
		try { pdus = S.encodeSubmit(to.value, text.value); } catch (e) {
			say(sendMsg, e.message === 'too long' ? 'Too long: ten messages at most.' : 'Cannot send that.', 'danger');
			return;
		}
		const parts = pdus.length > 1 ? ' as ' + pdus.length + ' messages' : '';
		if (!confirm('Send this to ' + S.normaliseNumber(to.value) + parts + '? The operator may charge for it.')) return;
		sendBtn.disabled = true;
		say(sendMsg, 'Sending…');
		call('act=send&pdu=' + pdus.map(p => p.len + ':' + p.pdu).join(','), true).then(j => {
			const sent = (j.lines || []).filter(l => /^\+CMGS:/.test(l)).length;
			if (j.rc === 0 && sent === pdus.length) {
				say(sendMsg, 'Sent.', 'success');
				text.value = '';
				recount();
			} else {
				say(sendMsg, (sent ? sent + ' of ' + pdus.length + ' parts sent; ' : 'Not sent: ') + why(j), 'danger');
			}
		}).catch(e => say(sendMsg, 'Not sent: ' + e.message, 'danger'))
			.finally(() => { sendBtn.disabled = false; });
	});

	load();
})();
