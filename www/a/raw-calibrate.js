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
			if (confirming) return;
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
	/* Set while Keep is on its way to the camera: the operator has chosen, and
	 * leaving the page then must not race a restore against the confirmation. */
	let confirming = false;
	/* isp.colorMatrix as it was before a profile was saved, when saving had to
	 * clear it: a manual matrix is applied over the profile's own, and a
	 * calibration saved underneath one would never be seen. */
	let profileWas = null;

	/* Ask for the profile back. True when the camera is back as it was:
	 * restored, or answering that there was nothing to put back (a 409 --
	 * the write never landed). False when it could not be asked. */
	function putBack() {
		return profilePost('?restore=1').then(function () { return true; },
			function (e) { return !!e.answered && /nothing to put back/.test(e.message); });
	}

	function profilePost(query, body) {
		return apiFetch(PROFILE + (query || ''), {
			method: 'POST',
			headers: { 'Content-Type': 'text/plain; charset=utf-8' },
			credentials: 'same-origin',
			body: body || '',
		}).then(function (r) {
			return r.text().then(function (t) {
				/* An answer, even a refusal, says what the camera did; the
				 * callers below tell that from no answer at all. */
				const answered = function (e) { e.answered = true; return e; };
				if (!r.ok)
					throw answered(new Error((t || '').trim() || ('The camera answered ' + r.status + '.')));
				/* Firmware that predates writing a profile answers a POST
				 * here with its GET handler: the profile itself, as a file
				 * to download. That is not a save, whatever the profile says. */
				const disp = r.headers && r.headers.get && r.headers.get('Content-Disposition');
				if (disp && /attachment/i.test(disp))
					throw answered(new Error('The camera answered with its profile instead of ' +
						'saving the change.'));
				return t;
			});
		});
	}

	return {
		holdSeconds: 30,
		apply: function (solved) {
			/* One change waiting at a time. A matrix applied under an
			 * unconfirmed profile, or the other way round, leaves two
			 * checkpoints that each undo part of the other; the editor
			 * never asks for that, and this refuses it outright. */
			if (written === 'profile')
				return Promise.reject(new Error('The saved profile is still waiting to be kept ' +
					'or put back.'));
			return readKeys().then(function (was) {
				previous = was;
				written = 'matrix';
				armUnloadRevert();
				return setKeys(fmt(solved.ccm), fmt(solved.colorMatrix));
			});
		},
		/*
		 * Write sections into the profile and nothing else.
		 *
		 * persist() below is about a colour calibration, and after its POST it
		 * drops the camera's manual colour matrix -- necessary there, because a
		 * manual matrix would sit over the calibration and hide it. A caller
		 * patching some other section has no business losing the operator's
		 * colour settings, so this is a sibling rather than an argument to it.
		 *
		 * Everything that makes the write safe is shared: the one-change-at-a-
		 * time guard, the unload handler, and the same detection of firmware
		 * that answers a POST with its GET handler. revert() and keep() need
		 * no changes -- they already branch on profileWas, which stays null
		 * here because no colour key was touched.
		 */
		patchProfile: function (ini) {
			if (previous || written)
				return Promise.reject(new Error('The last change is still waiting to be kept ' +
					'or put back.'));
			written = 'profile';
			profileWas = null;
			armUnloadRevert();
			return profilePost('', ini).then(function (said) {
				/* A 200 that is not an acknowledgement is not a save. Saying
				 * only what the camera did: the WebUI and majestic ship as one
				 * image, so there is no version of this the operator could go
				 * and fetch. */
				if (!/^\[\w+\] written to \S/m.test(said)) {
					const e = new Error('The camera did not accept the change to its image ' +
						'profile.');
					e.answered = true;
					throw e;
				}
				return said;
			/*
			 * .catch, NOT a second argument to .then.
			 *
			 * A rejection handler passed beside the fulfillment one does not
			 * see what the fulfillment one throws -- so the refusal above
			 * escaped the cleanup below, `written` stayed set, and every later
			 * patch was refused for a change the caller had been told did not
			 * happen. One lost answer locked the profile for the session.
			 */
			}).catch(function (err) {
				/* No answer is not proof it did not write, so ask for the
				 * profile back before standing down. */
				const settle = err.answered ? Promise.resolve(true) : putBack();
				return settle.then(function (recovered) {
					if (recovered) { written = null; profileWas = null; }
					throw err;
				});
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
			if (previous || written)
				return Promise.reject(new Error('The last change is still waiting to be kept ' +
					'or put back.'));
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
					if (!/^\[\w+\] written to \S/m.test(said)) {
						const e = new Error('The camera answered without confirming it had saved ' +
							'the calibration.');
						e.answered = true;
						throw e;
					}
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
						/* Read back, as revert() does: firmware that answers
						 * 200 and ignores a null leaf would leave the old
						 * matrix over the calibration while reporting a save. */
						.then(function () { return readKeys(); })
						.then(function (now) {
							if (now.colorMatrix !== null)
								throw new Error('the camera kept its manual colour matrix, which ' +
									'would hide the saved calibration; the profile was put back.');
						})
						.catch(function (err) {
							err.undone = true;
							/* Undo both halves: the matrix may already be gone
							 * even though what came after it failed. Each is
							 * tried whatever the other does, and whether both
							 * landed decides what happens to the checkpoint. */
							return putBack().then(function (ok) {
								return setKeys(was.colorMatrix, was.dngColorMatrix)
									.then(function () { return ok; }, function () { return false; });
							}).then(function (ok) {
								err.recovered = ok;
								throw err;
							});
						});
				}).catch(function (err) {
					/* No answer to the save -- the connection dropped, the reply
					 * was lost -- is not proof the camera did not write it, so
					 * the profile is asked back. A camera that answered, with a
					 * refusal or as old firmware, wrote nothing, and a restore
					 * then could only undo something older. */
					const settle = err.answered ? Promise.resolve(true)
						: err.undone ? Promise.resolve(err.recovered)
							: putBack();
					return settle.then(function (recovered) {
						/* The checkpoint is dropped only once the camera is known
						 * to be back where it was. Otherwise it stays armed, so
						 * Put it back -- or leaving the page -- tries again. */
						if (recovered) {
							written = null;
							profileWas = null;
						} else {
							err.message += ' The camera could not be put back yet; use Put it ' +
								'back to try again.';
						}
						throw err;
					});
				});
			});
		},
		revert: function () {
			if (written === 'profile') {
				const keys = profileWas;
				/* putBack(), not a bare restore: an earlier attempt may have put
				 * the profile back and then failed on the matrix, and a retry is
				 * then answered "nothing to put back" -- which is done, not an
				 * error, and must not stop the matrix being restored. */
				return putBack()
					.then(function (ok) {
						if (!ok) throw new Error('The camera could not be asked for its profile back.');
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
				confirming = true;
				return profilePost('?keep=1').then(function () {
					confirming = false;
					/* All of it: a matrix checkpoint still armed from an
					 * earlier Apply would otherwise be posted by the unload
					 * handler over the calibration just kept. */
					written = null; profileWas = null; previous = null;
				}, function (err) {
					/* Not confirmed after all: the way back is armed again. */
					confirming = false;
					throw err;
				});
			}
			previous = null;
			written = null;
			return Promise.resolve();
		},
	};
})();
