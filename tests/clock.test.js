// Which clock the pages draw times on (www/a/main.js, mjHourCycle), #750.
//
// A decision table that renders a confident time whichever branch it takes:
// the wrong one is a page that looks fine and reads "5:47:07 PM" to someone
// who has never used a 12-hour clock. Each branch needs a browser in a given
// language AND a given time zone, which one machine does not reproduce on
// demand, so the table is checked here instead.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = path.join(__dirname, '..', 'www', 'a', 'main.js');
const noop = () => {};
const ctx = { window: { addEventListener: noop }, document: { addEventListener: noop }, console: console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
const cycle = ctx.mjHourCycle;

group('24-hour unless the reader plainly uses the other one');
for (const [locale, own, zone, want, why] of [
	['ru-RU', 'h23', 'Europe/Moscow', 'h23', 'a 24-hour language'],
	['en-GB', 'h23', 'Europe/London', 'h23', 'British English'],
	['en-US', 'h12', 'Europe/Moscow', 'h23', 'American English outside the US'],
	['en-US', 'h12', 'Asia/Shanghai', 'h23', '...anywhere outside it'],
	['en', 'h12', 'Europe/Berlin', 'h23', 'English with no region is the same default'],
	['en-US', 'h12', 'America/Argentina/Buenos_Aires', 'h23', 'the Americas are not the US'],
	['en-US', 'h12', 'America/Toronto', 'h23', 'nor is Canada'],
	['en-US', 'h12', 'America/New_York', 'h12', 'American English in the US'],
	['en-US', 'h12', 'America/Indiana/Indianapolis', 'h12', 'a zone a level deeper'],
	['en-US', 'h12', 'America/Kentucky/Louisville', 'h12', '...another'],
	['en-US', 'h12', 'Pacific/Honolulu', 'h12', 'Hawaii'],
	['en-US', 'h12', 'America/Puerto_Rico', 'h12', 'Puerto Rico'],
	['en', 'h12', 'US/Pacific', 'h12', 'an old-style US zone name'],
	['en-AU', 'h12', 'Europe/London', 'h12', 'a 12-hour English that is not the default one'],
	['ko-KR', 'h12', 'Asia/Seoul', 'h12', 'a 12-hour language'],
	['zh-Hant-TW', 'h12', 'Asia/Taipei', 'h12', 'with a script subtag'],
	['ja-JP', 'h11', 'Asia/Tokyo', 'h11', 'the language\'s own 12-hour cycle is kept'],
	['en-u-hc-h12', 'h12', 'Europe/Berlin', 'h12', 'a 12-hour clock the reader asked for by name'],
	['en-US-u-ca-gregory-hc-h11', 'h11', 'Europe/Berlin', 'h11', '...among other extensions'],
	['en-US-u-ca-gregory', 'h12', 'Europe/Berlin', 'h23', 'an extension that is not the hour cycle'],
	['', 'h12', 'America/New_York', 'h23', 'no locale to go by'],
	['en-US', 'h12', undefined, 'h23', 'no zone to go by'],
]) {
	const got = cycle(locale, own, zone);
	check(why + ': ' + [locale, own, zone].join(' ') + ' -> ' + want, got === want, got);
}

group('the options every time is drawn with');
{
	const o = ctx.mjTimeOpts({ timeZone: 'UTC', hour: '2-digit' });
	check('carry an hour cycle', /^h(11|12|23)$/.test(o.hourCycle), o.hourCycle);
	check('and the caller\'s own', o.timeZone === 'UTC' && o.hour === '2-digit', JSON.stringify(o));
	check('without keeping them for the next caller', !('timeZone' in ctx.mjTimeOpts()), JSON.stringify(ctx.mjTimeOpts()));
	// hourCycle, not hour12: some engines read hour12:false as h24 and draw
	// midnight as 24:00.
	const midnight = new Date(Date.UTC(2026, 10, 27, 0, 5, 0))
		.toLocaleTimeString('en-US', { hourCycle: 'h23', timeZone: 'UTC' });
	check('h23 draws American English midnight as 00', /^00:05:00$/.test(midnight), midnight);
}

done();
