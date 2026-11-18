/**
 * Storage checks for the card's price records.
 *
 * The helpers are extracted from `client.js` verbatim (between the
 * `@storage-helpers` markers) and run against an in-memory `localStorage`
 * stand-in, so the record shape that keeps `$old → $new` alive across reloads
 * is exercised as shipped.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./client.js', import.meta.url), 'utf8');
const start = source.indexOf('/* @storage-helpers:start */');
const end = source.indexOf('/* @storage-helpers:end */');
assert.ok(start !== -1 && end > start, 'storage helper markers present');
const block = source.slice(start, end);

/** In-memory stand-in for the browser's localStorage. */
const store = new Map();
globalThis.localStorage = {
	getItem: (key) => (store.has(key) ? store.get(key) : null),
	setItem: (key, value) => { store.set(key, String(value)); },
	removeItem: (key) => { store.delete(key); },
};
const helpers = new Function(`const PRICE_CACHE_KEY = 'test:last-price';\n${block}\nreturn { priceKey, readPriceBook, readPriceRecord, writePriceRecord, clearPriceRecord };`)();

const results = [];
const check = (name, fn) => {
	try {
		fn();
		results.push(`ok   ${name}`);
	} catch (error) {
		results.push(`FAIL ${name}: ${String(error)}`);
		process.exitCode = 1;
	}
};

const A = { input: 0.098e-6, output: 0.294e-6, cacheRead: 0.00294e-6, discount: 0.51 };
const B = { input: 0.12e-6, output: 0.36e-6, cacheRead: 0.0036e-6, discount: 0 };

check('first sight has no record', () => {
	assert.equal(helpers.readPriceRecord('m/1', 'p/fp8'), undefined);
});
check('a written pair survives a fresh read', () => {
	helpers.writePriceRecord('m/1', 'p/fp8', { previous: A, current: B, changedAt: 11, at: 22 });
	const record = helpers.readPriceRecord('m/1', 'p/fp8');
	assert.deepEqual(record.previous, A);
	assert.deepEqual(record.current, B);
	assert.equal(record.changedAt, 11);
	assert.equal(record.at, 22);
});
check('records are isolated per model and pin', () => {
	helpers.writePriceRecord('m/2', 'p/fp8', { current: A, at: 1 });
	assert.equal(helpers.readPriceRecord('m/2', 'other/fp8'), undefined);
	assert.deepEqual(helpers.readPriceRecord('m/2', 'p/fp8').current, A);
});
check('an older flat record reads as current', () => {
	const raw = JSON.parse(store.get('test:last-price'));
	raw['m/old|p/fp8'] = { ...A, at: 7 };
	store.set('test:last-price', JSON.stringify(raw));
	const record = helpers.readPriceRecord('m/old', 'p/fp8');
	assert.deepEqual(record.current.input, A.input);
	assert.equal(record.previous, undefined);
});
check('clearing a record forgets only that endpoint', () => {
	helpers.writePriceRecord('m/clear', 'p/fp8', { previous: A, current: B, changedAt: 1, at: 2 });
	helpers.writePriceRecord('m/keep', 'p/fp8', { current: A, at: 1 });
	helpers.clearPriceRecord('m/clear', 'p/fp8');
	assert.equal(helpers.readPriceRecord('m/clear', 'p/fp8'), undefined);
	assert.deepEqual(helpers.readPriceRecord('m/keep', 'p/fp8').current, A);
});
check('unreadable storage degrades to empty', () => {
	store.set('test:last-price', '{not json');
	assert.deepEqual(helpers.readPriceBook(), {});
	assert.equal(helpers.readPriceRecord('m/1', 'p/fp8'), undefined);
	delete globalThis.localStorage.setItem;
	try {
		helpers.writePriceRecord('m/3', 'p/fp8', { current: A, at: 1 });
		results.push('ok   a refused write does not throw');
	} catch (error) {
		throw new Error(`write threw: ${String(error)}`);
	} finally {
		globalThis.localStorage.setItem = (key, value) => { store.set(key, String(value)); };
	}
});

console.log(results.join('\n'));
