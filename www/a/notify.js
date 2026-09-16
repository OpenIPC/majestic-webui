/* The line at the top of the notification pages, and the sentences under the
 * switches - Telegram and Ntfy share every word of it.
 *
 * These two pages used to be a list of switches with no answer anywhere to the
 * only question anybody has: will this message me, and with what? Worse, one of
 * the switches depends on something the camera can be asked about and the page
 * never asked - "Send motion clips" needs a detector that is switched on, and
 * offered itself identically on a camera with the detector off, where it does
 * nothing at all and says nothing about it.
 *
 * So the verdict below is computed from what the CAMERA reports rather than
 * from what was typed here, and it keeps three answers apart throughout: a
 * thing that works, a thing that cannot, and a thing we could not ask about.
 * The third never renders as either of the first two - an unreachable
 * /api/v1/config.json is not a camera with motion detection switched off.
 */
(function () {
	'use strict';

	/* What the page will do, in words, from what the camera says it can do.
	 *
	 * Pure, and exported, because it is the part that fails silently: every
	 * branch produces a confident sentence and a wrong one reads exactly like a
	 * right one. tests/notify-status.test.js walks it.
	 *
	 * `camera.known` is false while nothing has answered yet, and everything
	 * that would otherwise accuse the camera of a misconfiguration is gated on
	 * it.
	 */
	function verdict(s) {
		var cam = s.camera || {};
		var trig = s.triggers || {};
		var out = { level: 'ok', head: '', what: '', when: '', why: {} };

		if (!s.senderInstalled) {
			out.level = 'bad';
			out.head = 'This firmware cannot send to ' + s.serviceName;
			out.what = '—';
			out.when = 'the part that does the sending is not installed';
			return out;
		}

		if (!s.enabled) {
			out.level = 'off';
			out.head = 'Switched off';
			out.what = describe(s);
			out.when = 'nothing will be sent';
			return out;
		}

		if (!s.addressed) {
			out.level = 'off';
			out.head = 'Not set up yet';
			out.what = '—';
			out.when = s.missing;
			return out;
		}

		/* Movement is the one trigger with a prerequisite, and the prerequisite
		 * is the detector rather than a memory card: with a card the recorder's
		 * clip is sent, without one the camera records a few seconds as the
		 * movement begins. Neither happens if nothing is watching.
		 *
		 * Three answers, not two, and the third is why this is written out
		 * rather than folded into a boolean. `known` false with `asked` false
		 * is the moment before the camera has replied, and the line says it is
		 * still looking - which is exactly what the server rendered, so the
		 * page does not flicker between two claims. `known` false with `asked`
		 * true is a camera that was asked twice and did not answer: movement
		 * is NOT counted, because a failed read must never become a promise,
		 * and the reason says we could not ask rather than accusing the camera
		 * of a setting nobody has seen.
		 */
		var motionWorks = !!trig.motion;
		var stillAsking = false;
		if (trig.motion && !cam.known) {
			if (cam.asked) {
				motionWorks = false;
				out.why.motion = 'The camera did not answer when it was asked ' +
					'whether it is watching for movement, so this may not happen.';
			} else {
				stillAsking = true;
			}
		} else if (trig.motion && cam.known && cam.motionDetect === false) {
			motionWorks = false;
			out.why.motion = 'The camera is not watching for movement, so this ' +
				'cannot happen. Everything else here works without it.';
		}

		/* Nothing is claimed about when until the prerequisite is settled. */
		if (stillAsking) {
			out.what = describe(s);
			out.head = 'Ready';
			out.when = 'checking what the camera can do\u2026';
			return out;
		}

		var when = [];
		if (motionWorks) {
			when.push('when something moves');
		}
		if (trig.schedule) {
			when.push(everyWords(s.interval));
		}
		/* Always last, and always there: the two links are live the moment the
		 * service is switched on and addressed, whatever the switches above
		 * say. A page that answered "nothing will be sent" with every switch
		 * off would be wrong the first time a doorbell called one of them. */
		when.push('when something asks');

		out.what = describe(s);
		out.level = out.why.motion ? 'warn' : 'ok';
		out.head = out.why.motion ? 'Partly ready' : 'Ready';
		out.when = join(when);
		return out;
	}

	function describe(s) {
		if (s.payload === 'video') {
			return s.seconds + '-second video';
		}
		return 'Picture';
	}

	function everyWords(mins) {
		var m = parseInt(mins, 10);
		if (m === 60) {
			return 'every hour';
		}
		if (m === 360) {
			return 'every six hours';
		}
		if (!m) {
			return 'on a timer';
		}
		return 'every ' + m + ' minutes';
	}

	function join(list) {
		if (list.length === 1) {
			return list[0];
		}
		return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
	}

	window.NotifyStatus = { verdict: verdict, everyWords: everyWords };

	/* ---------------------------------------------------------- the page --- */

	var boot = document.getElementById('mj-notify-boot');
	if (!boot) {
		return;
	}
	var cfg = JSON.parse(boot.textContent);
	var camera = { known: false, asked: false };

	function el(id) { return document.getElementById(id); }
	function val(id) { var e = el(id); return e ? e.value : ''; }
	function on(id) { var e = el(id); return !!(e && e.checked); }

	function state() {
		return {
			serviceName: cfg.label,
			senderInstalled: cfg.sender,
			enabled: on(cfg.key + '_enabled'),
			addressed: cfg.addressed,
			missing: cfg.missing,
			payload: on(cfg.key + '_video') ? 'video' : 'picture',
			seconds: val(cfg.key + '_video_seconds') || '10',
			interval: val(cfg.key + '_interval'),
			triggers: {
				motion: on(cfg.key + '_clips'),
				schedule: cfg.schedulable && on(cfg.key + '_crontab')
			},
			camera: camera
		};
	}

	/* Has anything been touched since the page was drawn? Compared against the
	 * snapshot the server put in the boot tag rather than against the controls'
	 * own defaultValue, because a select restored by the browser on a back
	 * navigation carries the restored value as its default. */
	function unsaved() {
		var was = cfg.saved;
		if (!was) {
			return false;
		}
		var now = state();
		return was.enabled !== on(cfg.key + '_enabled') ||
			was.video !== (now.payload === 'video') ||
			String(was.seconds) !== String(now.seconds) ||
			was.clips !== now.triggers.motion ||
			(cfg.schedulable && (
				was.crontab !== on(cfg.key + '_crontab') ||
				String(was.interval) !== String(now.interval)));
	}

	var ICONS = {
		ok: '<circle cx="12" cy="12" r="8.7"/><path d="m8.3 12.3 2.6 2.6 4.9-5.3"/>',
		warn: '<path d="M12 4.6 21.2 19.4H2.8z"/><path d="M12 10.2v4"/><path d="M12 17.1h.01"/>',
		bad: '<circle cx="12" cy="12" r="8.7"/><path d="M8.6 8.6 15.4 15.4"/><path d="M15.4 8.6 8.6 15.4"/>',
		off: '<circle cx="12" cy="12" r="8.7"/><path d="M12 11.2v5.2"/><path d="M12 7.7h.01"/>'
	};

	var shown = '';

	function paint() {
		var v = verdict(state());

		/* Rewriting identical markup restarts transitions and drops a text
		 * selection, so nothing is touched unless it actually moved. */
		var sig = [v.level, v.head, v.what, v.when, v.why.motion || '',
			unsaved() ? 'dirty' : ''].join('|');
		if (sig === shown) {
			return;
		}
		shown = sig;

		var strip = el('mj-notify-status');
		if (strip) {
			strip.className = 'mj-status' +
				(v.level === 'ok' ? '' : ' mj-status-' + v.level);
			strip.querySelector('.mj-status-ico').innerHTML =
				'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
				'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ' +
				'aria-hidden="true">' + ICONS[v.level] + '</svg>';
			strip.querySelector('.mj-notify-head').textContent = v.head;
			strip.querySelector('.mj-notify-what').textContent = v.what;
			strip.querySelector('.mj-notify-when').textContent = v.when;
		}

		/* A live preview is worth having -- change the length and the line
		 * changes with it -- but the same line is also the answer to "what is
		 * my camera doing", and the senders go on using the last SAVED
		 * settings until this form is submitted. So the preview is allowed,
		 * and it is labelled the moment it stops matching what was saved. */
		var un = el('mj-notify-unsaved');
		if (un) {
			if (unsaved()) {
				un.textContent = 'This is what Save will set. Until then the ' +
					'camera is still using the settings it last saved.';
				un.hidden = false;
			} else {
				un.hidden = true;
			}
		}

		var row = el('mj-trig-motion');
		var why = el('mj-trig-motion-why');
		if (row) {
			row.classList.toggle('mj-trig-off', !!v.why.motion);
		}
		if (why) {
			if (v.why.motion) {
				why.innerHTML = v.why.motion +
					' <a href="camera.cgi?tab=motionDetect">Switch it on</a>';
				why.hidden = false;
			} else {
				why.hidden = true;
			}
		}
	}

	/* What the camera can do, asked once and then left alone: it does not change
	 * while somebody fills in a form, and a page re-asking on a timer would
	 * spend a camera's CPU watching a value nobody is moving.
	 *
	 * A failed fetch leaves `known` false, which is why every accusation above
	 * is gated on it - mjConfig() resolves {} on failure, and reading that as
	 * "motion detection is off" would put a warning on a healthy camera.
	 */
	function askCamera() {
		if (!window.mjConfig) {
			camera = { known: false, asked: true };
			paint();
			return;
		}
		window.mjConfig().then(function (c) {
			var md = window.mjGet ? window.mjGet(c, 'motionDetect.enabled') : undefined;
			if (md === undefined) {
				/* Nothing usable came back. Ask once more, in case the camera
				 * was restarting. */
				setTimeout(function () {
					window.mjConfig().then(function (c2) {
						var md2 = window.mjGet
							? window.mjGet(c2, 'motionDetect.enabled')
							: undefined;
						camera = md2 === undefined
							? { known: false, asked: true }
							: { known: true, motionDetect: md2 === true };
						/* Painted either way. Giving up silently would leave
						 * the line saying it was still checking for as long as
						 * the page stayed open, which is a promise of an answer
						 * that is not coming. */
						paint();
					}, function () {
						camera = { known: false, asked: true };
						paint();
					});
				}, 15000);
				return;
			}
			camera = { known: true, motionDetect: md === true };
			paint();
		}, function () {
			/* A rejected fetch is not an answer about the camera either, but it
			 * is not final yet -- the retry above is still owed. */
			setTimeout(function () {
				camera = { known: false, asked: true };
				paint();
			}, 15000);
		});
	}

	/* --------------------------------------------------------- try it out --- */

	function wireTest() {
		var btn = el('mj-notify-test');
		var out = el('mj-notify-test-say');
		if (!btn || !out) {
			return;
		}
		btn.addEventListener('click', function () {
			var verb = btn.getAttribute('data-send');
			var ctl = new AbortController();
			/* The sender gives the camera a hundred seconds to answer, and a
			 * button disabled that long with no way out reads as a page that
			 * has crashed. */
			var deadline = setTimeout(function () { ctl.abort(); }, 120000);

			btn.disabled = true;
			out.className = 'mj-say text-secondary';
			out.textContent = verb === 'clip'
				? 'Recording and sending. This takes a few seconds.'
				: 'Sending...';

			/* POST, because this actuates the camera: it records and sends.
			 * A GET is what a browser issues on its own and carries the
			 * session with it. The published webhook URLs on this page still
			 * answer a GET, which is a separate contract with whatever is
			 * calling them from outside. */
			window.apiFetch('?send=' + verb, {
				method: 'POST',
				signal: ctl.signal
			})
				.then(function (r) { return r.text(); })
				.then(function (body) {
					var said = body.trim();
					var ok = said === 'true' || said === 'OK';
					out.className = 'mj-say ' + (ok ? 'text-success' : 'text-danger');
					out.textContent = ok
						? 'Sent. Have a look in ' + cfg.label + '.'
						: 'The camera could not send it. Check the settings below; ' +
							'the reason is in the camera log.';
				})
				.catch(function (e) {
					out.className = 'mj-say text-danger';
					out.textContent = e && e.name === 'AbortError'
						? 'The camera did not answer within two minutes. It may still be trying.'
						: 'Could not reach the camera.';
				})
				.finally(function () {
					clearTimeout(deadline);
					btn.disabled = false;
				});
		});
	}

	function wire() {
		['_enabled', '_video', '_video_seconds', '_clips', '_crontab', '_interval']
			.forEach(function (suffix) {
				var e = el(cfg.key + suffix);
				if (e) {
					e.addEventListener('change', paint);
				}
			});
		wireTest();
		paint();
		askCamera();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', wire);
	} else {
		wire();
	}
}());
