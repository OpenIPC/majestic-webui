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

	// Poll `look()` until `want` is satisfied, or the budget runs out.
	//
	// Returns the reading that satisfied it, or null on timeout. A look that
	// throws is not a card that is absent — the endpoint may simply not have
	// answered — so it is swallowed and retried rather than counted either way.
	async function until(io, want, budgetMs, name) {
		const end = io.now() + budgetMs;
		while (io.now() < end) {
			if (io.stopped && io.stopped()) return null;
			let seen = null;
			try {
				seen = await io.look();
			} catch (e) {
				seen = null;
			}
			if (seen && want(seen)) return seen;
			step(io, name, { waitedMs: budgetMs - (end - io.now()) });
			await io.wait(POLL_MS);
		}
		return null;
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
		const started = await io.look();
		if (!started || !started.present || !started.mounted) {
			return { outcome: 'nocard' };
		}
		const was = { serial: started.serial, mountpoint: started.mountpoint };

		// From here on the recorder is stopped, so every exit has to start it
		// again. `finish` is the only way out for that reason.
		step(io, 'pausing');
		try {
			await io.standDown();
		} catch (e) {
			return { outcome: 'pausefailed', error: String(e && e.message || e) };
		}

		// The only way out, and it has two jobs: put the card back, then start
		// the recorder.
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
		// Measured before it was fixed: give-up path left records_state 3 with
		// the fragment counter frozen, indefinitely.
		const finish = async (result) => {
			try {
				const now = await io.look();
				if (now && now.present && !now.mounted) await io.mount();
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

		step(io, 'releasing');
		const un = await io.unmount();
		if (!un || un.ok === false) {
			// Nothing was taken away from anybody: the card is still mounted
			// and the recorder is about to have it back.
			return finish({ outcome: 'unmountfailed', error: (un && un.error) || '' });
		}

		// The card is now safe to remove, and saying so is the whole point of
		// the two steps above.
		step(io, 'remove', { mountpoint: was.mountpoint });

		const gone = await until(io, (d) => !d.present, WAIT_OUT_MS, 'remove');
		if (!gone) {
			if (io.stopped && io.stopped()) return finish({ outcome: 'stopped' });
			// The card never left. Nothing is broken and nothing was lost —
			// it is simply still there, and putting it back to work is the
			// right end to this.
			return finish({ outcome: 'stillthere' });
		}

		step(io, 'waiting');
		let arrived = await until(io, (d) => d.present, WAIT_IN_MS, 'waiting');
		if (!arrived) {
			if (io.stopped && io.stopped()) return finish({ outcome: 'stopped' });
			// A slot whose card-detect is not wired never raises the event
			// that would have told the kernel a card arrived, so the card can
			// be in and unseen. Asking the controller to look again is the
			// only thing left, and it is worth one try before giving up.
			if (io.reprobe) {
				step(io, 'reprobe');
				try {
					await io.reprobe();
				} catch (e) { /* the look below is the real answer */ }
				arrived = await until(io, (d) => d.present, 30000, 'waiting');
			}
			if (!arrived) return finish({ outcome: 'nonewcard' });
		}

		step(io, 'mounting');
		// The hotplug rules mount a card on their own, so this is usually
		// already true by the time it is asked. Mounting is only for the card
		// they could not take — and a failure here is the card's, not the
		// swap's, so it is reported with the card's own words.
		if (!arrived.mounted) {
			const m = await io.mount();
			if (!m || m.ok === false) {
				return finish({ outcome: 'mountfailed', error: (m && m.error) || '' });
			}
			arrived = await io.look();
		}

		// Where the clips are configured to go is a path, and the hotplug
		// rules name a mount after the device. A card with no partition table
		// mounts as the whole disk under a different name, which resolves to
		// no directory at all — recording would fail with nothing obviously
		// wrong with the card.
		if (!arrived || !arrived.mounted) {
			return finish({ outcome: 'mountfailed', error: '' });
		}
		if (arrived.mountpoint !== was.mountpoint) {
			return finish({
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
		step(io, 'done');
		return done;
	}

	const api = { run: run, looksNew: looksNew };
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	if (typeof window !== 'undefined') window.MajesticSdSwap = api;
}());
