/**
 * Offline checks for the host half.
 *
 * Exercises the shipped pure functions, the fetch wrapper's rewrite and
 * suppression behaviour, and the event-driven cleanup when the OpenRouter
 * provider disappears. No network and no real harness are needed.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { apply, chatCompletionOf, injectPin, openRouterProviders, planRewrite, providerOfSseLine, providerRouting } from './index.js';

// Keep the plugin's durable state (spend ledger, rate snapshot) out of the real
// harness home: these checks must not read or overwrite the user's records.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-spend-pin-check-'));

const results = [];
/** Run one synchronous check and record its line. */
const check = (name, fn) => {
	try {
		fn();
		results.push(`ok   ${name}`);
	} catch (error) {
		results.push(`FAIL ${name}: ${String(error)}`);
		process.exitCode = 1;
	}
};
/** Run one asynchronous check and record its line. */
const checkAsync = async (name, fn) => {
	try {
		await fn();
		results.push(`ok   ${name}`);
	} catch (error) {
		results.push(`FAIL ${name}: ${String(error)}`);
		process.exitCode = 1;
	}
};

check('providerRouting maps endpoint tags', () => {
	assert.deepEqual(providerRouting('deepinfra/fp8'), {
		only: ['deepinfra'],
		quantizations: ['fp8'],
		allow_fallbacks: false,
	});
	assert.deepEqual(providerRouting('deepinfra'), { only: ['deepinfra'], allow_fallbacks: false });
	assert.deepEqual(providerRouting('deepinfra/fp8/priority'), {
		only: ['deepinfra/fp8/priority'],
		allow_fallbacks: false,
	});
	assert.equal(providerRouting('   '), undefined);
});

check('injectPin merges provider and preserves other fields', () => {
	const body = JSON.parse(injectPin(JSON.stringify({
		model: 'deepseek/deepseek-v4.1-flash-1017',
		messages: [],
		provider: { order: ['deepinfra'], allow_fallbacks: true },
	}), 'deepinfra/fp8'));
	assert.deepEqual(body.provider, {
		order: ['deepinfra'],
		only: ['deepinfra'],
		quantizations: ['fp8'],
		allow_fallbacks: false,
	});
	assert.deepEqual(body.messages, []);
	assert.equal(injectPin('not json', 'deepinfra/fp8'), undefined);
	assert.equal(injectPin(JSON.stringify({ messages: [] }), 'deepinfra/fp8'), undefined);
});

check('planRewrite rewrites only the pinned model', () => {
	const pins = { 'deepseek/deepseek-v4.1-flash-1017': 'deepinfra/fp8' };
	const init = {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'content-length': '999' },
		body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', messages: [] }),
	};
	const plan = planRewrite('https://openrouter.ai/api/v1/chat/completions', init, pins);
	assert.ok(plan !== undefined);
	const body = JSON.parse(plan.init.body);
	assert.deepEqual(body.provider, { only: ['deepinfra'], quantizations: ['fp8'], allow_fallbacks: false });
	assert.equal(plan.init.headers.get('content-type'), 'application/json');
	assert.equal(plan.init.headers.get('content-length'), null);
	assert.equal(plan.pin, 'deepinfra/fp8');
	assert.equal(planRewrite('https://openrouter.ai/api/v1/chat/completions', {
		...init,
		body: JSON.stringify({ model: 'other/model', messages: [] }),
	}, pins), undefined);
});

check('planRewrite leaves other requests alone', () => {
	const init = { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) };
	assert.equal(planRewrite('https://api.deepseek.com/chat/completions', init, { m: 'deepinfra/fp8' }), undefined);
	assert.equal(planRewrite('https://openrouter.ai/api/v1/models', { ...init, method: 'GET' }, { m: 'deepinfra/fp8' }), undefined);
	assert.equal(planRewrite('https://openrouter.ai/api/v1/chat/completions', { ...init, body: '{bad' }, { m: 'deepinfra/fp8' }), undefined);
	assert.equal(planRewrite('https://openrouter.ai/api/v1/chat/completions', init, {}), undefined);
	assert.equal(planRewrite('https://openrouter.ai.evil.example/v1', init, { m: 'deepinfra/fp8' }), undefined);
});

check('openRouterProviders recognises the catalog id, endpoints, and absence', () => {
	assert.deepEqual(openRouterProviders({ providers: { openrouter: { models: [] } } }), ['openrouter']);
	assert.deepEqual(openRouterProviders({ providers: { relay: { baseURL: 'https://openrouter.ai/api/v1' } } }), ['relay']);
	assert.deepEqual(openRouterProviders({ providers: { deepseek: { baseURL: 'https://api.deepseek.com' } } }), []);
	assert.deepEqual(openRouterProviders(undefined), []);
	assert.deepEqual(openRouterProviders({}), []);
});

check('chatCompletionOf recognises every OpenRouter chat call, pinned or not', () => {
	const init = { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) };
	assert.deepEqual(chatCompletionOf('https://openrouter.ai/api/v1/chat/completions', init), {
		url: 'https://openrouter.ai/api/v1/chat/completions',
		model: 'm',
	});
	assert.equal(chatCompletionOf('https://openrouter.ai/api/v1/models', { ...init, method: 'GET' }), undefined);
	assert.equal(chatCompletionOf('https://api.deepseek.com/chat/completions', init), undefined);
	assert.equal(chatCompletionOf('https://openrouter.ai/api/v1/chat/completions', { ...init, body: '{bad' }), undefined);
	assert.equal(chatCompletionOf('https://openrouter.ai/api/v1/chat/completions', { ...init, body: JSON.stringify({ messages: [] }) }), undefined);
});

check('providerOfSseLine reads the upstream provider', () => {
	assert.equal(providerOfSseLine('data: {"id":"gen-1","provider":"Cloudflare","choices":[]}'), 'Cloudflare');
	assert.equal(providerOfSseLine('data: [DONE]'), undefined);
	assert.equal(providerOfSseLine(': keep-alive'), undefined);
	assert.equal(providerOfSseLine('data: {bad'), undefined);
	assert.equal(providerOfSseLine('data: {"provider":""}'), undefined);
});

/**
 * A minimal host context: settings reads and writes are stubs, effects are
 * collected so the test can uninstall the fetch wrapper.
 * @param options - providers value and mutation recorder.
 * @returns `{ ctx, disposers, handlers }`.
 */
function stubContext(options) {
	const disposers = [];
	const handlers = new Map();
	const ctx = {
		logger: () => ({ info() {}, warn() {} }),
		effect: (fn) => {
			const dispose = fn();
			if (typeof dispose === 'function') disposers.push(dispose);
			return dispose;
		},
		on: (event, fn) => {
			handlers.set(event, fn);
		},
		get: (name) => (name === 'webServer' ? { register: () => () => {} } : undefined),
		webServer: { register: () => () => {} },
		sessionProjections: {
			register: () => () => {},
		},
		settings: {
			configure: () => () => {},
			describe: () => [{ ns: 'llm-pi-ai', value: options.providers }],
			mutate: async (ns, ops) => {
				options.mutations.push({ ns, ops });
				return { ok: true, value: { revision: 1 } };
			},
		},
	};
	return { ctx, disposers, handlers };
}

await checkAsync('apply installs the rewrite and unload restores fetch', async () => {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (input, init) => {
		calls.push({ input, init });
		return { ok: true, stub: true };
	};
	const options = { providers: { providers: { openrouter: {} } }, mutations: [] };
	const { ctx, disposers } = stubContext(options);
	try {
		apply(ctx, { pins: { 'deepseek/deepseek-v4.1-flash-1017': 'deepinfra/fp8' } });
		const response = await globalThis.fetch('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', messages: [] }),
		});
		assert.equal(response.stub, true);
		// The cost unit's own catalogue refresh also reaches this stub; count only
		// the chat requests this test makes.
		const chatRequests = () => calls.filter((call) => String(call.input).endsWith('/chat/completions'));
		assert.equal(chatRequests().length, 1);
		const body = JSON.parse(chatRequests()[0].init.body);
		assert.deepEqual(body.provider, { only: ['deepinfra'], quantizations: ['fp8'], allow_fallbacks: false });
		await globalThis.fetch('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'not-pinned/model' }),
		});
		assert.equal(JSON.parse(chatRequests()[1].init.body).provider, undefined);
	} finally {
		for (const dispose of disposers.reverse()) dispose();
		globalThis.fetch = original;
	}
	assert.equal(globalThis.fetch, original, 'unload restores the previous fetch');
});

await checkAsync('a provider deletion clears pins and suppresses stale ones', async () => {
	const original = globalThis.fetch;
	const seen = [];
	globalThis.fetch = async (input, init) => {
		seen.push({ input, init });
		return { ok: true };
	};
	const options = { providers: { providers: {} }, mutations: [] };
	const { ctx, disposers, handlers } = stubContext(options);
	try {
		apply(ctx, { pins: { 'deepseek/deepseek-v4.1-flash-1017': 'deepinfra/fp8' } });
		const revision = handlers.get('settings/document-updated');
		assert.equal(typeof revision, 'function');
		revision('llm-pi-ai');
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(options.mutations, [{
			ns: 'spend-pin',
			ops: [{ op: 'set', path: ['pins'], value: {} }],
		}]);
		// The table has not landed in this stub, so the old pin is still in
		// memory; suppression must keep it off the wire anyway.
		await globalThis.fetch('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017' }),
		});
		const chat = seen.filter((call) => String(call.input).endsWith('/chat/completions'));
		assert.equal(JSON.parse(chat[0].init.body).provider, undefined);
		// Another unrelated namespace push must not trigger cleanup.
		revision('something-else');
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(options.mutations.length, 1);
	} finally {
		for (const dispose of disposers.reverse()) dispose();
		globalThis.fetch = original;
	}
});

await checkAsync('a still-present provider leaves the pin table alone', async () => {
	const original = globalThis.fetch;
	globalThis.fetch = async () => ({ ok: true });
	const options = { providers: { providers: { openrouter: {} } }, mutations: [] };
	const { ctx, disposers, handlers } = stubContext(options);
	try {
		apply(ctx, { pins: { m: 'deepinfra/fp8' } });
		handlers.get('settings/document-updated')('llm-pi-ai');
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(options.mutations.length, 0);
	} finally {
		for (const dispose of disposers.reverse()) dispose();
		globalThis.fetch = original;
	}
});

await checkAsync('the wrapper records the observed provider and the route serves it', async () => {
	const original = globalThis.fetch;
	const handlers = new Map();
	const options = { providers: { providers: { openrouter: {} } }, mutations: [] };
	const { ctx, disposers } = stubContext(options);
	ctx.webServer = { register: (route) => { handlers.set(route.path, route.handler); return () => {}; } };
	globalThis.fetch = async (input) => {
		if (String(input).endsWith('/chat/completions')) {
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('data: {"id":"gen-1","provider":"Cloudflare"}\n\n'));
						controller.close();
					},
				}),
				{ status: 200, headers: { 'content-type': 'text/event-stream' } },
			);
		}
		return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
	};
	try {
		apply(ctx, { pins: {} });
		const upstream = handlers.get('/spend-pin/api/upstream');
		const price = handlers.get('/spend-pin/api/price');
		const spend = handlers.get('/spend-pin/api/spend');
		assert.equal(typeof upstream, 'function', 'the upstream route is registered');
		assert.equal(typeof price, 'function', 'the price route is registered');
		assert.equal(typeof spend, 'function', 'the spend route is registered');
		await globalThis.fetch('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', messages: [] }),
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		let status = 0;
		let headers = {};
		let body = '';
		upstream({ method: 'GET' }, {
			writeHead(code, next) { status = code; headers = next; },
			end(text) { body = text; },
		});
		assert.equal(status, 200);
		assert.equal(headers['cache-control'], 'no-store');
		const parsed = JSON.parse(body);
		assert.equal(parsed.models['deepseek/deepseek-v4.1-flash-1017'].provider, 'Cloudflare');
		assert.equal(typeof parsed.models['deepseek/deepseek-v4.1-flash-1017'].at, 'number');
	} finally {
		for (const dispose of disposers.reverse()) dispose();
		globalThis.fetch = original;
	}
});

await checkAsync('the price book prices a session ledger row', async () => {
	const original = globalThis.fetch;
	const handlers = new Map();
	const options = { providers: { providers: { openrouter: {} } }, mutations: [] };
	const { ctx, disposers } = stubContext(options);
	ctx.webServer = { register: (route) => { handlers.set(route.path, route.handler); return () => {}; } };
	globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
	const dir = join(process.env.DSH_HOME, 'storages', 'session-cost', 'spend');
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'session-test.json'), JSON.stringify({
		version: 1,
		messages: {
			m1: {
				currency: 'USD', provider: 'openrouter', model: 'm', turn: 1, before: 0,
				input: 1000, output: 500, cacheRead: 2000, cacheWrite: 0, cost: 0, unpriced: 1,
			},
		},
	}));
	try {
		apply(ctx, { pins: {} });
		const price = handlers.get('/spend-pin/api/price');
		const spend = handlers.get('/spend-pin/api/spend');
		// POST the per-token price.
		await new Promise((resolve) => {
			const req = Readable.from([Buffer.from(JSON.stringify({
				model: 'm', input: 0.000001, output: 0.000002, cacheRead: 0.0000001,
			}))]);
			req.method = 'POST';
			price(req, {
				writeHead() {},
				end() { resolve(); },
			});
		});
		// GET the session's USD reading.
		const body = await new Promise((resolve) => {
			spend({ method: 'GET', url: '/spend-pin/api/spend?sessions=session-test' }, {
				writeHead() {},
				end(text) { resolve(text); },
			});
		});
		const parsed = JSON.parse(body);
		const reading = parsed.sessions['session-test'];
		assert.equal(reading.USD.requests, 1);
		assert.equal(reading.USD.unpriced, 0);
		assert.ok(Math.abs(reading.USD.cost - 0.0022) < 1e-12, `cost ${String(reading.USD.cost)}`);
		assert.ok(Math.abs(reading.turns['1'].cost - 0.0022) < 1e-12);
		// The first read archived the amount. A later price change must not rewrite it.
		await new Promise((resolve) => {
			const req = Readable.from([Buffer.from(JSON.stringify({
				model: 'm', input: 0.000002, output: 0.000004, cacheRead: 0.0000002,
			}))]);
			req.method = 'POST';
			price(req, { writeHead() {}, end() { resolve(); } });
		});
		const body2 = await new Promise((resolve) => {
			spend({ method: 'GET', url: '/spend-pin/api/spend?sessions=session-test' }, {
				writeHead() {},
				end(text) { resolve(text); },
			});
		});
		const frozen = JSON.parse(body2).sessions['session-test'];
		assert.ok(Math.abs(frozen.USD.cost - 0.0022) < 1e-12, `frozen cost ${String(frozen.USD.cost)}`);
		const persisted = JSON.parse(readFileSync(join(dir, 'session-test.json'), 'utf8'));
		assert.ok(Math.abs(persisted.messages.m1.usd - 0.0022) < 1e-12, `archived ${String(persisted.messages.m1.usd)}`);
	} finally {
		for (const dispose of disposers.reverse()) dispose();
		globalThis.fetch = original;
	}
});

await checkAsync('a compaction summary is counted and priced into its turn', async () => {
	const original = globalThis.fetch;
	const options = { providers: { providers: { openrouter: {} } }, mutations: [] };
	const { ctx, disposers } = stubContext(options);
	ctx.webServer = { register: () => () => {} };
	let definition;
	ctx.sessionProjections = {
		register: (def) => {
			definition = def;
			return () => {};
		},
	};
	globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
	try {
		apply(ctx, { pins: {} });
		assert.ok(definition, 'the spend projection is registered');
		let state = definition.init({ id: 'session-compaction' }, 0);
		const now = Date.now();
		state = definition.apply(state, { type: 'turn/start', seq: 1, time: now, data: { turn: 2 } });
		state = definition.apply(state, {
			type: 'compaction/summary',
			seq: 2,
			time: now + 10,
			data: {
				compactionId: 'c1',
				provider: 'openrouter',
				model: 'm',
				usage: { inputTokens: 1000, outputTokens: 500 },
			},
		});
		const view = definition.wire.view(state);
		assert.equal(view.turns['2'].compactions, 1);
		assert.equal(view.USD.requests, 1);
		assert.equal(view.USD.unpriced, 1);
	} finally {
		for (const dispose of disposers.reverse()) dispose();
		globalThis.fetch = original;
	}
});

console.log(results.join('\n'));
