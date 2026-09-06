// mj-sources.js — what the camera's /api/v1/sources answer means.
//
// Every page that shows video makes the same three decisions from this payload:
// which sources can be watched, which stream of one of them, and what transport
// its codec implies. They are here rather than in each of preview-page.js,
// mj-preview.js and the Stream URLs panel so there is one copy to be right, and
// they are tested here because a wrong answer shows up as a picture — a black
// rectangle, or the wrong camera — which is what a human glance cannot catch.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const S = require(path.join(__dirname, '..', 'www', 'a', 'mj-sources.js'));

// The shape /api/v1/sources answers with. `flowing` is absent on an MJPEG
// stream on purpose — there are no parameter sets to report — and every fixture
// here keeps that, because treating a missing key as false is exactly the
// mistake that would hide every USB webcam.
function stream(subtype, codec, extra) {
	return Object.assign({
		id: subtype, subtype: subtype, codec: codec,
		configured: true, present: true, rtsp: true,
	}, extra || {});
}

const SENSOR = {
	camera: 0, kind: 'sensor', streams: [
		stream(0, 'h264', { id: 0, flowing: true, fps: 25, width: 1920, height: 1080 }),
		stream(1, 'h264', { id: 1, flowing: false, fps: 15, width: 640, height: 360 }),
		stream(2, 'mjpeg', { id: 2, fps: 5, rtsp: false }),
	],
};

const USB_MJPEG = {
	camera: 1, kind: 'external', streams: [
		stream(2, 'mjpeg', { id: 5, fps: 30, width: 1280, height: 720, rtsp: false }),
	],
};

const USB_H264 = {
	camera: 1, kind: 'external', streams: [
		stream(0, 'h264', { id: 3, flowing: true, fps: 30 }),
	],
};

group('one camera');
{
	check('a lone sensor is not a chooser',
		S.multi([SENSOR]) === false);
	check('all three of its streams are watchable',
		S.streams(SENSOR).length === 3);
	check('display order is main, sub, mjpeg',
		S.streams(SENSOR).map(s => s.subtype).join(',') === '0,1,2');
	check('an empty answer resolves to nothing, not to a guess',
		S.resolve([], null) === null);
	check('a malformed answer is an empty one',
		S.watchableSources(null).length === 0 && S.multi(undefined) === false);
}

group('what can be watched');
{
	// The distinction the endpoint exists to draw: configured says the operator
	// asked for it, present says it came up. A channel that failed to start is
	// worth SHOWING on the settings page and is not worth OFFERING as a picture.
	const failed = { camera: 0, kind: 'sensor', streams: [
		stream(0, 'h264', { present: false }),
		stream(1, 'h264'),
	] };
	check('a configured stream that never came up is not offered',
		S.streams(failed).map(s => s.subtype).join(',') === '1');

	// A camera whose channels are all down is not a source to watch, even
	// though it is a real camera the settings page has business with.
	const dark = { camera: 0, kind: 'sensor', streams: [
		stream(0, 'h264', { present: false }),
	] };
	check('a source with nothing up stays out of the picker',
		S.watchableSources([dark]).length === 0);

	// The one that would break every USB webcam if it were got wrong: an MJPEG
	// stream reports no `flowing` key at all, because it has no keyframes to
	// report. A gate that read that as false would hide the source entirely.
	check('a missing flowing key is not a dead stream',
		S.streams(USB_MJPEG).length === 1);
	check('and neither is flowing:false — the keyframe may be a moment away',
		S.streams(SENSOR).some(s => s.subtype === 1));

	// A codec from a build newer than this UI is left out rather than handed to
	// a player that will fail on it.
	const future = { camera: 0, kind: 'sensor', streams: [stream(0, 'av1')] };
	check('an unknown codec is not offered', S.streams(future).length === 0);
	check('and has no transport family', S.family(stream(0, 'av1')) === null);
}

group('transport family');
{
	check('h264 is a NAL stream', S.family(stream(0, 'h264')) === 'nal');
	check('h265 is a NAL stream', S.family(stream(0, 'h265')) === 'nal');
	check('mjpeg is multipart', S.family(stream(2, 'mjpeg')) === 'multipart');
	check('so is the on-board jpeg channel', S.family(stream(2, 'jpeg')) === 'multipart');
	check('nothing at all has no family', S.family(null) === null);
}

group('two sources');
{
	const both = [SENSOR, USB_MJPEG];
	check('a second source makes a chooser worth building', S.multi(both) === true);

	const r = S.resolve(both, { camera: 1, subtype: 2 });
	check('a remembered choice is honoured',
		r.source.camera === 1 && r.stream.id === 5);

	// A preference, not a promise. Someone who last watched the sub stream on
	// the sensor and then selects a webcam that only publishes MJPEG must get
	// the webcam's picture, not a blank panel.
	const fell = S.resolve(both, { camera: 1, subtype: 1 });
	check('an absent subtype falls back within the same source',
		fell.source.camera === 1 && fell.stream.subtype === 2);

	// The webcam has been unplugged since the choice was remembered.
	const gone = S.resolve([SENSOR], { camera: 1, subtype: 2 });
	check('a source that has gone falls back to the first one, not to nothing',
		gone.source.camera === 0);

	check('no remembered choice defaults to the sub stream of the first source',
		S.resolve(both, null).stream.subtype === 1);
}

group('a USB webcam that changes mode');
{
	// The same physical camera moves from stream 5 to stream 3 when its codec
	// setting changes, because the stream id is 3*camera + subtype. What is
	// remembered is the camera, so the choice survives the move — and the
	// transport follows the codec rather than the memory.
	const before = S.resolve([SENSOR, USB_MJPEG], { camera: 1, subtype: 2 });
	const after = S.resolve([SENSOR, USB_H264], { camera: 1, subtype: 2 });
	check('the source survives a codec change', after.source.camera === 1);
	check('the stream id moves with it',
		before.stream.id === 5 && after.stream.id === 3);
	check('and so does the transport family',
		S.family(before.stream) === 'multipart' && S.family(after.stream) === 'nal');
}

group('naming');
{
	const one = S.label(SENSOR, [SENSOR, USB_MJPEG]);
	check('a lone sensor needs no ordinal',
		one.key === 'mj_source_sensor' && one.ordinal === 0);
	check('an external source is named as one',
		S.label(USB_MJPEG, [SENSOR, USB_MJPEG]).key === 'mj_source_usb');

	// Rockchip's dual sensor: two sources, same kind. "Sensor" twice would name
	// neither, which is why the ordinal exists at all.
	const second = { camera: 1, kind: 'sensor', streams: [stream(0, 'h264')] };
	const pair = [SENSOR, second];
	check('two sensors are numbered',
		S.label(SENSOR, pair).ordinal === 1 && S.label(second, pair).ordinal === 2);
}

group('remembering a choice');
{
	check('a choice is camera and subtype, not arithmetic over both',
		S.key(USB_MJPEG, USB_MJPEG.streams[0]) === '1:2');
	check('and reads back', JSON.stringify(S.parse('1:2')) === '{"camera":1,"subtype":2}');
	check('junk in storage is no choice at all',
		S.parse('') === null && S.parse('x:y') === null && S.parse(null) === null);
}

done();
