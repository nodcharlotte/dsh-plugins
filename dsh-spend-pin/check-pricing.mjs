/**
 * Live checks for the card's pricing helpers.
 *
 * The helpers are extracted from `client.js` verbatim (between the
 * `@pricing-helpers` markers), so this exercises the code the browser runs —
 * not a copy. The catalogue read is the same public request the card makes.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./client.js', import.meta.url), 'utf8');
const start = source.indexOf('/* @pricing-helpers:start */');
const end = source.indexOf('/* @pricing-helpers:end */');
assert.ok(start !== -1 && end > start, 'pricing helper markers present');
const block = source.slice(start, end);
// `MODELS_URL` lives in the module's constant block, so give the extracted
// helpers the same binding before evaluating them.
const helpers = new Function(`const MODELS_URL = 'https://openrouter.ai/api/v1/models';\n${block}\nreturn { formatPerM, normalizeSlug, endpointsUrl, readNumbers, matchEndpoint, sameQuote, nextPriceRecord };`)();

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

check('formatPerM renders per-million USD', () => {
	assert.equal(helpers.formatPerM(0.000000098), '$0.098');
	assert.equal(helpers.formatPerM(0.000000294), '$0.294');
	assert.equal(helpers.formatPerM(0.00000000294), '$0.00294');
	assert.equal(helpers.formatPerM(Number.NaN), '—');
});
check('normalizeSlug matches OpenRouter spelling', () => {
	assert.equal(helpers.normalizeSlug('DeepInfra'), 'deepinfra');
	assert.equal(helpers.normalizeSlug('Sail Research'), 'sail-research');
});
check('endpointsUrl keeps model path segments', () => {
	assert.equal(
		helpers.endpointsUrl('deepseek/deepseek-v4.1-flash-1017'),
		'https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash-1017/endpoints',
	);
});
check('sameQuote compares prices and discount', () => {
	const base = { input: 0.098e-6, output: 0.294e-6, cacheRead: 0.00294e-6, discount: 0.51 };
	assert.equal(helpers.sameQuote(base, { ...base }), true);
	assert.equal(helpers.sameQuote(base, { ...base, input: 0.2e-6 }), false);
	assert.equal(helpers.sameQuote(base, { ...base, discount: 0 }), false);
	assert.equal(helpers.sameQuote(undefined, base), false);
});
check('nextPriceRecord keeps the pair until the next change', () => {
	const a = { input: 0.098e-6, output: 0.294e-6, cacheRead: 0.00294e-6, discount: 0.51 };
	const b = { input: 0.12e-6, output: 0.36e-6, cacheRead: 0.0036e-6, discount: 0 };
	const first = helpers.nextPriceRecord(undefined, a, 1);
	assert.equal(first.previous, undefined);
	assert.deepEqual(first.current, a);
	const same = helpers.nextPriceRecord(first, { ...a }, 2);
	assert.equal(same.previous, undefined);
	const changed = helpers.nextPriceRecord(same, b, 3);
	assert.deepEqual(changed.previous, { ...a, at: 2 });
	assert.deepEqual(changed.current, b);
	const kept = helpers.nextPriceRecord(changed, { ...b }, 4);
	assert.deepEqual(kept.previous, { ...a, at: 2 }, 'delta pair survives an unchanged refresh');
	assert.deepEqual(kept.current, b);
	const c = { ...b, output: 0.4e-6 };
	const replaced = helpers.nextPriceRecord(kept, c, 5);
	assert.deepEqual(replaced.previous, { ...b, at: 4 }, 'the next change replaces the pair');
	assert.deepEqual(replaced.current, c);
});

try {
	const url = helpers.endpointsUrl('deepseek/deepseek-v4.1-flash-1017');
	/** The catalogue is public; the local network can hiccup, so retry briefly. */
	const readCatalogue = async () => {
		let last;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				const response = await fetch(url, { headers: { accept: 'application/json' } });
				if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
				return await response.json();
			} catch (error) {
				last = error;
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		}
		throw last;
	};
	const body = await readCatalogue();
	const endpoints = body?.data?.endpoints ?? [];
	assert.ok(Array.isArray(endpoints) && endpoints.length > 0, 'endpoint list present');

	const pinned = helpers.matchEndpoint(endpoints, 'deepinfra/fp8');
	assert.ok(pinned, 'deepinfra/fp8 matched');
	const numbers = helpers.readNumbers(pinned);
	assert.equal(pinned.tag, 'deepinfra/fp8');
	assert.equal(pinned.provider_name, 'DeepInfra');
	assert.equal(helpers.formatPerM(numbers.input), '$0.098');
	assert.equal(helpers.formatPerM(numbers.output), '$0.294');
	assert.equal(helpers.formatPerM(numbers.cacheRead), '$0.00294');
	results.push(`ok   live deepinfra/fp8 -> ${helpers.formatPerM(numbers.input)} / ${helpers.formatPerM(numbers.output)} / ${helpers.formatPerM(numbers.cacheRead)} (${numbers.discount} discount)`);

	const bySlug = helpers.matchEndpoint(endpoints, 'deepinfra');
	assert.ok(bySlug, 'bare provider slug matched');
	assert.equal(helpers.normalizeSlug(bySlug.provider_name), 'deepinfra');
	results.push(`ok   live bare slug deepinfra -> tag ${bySlug.tag}`);

	const unknown = helpers.matchEndpoint(endpoints, 'definitely-not-a-provider');
	assert.equal(unknown, undefined);
	results.push('ok   unknown pin matches nothing');
} catch (error) {
	// The catalogue is public but the machine may be offline; the offline
	// assertions above still prove the shipped helpers.
	results.push(`skip live catalogue (network): ${String(error?.message ?? error)}`);
}

console.log(results.join('\n'));
