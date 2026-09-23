/*
 * What the raw editor is given so it can write a colour calibration to this
 * camera, and take it back.
 *
 * The same shape as raw-plates.js, and split out of raw.js for the same
 * reason: the editor is fetched from a CDN and knows nothing about this
 * camera, so the endpoints, the keys and above all what has to be put back
 * stay here, in the copy that ships with the firmware -- where a test can
 * hold them still without a page around them.
 *
 * Two things can be written. apply() puts one solved matrix on the live
 * picture through isp.colorMatrix; persist() writes a whole calibration --
 * white balance, its curve, a matrix per temperature -- into the camera's
 * image profile. revert() and keep() answer for whichever was written last.
 */
window.MajesticCalibrate = (function () {
	/*
	 * Writing a solved matrix to the camera, and being able to take it back.
	 *
	 * Both keys go together because one Calibrate produces both, and they are
	 * different transforms: isp.colorMatrix drives the live picture, and
	 * isp.dngColorMatrix is what a RAW snapshot carries. Neither is derived
	 * from the other.
	 *
	 * What makes this safe is remembering what was there first. A matrix that
	 * ruins the picture also ruins the view you would use to notice, and the
	 * setting survives a reboot, so the camera would come back still wrong.
	 */
	let previous = null;

	function fmt(m) {
		return Array.prototype.map.call(m, function (v) { return (+v).toFixed(4); }).join(' ');
	}

	/*
	 * Both keys in one POST /api/v1/config, which is the batch write: the
	 * server walks every leaf, aborts on the first one it rejects, and only
	 * then reloads and saves. Two keys that must agree cannot be written by two
	 * requests, and /api/v1/set is the single-key variant the WebUI does not
	 * use.
	 *
	 * null REMOVES a leaf. That is the only way to put an optional setting back
	 * the way it was found -- an empty string reaches the setter and is a value
	 * like any other -- and putting things back is this whole feature's safety
	 * net, so the difference is the point rather than a detail.
	 */
	function configBody(colorMatrix, dngColorMatrix) {
		return JSON.stringify({ isp: { colorMatrix: colorMatrix, dngColorMatrix: dngColorMatrix } });
	}

	function setKeys(colorMatrix, dngColorMatrix) {
		return apiFetch('/api/v1/config', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'same-origin',
			body: configBody(colorMatrix, dngColorMatrix),
		}).then(function (r) {
			if (!r.ok) throw new Error('The camera answered ' + r.status + '.');
		});
	}

	function readKeys() {
		return apiFetch('/api/v1/config.json', { credentials: 'same-origin' })
			.then(function (r) {
				if (!r.ok) throw new Error('The camera would not say what it is set to now.');
				return r.json();
			})
			.then(function (cfg) {
				const isp = (cfg && cfg.isp) || {};
				// null for a key that was not there, so restoring removes it
				// again rather than leaving an empty value behind.
				return {
					colorMatrix: 'colorMatrix' in isp ? isp.colorMatrix : null,
					dngColorMatrix: 'dngColorMatrix' in isp ? isp.dngColorMatrix : null,
				};
			});
	}

	/* Older majestic answers 202 and ignores null leaves, so a revert that
	 * meant to remove a key has to be checked rather than assumed -- the same
	 * reason mj-settings.js re-reads after a save. */
	function confirmRestored(was) {
		return readKeys().then(function (now) {
			if (now.colorMatrix === was.colorMatrix &&
				now.dngColorMatrix === was.dngColorMatrix) return;
			throw new Error('the camera did not take the old settings back; ' +
				'this firmware may be too old to remove a setting.');
		});
	}

	/* Best effort if the tab goes away mid-countdown. keepalive lets a request
	 * outlive the page; nothing guarantees it arrives, which is why the editor
	 * asks for confirmation rather than treating this as the safety net.
	 *
	 * Registered once and kept, reading `previous` when it fires rather than
	 * closing over it. Arming a fresh one per apply left a handler per
	 * calibration, and clearing `previous` is then the single thing that
	 * disarms all of it -- which is what keep() below does. */
	let unloadArmed = false;
	function armUnloadRevert() {
		if (unloadArmed) return;
		unloadArmed = true;
		window.addEventListener('pagehide', function () {
			if (written === 'profile') {
				try {
					fetch(PROFILE + '?restore=1', {
						method: 'POST',
						credentials: 'same-origin',
						keepalive: true,
					});
					if (profileWas)
						fetch('/api/v1/config', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							credentials: 'same-origin',
							keepalive: true,
							body: configBody(profileWas.colorMatrix, profileWas.dngColorMatrix),
						});
				} catch (e) { /* the page is going; nothing to report it to */ }
				return;
			}
			if (!previous) return;
			try {
				fetch('/api/v1/config', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					credentials: 'same-origin',
					keepalive: true,
					body: configBody(previous.colorMatrix, previous.dngColorMatrix),
				});
			} catch (e) { /* the page is going; nothing to report it to */ }
		});
	}

	/*
	 * The camera's image profile: the colour calibration it runs across lights
	 * -- white balance, the curve auto white balance follows, a colour matrix
	 * per temperature -- as the camera's image profile carries it. Read as
	 * the baseline a calibration is built against, and written back as whole
	 * sections, which the camera checks before it stores anything and keeps a
	 * copy to put back.
	 */
	const PROFILE = '/api/v1/isp/profile.ini';

	/* Which of the two was written last, so revert() and keep() answer for it. */
	let written = null;
	/* isp.colorMatrix as it was before a profile was saved, when saving had to
	 * clear it: a manual matrix is applied over the profile's own, and a
	 * calibration saved underneath one would never be seen. */
	let profileWas = null;

	function profilePost(query, body) {
		return apiFetch(PROFILE + (query || ''), {
			method: 'POST',
			headers: { 'Content-Type': 'text/plain; charset=utf-8' },
			credentials: 'same-origin',
			body: body || '',
		}).then(function (r) {
			return r.text().then(function (t) {
				if (!r.ok) throw new Error((t || '').trim() || ('The camera answered ' + r.status + '.'));
				return t;
			});
		});
	}

	return {
		holdSeconds: 30,
		apply: function (solved) {
			return readKeys().then(function (was) {
				previous = was;
				written = 'matrix';
				armUnloadRevert();
				return setKeys(fmt(solved.ccm), fmt(solved.colorMatrix));
			});
		},
		baseline: function () {
			return apiFetch(PROFILE, { credentials: 'same-origin' }).then(function (r) {
				if (!r.ok) throw new Error('The camera would not hand back its image profile (' +
					r.status + ').');
				return r.text();
			});
		},
		persist: function (ini) {
			return readKeys().then(function (was) {
				/* Armed before the write, not after it: a camera that takes
				 * the POST while the page is closing never gets its answer
				 * back, and the unload handler has to know there may be
				 * something to put back. A restore with nothing written is
				 * answered 409 and changes nothing. */
				written = 'profile';
				profileWas = null;
				armUnloadRevert();
				return profilePost('', ini).then(function (said) {
					/* Firmware that predates writing a profile answers a POST
					 * to this route the way it answers a GET -- with the
					 * profile, and 200. That is not a save, and must not be
					 * reported as one. */
					if (!/written to/.test(said))
						throw new Error('This camera\'s firmware cannot save into its image ' +
							'profile; update it to keep a calibration.');
					if (was.colorMatrix === null) return;
					/* The manual matrix goes, or the calibration under it
					 * would never be seen. If the camera will not let it go,
					 * the save has not done what it was for: the profile is
					 * put back at once rather than left for a revert that the
					 * caller, handed an error, has no reason to ask for. */
					/* Checkpointed before the request, like the profile: a page
					 * that closes once the camera has dropped the matrix but
					 * before the answer arrives must still put it back. */
					profileWas = was;
					return setKeys(null, was.dngColorMatrix)
						.catch(function (err) {
							return profilePost('?restore=1').catch(function () {})
								.then(function () { throw err; });
						});
				}).catch(function (err) {
					written = null;
					profileWas = null;
					throw err;
				});
			});
		},
		revert: function () {
			if (written === 'profile') {
				const keys = profileWas;
				return profilePost('?restore=1')
					.then(function () {
						if (!keys) return;
						return setKeys(keys.colorMatrix, keys.dngColorMatrix)
							.then(function () { return confirmRestored(keys); });
					})
					.then(function () { written = null; profileWas = null; });
			}
			if (!previous) return Promise.resolve();
			const was = previous;
			return setKeys(was.colorMatrix, was.dngColorMatrix)
				.then(function () { return confirmRestored(was); })
				.then(function () { previous = null; written = null; });
		},
		/* Confirmed. Forgetting what was there before is what stands the unload
		 * handler down -- without this it would put the old matrix back the
		 * next time the page closed, undoing a calibration on purpose kept.
		 * A saved profile is confirmed on the camera too, which drops the copy
		 * it kept to put back. */
		keep: function () {
			if (written === 'profile') {
				return profilePost('?keep=1').then(function () {
					/* All of it: a matrix checkpoint still armed from an
					 * earlier Apply would otherwise be posted by the unload
					 * handler over the calibration just kept. */
					written = null; profileWas = null; previous = null;
				});
			}
			previous = null;
			written = null;
			return Promise.resolve();
		},
	};
})();
