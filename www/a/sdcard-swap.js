// Changing the SD card without stopping the camera for longer than it takes.
//
// The thing this exists to avoid is the obvious way of doing it: pull the card
// out while the camera is writing to it. That costs the clip being written, and
// until the firmware learned to let go of a card that has left the slot it also
// cost the slot itself — the mount outlived the card, and every later card was
// silently never mounted.
//
// So the order is: stop the recorder, let go of the card, say when it is safe,
// wait for the swap, and start recording again the moment there is somewhere to
// record to. The pause is what makes the card removable at all; the resume is
// what makes it quick, because a recorder that merely lost its storage waits
// out a thirty-second back-off before looking again and this does not.
//
// No DOM and no fetch. Everything the camera does arrives through `io`, so this
// can be run against stubs — which is the only way to test a flow whose middle
// step is a person taking a card out of a slot.
(function () {
	'use strict';

	// How long to wait for each half of the human step. Generous on purpose:
	// this is somebody at a camera, possibly up a ladder, and the cost of
	// waiting too long is a dialog that is still open, while the cost of
	// giving up too early is a card swapped into a camera that has stopped
	// watching for it. Both halves are bounded because neither is guaranteed
	// to happen at all — the card may never come out, or never go back in.
	const WAIT_OUT_MS = 120000;
	const WAIT_IN_MS = 180000;
	const POLL_MS = 1000;

	// What the caller is told, in order. The UI owns the words; these are the
	// states it draws, and the ones a test asserts on.
	//
	//   pausing     the recorder is being stood down
	//   releasing   the filesystem is being unmounted
	//   remove      SAFE TO REMOVE — the only step that waits on a person
	//   waiting     the old card is out; waiting for a new one
	//   mounting    a card arrived and is being made ready
	//   resuming    recording is being started again
	//   done        a clip is being written to the new card
	function step(io, name, extra) {
		if (io.onStep) io.onStep(Object.assign({ step: name }, extra || {}));
	}

	// A camera op counts as done only if it says so.
	//
	// `!r || r.ok === false` let an empty or half-written JSON object through
	// as success, and the op it guards is the unmount -- after which the page
	// tells somebody it is safe to pull the card. An answer that does not say
	// it worked is not proof that it did.
	function ok(r) { return !!(r && r.ok === true); }

	// Poll `look()` until `want` is satisfied, or the budget runs out.
	//
	// Three answers, not two. A timeout after real readings means the card did
	// not move; a timeout during which EVERY look failed means the endpoint
	// was unreachable and nothing at all is known -- and saying "the card never
	// came out" on the strength of that is a confident sentence with nothing
	// behind it, which is this UI's recurring bug class.
	//
	//   { seen }    the reading that satisfied it
	//   { blind }   the whole window went by with no usable reading
	//   {}          looked, and it never happened
	async function until(io, want, budgetMs, name) {
		const end = io.now() + budgetMs;
		let anyRead = false;
		while (io.now() < end) {
			if (io.stopped && io.stopped()) return { stopped: true };
			let seen = null;
			try {
				seen = await io.look();
			} catch (e) {
				seen = null;
			}
			if (seen) {
				anyRead = true;
				if (want(seen)) return { seen: seen };
			}
			step(io, name, { waitedMs: budgetMs - (end - io.now()) });
			await io.wait(POLL_MS);
		}
		return anyRead ? {} : { blind: true };
	}

	// Is this a different card from the one that was in the slot?
	//
	// Asked of the serial, which is the card's own and survives a format. A
	// camera whose kernel does not report one answers undefined for both, and
	// two undefineds are not evidence of anything — so an unknown serial is
	// treated as "cannot tell", and the swap is allowed to finish rather than
	// accusing somebody of putting the same card back.
	function looksNew(before, after) {
		if (!before || !after) return true;
		if (!before.serial || !after.serial) return true;
		return before.serial !== after.serial;
	}

	async function run(io) {
		let started = null;
		try {
			started = await io.look();
		} catch (e) {
			return { outcome: 'unknown' };
		}
		if (!started || !started.present || !started.mounted) {
			return { outcome: 'nocard' };
		}

		// One swap at a time, camera-wide rather than tab-wide.
		//
		// Two browsers can each be sure they are the only one. The second one
		// to reach the unmount finds the card already gone, treats that as a
		// failure, puts it back and starts the recorder again -- while the
		// first is still displaying SAFE TO REMOVE over a card that is now
		// mounted and being written to. That is the one arrangement in this
		// flow that can cost somebody a filesystem.
		//
		// The camera's own stand-down flag is what is asked, because it is
		// camera-wide and already published; a flag held in the page would be
		// invisible to exactly the second page that needs to see it.
		if (io.swapping) {
			let busy = false;
			try {
				busy = await io.swapping();
			} catch (e) {
				// Cannot tell, so do not block the operator in front of the
				// camera on the strength of a failed read.
				busy = false;
			}
			if (busy) return { outcome: 'busy' };
		}

		const was = { serial: started.serial, mountpoint: started.mountpoint };

		// From here on the recorder is stopped, so every exit has to start it
		// again -- including the ones nobody wrote down, which is why the body
		// below runs inside a try and `finish` is in the finally path of every
		// branch. A request that rejects halfway used to leave the camera
		// paused with the dialog still spinning, and the camera's own
		// ten-minute timer was all that eventually fixed it.
		step(io, 'pausing');
		try {
			await io.standDown();
		} catch (e) {
			// A rejected request is not proof the daemon did not act on it --
			// the reply can be lost after the pause was applied. So ask for a
			// resume before giving up: a resume the recorder did not need is
			// harmless, and skipping one it did need is ten minutes of a
			// camera not recording.
			try {
				await io.resume();
			} catch (e2) { /* the camera's own timer is the backstop */ }
			return { outcome: 'pausefailed', error: String(e && e.message || e) };
		}

		// The only way out. Two jobs: put the card back, then start the
		// recorder.
		//
		// The mount half is the one that is easy to forget and silent when it
		// is missing. Every path below this point has already unmounted the
		// card, and the hotplug rules only mount a card that ARRIVES -- so a
		// swap that ends with the original card still in the slot ends with
		// that card unmounted, and nothing will ever mount it. Resuming then
		// puts the recorder back to work with nowhere to write: it reports
		// storage offline, retries every thirty seconds, and never recovers.
		// A camera that looks fine and records nothing, which is the exact
		// failure this whole flow exists to avoid.
		//
		// Measured before it was fixed: the give-up path left the recorder
		// reporting storage offline with its fragment counter frozen,
		// indefinitely.
		const finish = async (result) => {
			try {
				const now = await io.look();
				if (now && now.present && !now.mounted) {
					// Checked, not assumed. A card that cannot be mounted
					// again leaves the camera with nowhere to record, and the
					// caller has to be able to say so rather than reporting a
					// tidy ending over the top of it.
					if (!ok(await io.mount())) result.remountFailed = true;
				}
			} catch (e) {
				result.remountFailed = true;
			}
			try {
				await io.resume();
			} catch (e) {
				// The camera resumes itself within ten minutes whatever
				// happens here, so this is worth reporting and not worth
				// failing the swap over.
				result.resumeFailed = true;
			}
			return result;
		};

		try {
			// Stop, pressed while the stand-down was in flight.
			//
			// It used to be noticed only inside the polling loops, which are
			// downstream of the unmount -- so asking to stop during the one
			// step that takes a visible moment still released the filesystem
			// and still flashed SAFE TO REMOVE before putting it all back.
			// Somebody reading that word has their hand on the card.
			if (io.stopped && io.stopped()) return await finish({ outcome: 'stopped' });

			step(io, 'releasing');
			const un = await io.unmount();
			if (!ok(un)) {
				// Nothing was taken away from anybody: the card is still
				// mounted and the recorder is about to have it back.
				return await finish({
					outcome: 'unmountfailed', error: (un && un.error) || '',
				});
			}

			// The card is now safe to remove, and saying so is the whole point
			// of the two steps above. It is said only after an unmount that
			// reported success.
			step(io, 'remove', { mountpoint: was.mountpoint });

			const gone = await until(io, (d) => !d.present, WAIT_OUT_MS, 'remove');
			if (gone.stopped) return await finish({ outcome: 'stopped' });
			if (gone.blind) return await finish({ outcome: 'unknown' });
			if (!gone.seen) {
				// The card never left. Nothing is broken and nothing was lost
				// -- it is simply still there, and putting it back to work is
				// the right end to this.
				return await finish({ outcome: 'stillthere' });
			}

			step(io, 'waiting');
			let came = await until(io, (d) => d.present, WAIT_IN_MS, 'waiting');
			if (came.stopped) return await finish({ outcome: 'stopped' });
			if (!came.seen && !came.blind) {
				// A slot whose card-detect is not wired never raises the event
				// that would have told the kernel a card arrived, so the card
				// can be in and unseen. Asking the controller to look again is
				// the only thing left, and it is worth one try.
				let asked = null;
				if (io.reprobe) {
					step(io, 'reprobe');
					try {
						asked = await io.reprobe();
					} catch (e) {
						asked = null;
					}
					if (ok(asked)) came = await until(io, (d) => d.present, 30000, 'waiting');
				}
				if (!came.seen) {
					// A camera that could not be asked to look again has not
					// established that no card arrived -- it has established
					// that it cannot tell. Those are different sentences and
					// only one of them is about the card.
					if (io.reprobe && !ok(asked)) {
						return await finish({
							outcome: 'cannotdetect',
							error: (asked && asked.error) || '',
						});
					}
					if (came.blind) return await finish({ outcome: 'unknown' });
					return await finish({ outcome: 'nonewcard' });
				}
			}
			if (came.blind && !came.seen) return await finish({ outcome: 'unknown' });
			let arrived = came.seen;

			step(io, 'mounting');
			// The hotplug rules mount a card on their own, so this is usually
			// already true by the time it is asked. Mounting is only for the
			// card they could not take -- and a failure here is the card's,
			// not the swap's, so it is reported with the card's own words.
			if (!arrived.mounted) {
				const m = await io.mount();
				if (!ok(m)) {
					return await finish({
						outcome: 'mountfailed', error: (m && m.error) || '',
					});
				}
				arrived = await io.look();
			}

			// Where the clips are configured to go is a path, and the hotplug
			// rules name a mount after the device. A card with no partition
			// table mounts as the whole disk under a different name, which
			// resolves to no directory at all -- recording would fail with
			// nothing obviously wrong with the card.
			if (!arrived || !arrived.mounted) {
				return await finish({ outcome: 'mountfailed', error: '' });
			}
			if (arrived.mountpoint !== was.mountpoint) {
				return await finish({
					outcome: 'elsewhere',
					mountpoint: arrived.mountpoint, expected: was.mountpoint,
				});
			}

			step(io, 'resuming');
			const done = await finish({
				outcome: 'done',
				sameCard: !looksNew(was, arrived),
				mountpoint: arrived.mountpoint,
			});
			if (!done.resumeFailed && !done.remountFailed) step(io, 'done');
			return done;
		} catch (e) {
			// Anything that got out of the block above did so with the
			// recorder stopped. This is the one branch that exists purely so
			// that cannot happen.
			return await finish({
				outcome: 'unknown', error: String(e && e.message || e),
			});
		}
	}

	const api = { run: run, looksNew: looksNew };
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	if (typeof window !== 'undefined') window.MajesticSdSwap = api;
}());
