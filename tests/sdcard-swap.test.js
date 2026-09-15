// The card-swap flow, whose middle step is a person taking a card out of a slot.
//
// Not reproducible on demand and silent when wrong, which is why it is here.
// Every branch below ends with the camera either recording or not, and the ways
// it ends up not recording are the quiet ones: a swap abandoned half way, a card
// that went back in and mounted somewhere else, an unmount that was refused
// after the recorder had already been stopped. None of those produce an error
// anybody sees — they produce a camera that looks fine and writes nothing.
//
// So the invariant these assert hardest is the one that is easiest to lose:
// ONCE THE RECORDER IS STOPPED, EVERY PATH OUT STARTS IT AGAIN.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');
const swap = require(path.join(__dirname, '..', 'www', 'a', 'sdcard-swap.js'));

// A slot, as the endpoint describes it. `cards` is what look() answers in
// sequence; the last entry repeats forever, which is how a wait times out.
//
// The mount state is MODELLED rather than canned, and that is not a detail.
// The first version of this returned whatever the fixture said regardless of
// what the engine had just done, so an unmounted card went on reporting itself
// mounted -- and the case where the swap gives up having already unmounted the
// card sailed through every assertion here while leaving a real camera with
// storage offline and the fragment counter frozen. A fixture that cannot
// contradict the code cannot test it.
function rig(cards, opts) {
    const o = opts || {};
    const log = [];
    let t = 0;
    let i = 0;
    let unmounted = false;
    const env = {
        log,
        io: {
            now: () => t,
            // Time only moves when the engine waits, so a two-minute budget
            // costs no real seconds and a timeout is reached deterministically.
            wait: (ms) => { t += ms; return Promise.resolve(); },
            stopped: () => !!(o.stopAfter && log.length >= o.stopAfter),
            onStep: (e) => log.push('step:' + e.step),
            look: () => {
                const c = cards[Math.min(i, cards.length - 1)];
                if (i < cards.length - 1) i++;
                log.push('look');
                // A card that has left takes the unmount with it: whatever
                // arrives next is mounted by the hotplug rules, not by us.
                if (!c.present) unmounted = false;
                const seen = Object.assign({}, c);
                if (unmounted && seen.present) seen.mounted = false;
                return o.lookThrows && log.filter((x) => x === 'look').length === o.lookThrows
                    ? Promise.reject(new Error('endpoint down'))
                    : Promise.resolve(seen);
            },
            standDown: () => {
                log.push('standDown');
                return o.standDownFails
                    ? Promise.reject(new Error('HTTP 404'))
                    : Promise.resolve();
            },
            resume: () => {
                log.push('resume');
                return o.resumeFails ? Promise.reject(new Error('HTTP 500')) : Promise.resolve();
            },
            unmount: () => {
                log.push('unmount');
                if (o.unmountFails) return Promise.resolve({ ok: false, error: 'busy' });
                unmounted = true;
                return Promise.resolve({ ok: true });
            },
            mount: () => {
                log.push('mount');
                if (o.mountFails) return Promise.resolve({ ok: false, error: 'no fs' });
                unmounted = false;
                return Promise.resolve({ ok: true });
            },
            reprobe: () => { log.push('reprobe'); return Promise.resolve({ ok: true }); },
        },
    };
    return env;
}

const A = { present: true, mounted: true, mountpoint: '/mnt/mmcblk0p1', serial: '0xAAA' };
const B = { present: true, mounted: true, mountpoint: '/mnt/mmcblk0p1', serial: '0xBBB' };
const EMPTY = { present: false };

function ran(log, what) { return log.indexOf(what) >= 0; }

async function main() {
    group('the swap that works');
    {
        const e = rig([A, A, EMPTY, EMPTY, B, B]);
        const r = await swap.run(e.io);
        check('it finishes', r.outcome === 'done', r.outcome);
        check('the recorder was stopped before the card was released',
            e.log.indexOf('standDown') < e.log.indexOf('unmount'), e.log.join(','));
        check('and started again at the end', ran(e.log, 'resume'), e.log.join(','));
        check('it said when the card was safe to remove',
            ran(e.log, 'step:remove'), e.log.join(','));
        check('a different card is not reported as the same one', !r.sameCard, String(r.sameCard));
    }

    group('once the recorder is stopped, every way out starts it again');
    {
        // The card never leaves the slot. Nothing is broken; the operator
        // changed their mind. Leaving it paused would be the worst outcome
        // here, because nothing looks wrong.
        const e = rig([A]);
        const r = await swap.run(e.io);
        check('a card that never came out ends the swap', r.outcome === 'stillthere', r.outcome);
        check('and recording is started again', ran(e.log, 'resume'), e.log.join(','));
        // The one that got away. Every path past the release has unmounted
        // the card, and only a card that ARRIVES is mounted by the hotplug
        // rules -- so giving up without putting this one back leaves the
        // recorder running with nowhere to write, forever. Measured on a
        // camera before it was fixed: records_state 3, counter frozen.
        check('and the card it unmounted is put back',
            ran(e.log, 'mount'), e.log.join(','));
        check('before the recorder is started, not after',
            e.log.indexOf('mount') < e.log.indexOf('resume'), e.log.join(','));
    }
    {
        const e = rig([A, A, EMPTY]);
        const r = await swap.run(e.io);
        check('a card that never went back in ends the swap',
            r.outcome === 'nonewcard', r.outcome);
        check('and recording is started again', ran(e.log, 'resume'), e.log.join(','));
    }
    {
        // Arrives unmounted -- the hotplug rules could not take it -- and the
        // explicit mount is refused too.
        const unmounted = { present: true, mounted: false, mountpoint: '/mnt/mmcblk0p1' };
        const e = rig([A, A, EMPTY, EMPTY, unmounted], { mountFails: true });
        const r = await swap.run(e.io);
        check('a card that will not mount ends the swap', r.outcome === 'mountfailed', r.outcome);
        check('and recording is started again', ran(e.log, 'resume'), e.log.join(','));
        check('the card was given its own words', r.error === 'no fs', r.error);
    }
    {
        const e = rig([A], { unmountFails: true });
        const r = await swap.run(e.io);
        check('an unmount the camera refuses ends the swap',
            r.outcome === 'unmountfailed', r.outcome);
        check('and recording is started again — nothing was taken away',
            ran(e.log, 'resume'), e.log.join(','));
        check('the card was never waited on', !ran(e.log, 'step:remove'), e.log.join(','));
    }
    {
        const e = rig([A, A, EMPTY, EMPTY, B], { stopAfter: 6 });
        const r = await swap.run(e.io);
        check('a swap somebody stops ends the swap',
            r.outcome === 'stopped' || r.outcome === 'stillthere', r.outcome);
        check('and recording is started again', ran(e.log, 'resume'), e.log.join(','));
    }

    group('the recorder that could not be stopped');
    {
        // A camera whose majestic has no such endpoint. Nothing has been done
        // to it, so nothing has to be undone -- and in particular the card
        // must NOT be unmounted, because the recorder is still writing to it.
        const e = rig([A], { standDownFails: true });
        const r = await swap.run(e.io);
        check('the swap refuses to start', r.outcome === 'pausefailed', r.outcome);
        check('the card is not unmounted underneath a live recorder',
            !ran(e.log, 'unmount'), e.log.join(','));
        check('and nothing is resumed, because nothing was paused',
            !ran(e.log, 'resume'), e.log.join(','));
    }

    group('a slot that never announces the new card');
    {
        // Card-detect is not wired on every board, so the card can be in and
        // unseen. One re-probe is worth trying before giving up.
        const e = rig([A, A, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY,
            EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY,
            EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY,
            EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY,
            EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY]);
        const r = await swap.run(e.io);
        check('the controller is asked to look again', ran(e.log, 'reprobe'), e.log.join(','));
        check('and the swap ends rather than waiting forever',
            r.outcome === 'nonewcard', r.outcome);
        check('with recording started again', ran(e.log, 'resume'), e.log.join(','));
    }

    group('the card that mounts somewhere else');
    {
        // A card with no partition table mounts as the whole disk, under a
        // different name. The recording path still points at the old one, so
        // the camera would record nothing with nothing obviously wrong.
        const elsewhere = {
            present: true, mounted: true, mountpoint: '/mnt/mmcblk0', serial: '0xBBB',
        };
        const e = rig([A, A, EMPTY, EMPTY, elsewhere]);
        const r = await swap.run(e.io);
        check('it is reported rather than left to fail silently',
            r.outcome === 'elsewhere', r.outcome);
        check('and names both places', r.mountpoint === '/mnt/mmcblk0' &&
            r.expected === '/mnt/mmcblk0p1', r.mountpoint + ' vs ' + r.expected);
        check('with recording started again', ran(e.log, 'resume'), e.log.join(','));
    }

    group('what it can and cannot tell about the card');
    {
        const e = rig([A, A, EMPTY, EMPTY, A]);
        const r = await swap.run(e.io);
        check('the same card going back in is noticed', r.sameCard === true, String(r.sameCard));
    }
    {
        // A kernel that reports no serial cannot answer this, and an unknown
        // must not become an accusation.
        const nos = { present: true, mounted: true, mountpoint: '/mnt/mmcblk0p1' };
        check('no serial means no claim either way',
            swap.looksNew(nos, nos) === true, 'accused on no evidence');
    }

    group('a resume the camera refuses');
    {
        // majestic resumes itself within ten minutes whatever happens here, so
        // this is worth reporting and not worth failing the swap over.
        const e = rig([A, A, EMPTY, EMPTY, B], { resumeFails: true });
        const r = await swap.run(e.io);
        check('the swap still reports what happened to the card',
            r.outcome === 'done', r.outcome);
        check('and says the resume did not land', r.resumeFailed === true,
            String(r.resumeFailed));
    }

    done();
}

main();
