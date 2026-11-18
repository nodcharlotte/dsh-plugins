/**
 * OpenRouter pinned-upstream host half.
 *
 * The Models page uses DSH's own provider editor; this plugin adds no provider
 * of its own. The only state it owns is the pin table — one OpenRouter endpoint
 * tag per model id — stored in this bundle's own settings namespace
 * (`spend-pin`):
 *
 *   pins:
 *     deepseek/deepseek-v4.1-flash-1017: deepinfra/fp8
 *
 * The pin deliberately stays OUT of the `llm-pi-ai` profile. The shipped
 * provider editor holds the revision it read when it opened, so a concurrent
 * write into the provider's own subtree makes its Apply fail as
 * `settings/conflict` until the card is reopened. A separate namespace has its
 * own revision and never touches that lock.
 *
 * `provider.only` / `quantizations` / `allow_fallbacks` are request-body
 * fields that `dsh-llm-pi-ai` withholds from configuration
 * (`COMPLETIONS_COMPAT_GATE`), so this half performs the one rewrite the
 * configuration plane cannot express: a matching outbound OpenRouter request
 * gains
 *
 *   "provider": { "only": ["deepinfra"], "quantizations": ["fp8"],
 *                 "allow_fallbacks": false }
 *
 * Only that shape is touched. The URL must be the OpenRouter host, the method
 * POST, the body a JSON object with a string `model`, and the pin table must
 * name that model. Every other request takes the original path unchanged.
 *
 * The rewrite hooks `globalThis.fetch` because pi-ai's OpenAI SDK resolves its
 * transport per request, so a global replacement reaches the next model call
 * without patching the adapter. The wrapper is idempotent and restored when the
 * plugin unloads.
 *
 * Deleting the whole OpenRouter provider removes the pins that belonged to it:
 * every `llm-pi-ai` settings push runs a cheap reconcile, and if no provider
 * points at OpenRouter any more, the pin table is cleared in one small write.
 * If that cleanup write fails, this process stops applying pins entirely rather
 * than letting a re-added provider inherit stale ones. There is intentionally no
 * startup check: a deletion performed while the harness was not running is not
 * retroactively discovered, which keeps the plugin off the startup path.
 *
 * @module @local/dsh-spend-pin
 */
import z from '@deepseek-ai/schemastery';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Services this half needs before it can run. */
export const inject = ['settings', 'sessionProjections', 'webServer'];

/** Loader row id; also this bundle's settings namespace. */
export const CONFIG_NS = 'spend-pin';

/** The settings namespace that owns pi-ai provider routes. */
export const PROVIDERS_NS = 'llm-pi-ai';

/** Read-only route that serves the page-lifetime upstream observations. */
export const UPSTREAM_ROUTE = '/spend-pin/api/upstream';
/** The boxes post the price they fetched here. */
export const UPSTREAM_PRICE_ROUTE = '/spend-pin/api/price';
/** The pill reads a session's USD amounts computed from that price book. */
export const UPSTREAM_SPEND_ROUTE = '/spend-pin/api/spend';

/** This bundle's own config: the pin table, live-editable by the Web client. */
export const Config = z.object({
	pins: z.dict(z.string()).volatile().default({}),
});

/** Hosts whose requests this wrapper may rewrite: OpenRouter itself. */
const OPENROUTER_HOST = /(^|\.)openrouter\.ai$/i;

/** Marks an installed wrapper so a duplicate load cannot stack interceptors. */
const WRAPPER_MARK = '__dshOpenrouterPin';

/**
 * Whether a string URL points at the OpenRouter host.
 *
 * @param value - absolute URL, typically an endpoint base or a request URL.
 * @returns whether its hostname is openrouter.ai or a subdomain.
 */
function isOpenRouterUrl(value) {
	try {
		return OPENROUTER_HOST.test(new URL(String(value)).hostname);
	} catch {
		return false;
	}
}

/**
 * Normalise a provider display name into OpenRouter's slug spelling.
 * @param name - e.g. `DeepInfra`.
 * @returns e.g. `deepinfra`.
 */
function providerSlug(name) {
	return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * List the configured provider routes that speak to OpenRouter.
 *
 * `id === 'openrouter'` covers the shipped catalog route even when its profile
 * carries no explicit endpoint (the adapter supplies the default base URL); any
 * other route counts when its profile names an `openrouter.ai` endpoint.
 *
 * @param value - the effective `llm-pi-ai` config value from `settings.describe`.
 * @returns provider ids, empty when the provider is gone.
 */
export function openRouterProviders(value) {
	const providers = value?.providers;
	if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return [];
	const found = [];
	for (const [id, profile] of Object.entries(providers)) {
		if (id === 'openrouter') {
			found.push(id);
			continue;
		}
		if (typeof profile?.baseURL === 'string' && isOpenRouterUrl(profile.baseURL)) found.push(id);
	}
	return found;
}

/**
 * Translate one pinned endpoint into OpenRouter's `provider` routing object.
 *
 * The value is an OpenRouter endpoint tag: `provider` alone, or
 * `provider/quantization`. The two-segment form is sent as the documented
 * `only` provider slug plus a `quantizations` filter, which restricts routing
 * to that provider's endpoints of that quantization. A deeper tag
 * (`provider/quantization/tier`, e.g. `deepinfra/fp8/priority`) is a service
 * tier only the endpoint tag itself may name, so it travels verbatim in `only`.
 *
 * @param pin - the endpoint tag the model row stored.
 * @returns the routing object to merge into the request body, or `undefined`
 * when the value names nothing.
 */
export function providerRouting(pin) {
	const text = String(pin).trim();
	if (text === '') return undefined;
	const segments = text.split('/').map((segment) => segment.trim()).filter((segment) => segment !== '');
	if (segments.length === 0) return undefined;
	if (segments.length >= 3) return { only: [segments.join('/')], allow_fallbacks: false };
	if (segments.length === 2) {
		return { only: [segments[0]], quantizations: [segments[1]], allow_fallbacks: false };
	}
	return { only: [segments[0]], allow_fallbacks: false };
}

/**
 * Merge one model's pin into a serialized request body.
 *
 * @param serialized - the request body as the OpenAI SDK serialized it.
 * @param pin - the pinned endpoint tag.
 * @returns the rewritten body, or `undefined` when the body is not a chat
 * request this wrapper can address.
 */
export function injectPin(serialized, pin) {
	let body;
	try {
		body = JSON.parse(serialized);
	} catch {
		return undefined;
	}
	if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
	if (typeof body.model !== 'string' || body.model === '') return undefined;
	const routing = providerRouting(pin);
	if (routing === undefined) return undefined;
	const current = body.provider !== null && typeof body.provider === 'object' && !Array.isArray(body.provider)
		? body.provider
		: {};
	body.provider = { ...current, ...routing };
	return JSON.stringify(body);
}

/**
 * Decide whether one fetch call is an OpenRouter model request to rewrite.
 *
 * @param input - the URL string or Request the caller passed to fetch.
 * @param init - the request init, when one was passed.
 * @param pins - model id -> endpoint tag.
 * @returns the rewrite to perform, or `undefined` when the call is left alone.
 */
export function planRewrite(input, init, pins) {
	try {
		const url = typeof input === 'string' ? input : input?.url;
		if (typeof url !== 'string' || !isOpenRouterUrl(url)) return undefined;
		const method = String(init?.method ?? (typeof input === 'string' ? 'GET' : input?.method) ?? 'GET').toUpperCase();
		if (method !== 'POST') return undefined;
		const serialized = init?.body;
		if (typeof serialized !== 'string') return undefined;
		let model;
		try {
			const body = JSON.parse(serialized);
			model = typeof body?.model === 'string' ? body.model : undefined;
		} catch {
			return undefined;
		}
		if (model === undefined || model === '') return undefined;
		const pin = pins !== null && typeof pins === 'object' ? pins[model] : undefined;
		if (typeof pin !== 'string' || pin.trim() === '') return undefined;
		const body = injectPin(serialized, pin);
		if (body === undefined) return undefined;
		const headers = new Headers(init?.headers);
		// The rewritten body has a different length; let fetch compute it again.
		headers.delete('content-length');
		headers.set('x-dsh-spend-pin', pin.trim());
		return { url, init: { ...init, method: 'POST', headers, body }, pin: pin.trim(), model };
	} catch {
		return undefined;
	}
}

/**
 * Identify one OpenRouter chat-completions call, whatever its pin state.
 *
 * The host half observes the response of every such call to learn which
 * upstream provider OpenRouter actually routed to, so this check must pass for
 * unpinned models too — `planRewrite` only speaks for pinned ones.
 *
 * @param input - the URL string or Request the caller passed to fetch.
 * @param init - the request init, when one was passed.
 * @returns the URL and model of a chat request, or undefined.
 */
export function chatCompletionOf(input, init) {
	try {
		const url = typeof input === 'string' ? input : input?.url;
		if (typeof url !== 'string' || !isOpenRouterUrl(url)) return undefined;
		if (!/\/chat\/completions\/?$/.test(new URL(url).pathname)) return undefined;
		const method = String(init?.method ?? (typeof input === 'string' ? 'GET' : input?.method) ?? 'GET').toUpperCase();
		if (method !== 'POST' || typeof init?.body !== 'string') return undefined;
		const body = JSON.parse(init.body);
		const model = typeof body?.model === 'string' ? body.model : undefined;
		return model === undefined || model === '' ? undefined : { url, model };
	} catch {
		return undefined;
	}
}

/**
 * Read the upstream provider out of one SSE `data:` line.
 *
 * OpenRouter stamps every streamed chunk with the provider's display name
 * (`"Cloudflare"`, `"DeepInfra"`, …); the first chunk already carries it, which
 * is why one read is enough.
 *
 * @param line - one line of the event stream.
 * @returns the provider name, or undefined when the line has none.
 */
export function providerOfSseLine(line) {
	const text = String(line).trim();
	if (!text.startsWith('data:')) return undefined;
	const raw = text.slice(5).trim();
	if (raw === '' || raw === '[DONE]') return undefined;
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed?.provider === 'string' && parsed.provider !== '' ? parsed.provider : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Host half: install the request rewrite and the provider-removal cleanup.
 *
 * @param ctx - the plugin context.
 * @param rawConfig - the row's validated config (`pins` is a live reference).
 */
export function apply(ctx, rawConfig) {
	const logger = ctx.logger?.('spend-pin');
	// Shared with the spend unit: the host-side USD accounting reads the rows
	// the projection wrote, so both halves must use one store instance.
	const spend = new SpendStore(join(dshHome(), 'storages', STATE_DIR, 'spend'), ctx.logger?.('session-cost'));
	const disposeSpend = applySpend(ctx, {}, spend);
	/**
	 * Per-token USD prices the settings row fetched, keyed by model. Fed only by
	 * the boxes on open/refresh; never written to disk. The spend route prices
	 * messages from this book, so the cost side performs no price lookup.
	 */
	const priceBook = new Map();
	/**
	 * Per-session prices the automatic path fetched, keyed `session|model`.
	 * Process lifetime only: a page refresh or a client-plugin reload keeps
	 * them (a half-finished conversation keeps its amount), while closing DSH
	 * drops them.
	 */
	const autoPrices = new Map();
	/** model -> provider the last response of each session showed. */
	const sessionUpstreams = new Map();
	/** Read the live pin table out of the volatile config reference. */
	const pinsOf = () => {
		const value = rawConfig?.pins;
		const plain = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
		return plain !== null && typeof plain === 'object' && !Array.isArray(plain) ? plain : {};
	};
	/** Whether pins may be applied right now (false after the provider vanished). */
	let allowed = true;
	/** Whether the provider was seen missing; stops a re-added provider inheriting its old pins. */
	let voided = false;

	// Our own config is plumbing, not a settings page. Without this the shell
	// would offer an auto-generated form for the raw pin table.
	ctx.effect(() => ctx.settings.configure({ auto: false }), 'spend-pin: no generated settings page');

	/**
	 * One cheap reconcile per `llm-pi-ai` settings push. When no provider points
	 * at OpenRouter any more, clear the pin table in a single write; if that
	 * write fails, stop applying pins for the rest of this process.
	 */
	const clearPins = () => {
		if (Object.keys(pinsOf()).length === 0) return;
		void ctx.settings
			.mutate(CONFIG_NS, [{ op: 'set', path: ['pins'], value: {} }])
			.catch((error) => logger?.warn?.(`pin cleanup failed: ${String(error)}`));
	};

	const reconcile = () => {
		try {
			const described = ctx.settings.describe({ redactSecrets: true });
			const entry = described.find((row) => row.ns === PROVIDERS_NS);
			// The adapter is not mounted (or is restarting): that is not evidence
			// that the user deleted their provider, so keep the pins untouched.
			if (entry === undefined) return;
			const present = openRouterProviders(entry.value).length > 0;
			if (!present) {
				voided = true;
				allowed = false;
				clearPins();
				return;
			}
			if (voided) {
				// The provider came back. Its old pins are only trustworthy once the
				// table is actually empty; if cleanup never succeeded, keep them off
				// this re-added provider and retry the write.
				if (Object.keys(pinsOf()).length > 0) {
					allowed = false;
					clearPins();
					return;
				}
				voided = false;
			}
			allowed = true;
		} catch (error) {
			logger?.warn?.(`pin cleanup check failed: ${String(error)}`);
		}
	};

	if (typeof ctx.on === 'function') {
		// Run after the settings service finishes its own describe: its
		// `document-updated` event fires from inside that loop, and reconciling
		// re-entrantly would read half-updated revision state.
		let scheduled = false;
		ctx.on('settings/document-updated', (ns) => {
			if (ns !== PROVIDERS_NS || scheduled) return;
			scheduled = true;
			queueMicrotask(() => {
				scheduled = false;
				reconcile();
			});
		});
	}

	/**
	 * The upstream provider OpenRouter actually routed each model to, as last
	 * seen on this process. Deliberately in memory only: the settings row shows
	 * it for the lifetime of one page, and a page refresh or a host restart
	 * starts empty. Nothing here is written to settings or to disk.
	 */
	const upstreams = new Map();

	/**
	 * Remember one observation. A repeat of the same provider only refreshes
	 * the timestamp; a different one replaces it. When the request named a
	 * harness session, the session-scoped map records it too.
	 * @param model - OpenRouter model id.
	 * @param provider - provider display name from the response.
	 * @param session - harness session id, or an empty string.
	 */
	const recordUpstream = (model, provider, session) => {
		if (typeof model !== 'string' || model === '' || typeof provider !== 'string' || provider === '') return;
		const at = Date.now();
		const current = upstreams.get(model);
		if (current === undefined || current.provider !== provider) {
			upstreams.set(model, { provider, at });
			if (upstreams.size > 256) {
				const oldest = upstreams.keys().next();
				if (oldest.done !== true) upstreams.delete(oldest.value);
			}
		} else {
			current.at = at;
		}
		if (typeof session !== 'string' || session === '') return;
		const per = sessionUpstreams.get(session) ?? new Map();
		per.set(model, { provider, at });
		sessionUpstreams.set(session, per);
		if (sessionUpstreams.size > 256) {
			const oldest = sessionUpstreams.keys().next();
			if (oldest.done !== true) sessionUpstreams.delete(oldest.value);
		}
	};

	/**
	 * Read the first provider name out of a cloned event stream, then stop.
	 * @param response - the cloned response to consume.
	 * @param model - OpenRouter model id.
	 * @param session - harness session id, or an empty string.
	 * @returns a promise that resolves once the copy is released.
	 */
	const readProvider = async (response, model, session) => {
		const body = response.body;
		if (body === null || body === undefined) return;
		const reader = body.getReader();
		const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, 30_000);
		const decoder = new TextDecoder();
		let buffer = '';
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				for (;;) {
					const index = buffer.indexOf('\n');
					if (index === -1) break;
					const line = buffer.slice(0, index);
					buffer = buffer.slice(index + 1);
					const provider = providerOfSseLine(line);
					if (provider !== undefined) {
						recordUpstream(model, provider, session);
						return;
					}
				}
				if (buffer.length > 1_000_000) return;
			}
		} catch {
			/* an aborted or malformed copy is not our business */
		} finally {
			clearTimeout(timer);
			await reader.cancel().catch(() => {});
		}
	};

	/**
	 * Learn one response's upstream provider without touching the body the
	 * caller receives: a clone is sniffed, the original flows on untouched.
	 * @param response - the fetch response.
	 * @param model - OpenRouter model id.
	 * @param session - harness session id, or an empty string.
	 */
	const observeUpstream = (response, model, session) => {
		try {
			const type = String(response.headers.get('content-type') ?? '').toLowerCase();
			if (type.includes('text/event-stream')) {
				void readProvider(response.clone(), model, session);
				return;
			}
			if (type.includes('application/json')) {
				void response.clone().json()
					.then((body) => recordUpstream(model, body?.provider, session))
					.catch(() => {});
			}
		} catch {
			/* observation must never take a request down */
		}
	};

	/**
	 * Read one small JSON request body.
	 * @param req - the incoming request.
	 * @returns the parsed value, or undefined when unreadable or oversized.
	 */
	const readJsonBody = (req) => new Promise((resolve) => {
		const chunks = [];
		let size = 0;
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > 64 * 1024) {
				finish(undefined);
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			try {
				finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch {
				finish(undefined);
			}
		});
		req.on('error', () => finish(undefined));
	});

	/**
	 * Send one JSON response.
	 * @param res - the server response.
	 * @param status - HTTP status.
	 * @param value - JSON value.
	 */
	const sendJson = (res, status, value) => {
		res.writeHead(status, {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
		});
		res.end(`${JSON.stringify(value)}\n`);
	};

	/**
	 * The USD reading of one session's spend ledger. A row is priced **once**,
	 * the first time a price for its model is known, and the amount is written
	 * back into the row (`usd`). Every later read returns that archived amount,
	 * so a later price change never rewrites history.
	 *
	 * @param sessionId - session id.
	 * @returns `{ USD, before, turns, models }`.
	 */
	const usdOfSession = (sessionId) => {
		const total = { cost: 0, requests: 0, unpriced: 0 };
		const before = { cost: 0, requests: 0, unpriced: 0 };
		const turns = {};
		const models = new Map();
		const messages = spend.book(sessionId).messages ?? {};
		let archived = 0;
		for (const [messageId, row] of Object.entries(messages)) {
			if (row === null || typeof row !== 'object' || row.currency !== 'USD') continue;
			const hasTokens = typeof row.input === 'number' || typeof row.output === 'number'
				|| typeof row.cacheRead === 'number' || typeof row.cacheWrite === 'number';
			let cost = 0;
			let unpriced = 0;
			if (typeof row.usd === 'number' && Number.isFinite(row.usd)) {
				// Already archived: this is the number the user saw when it was first computed.
				cost = row.usd;
			} else if (hasTokens) {
				const price = autoPrices.get(`${sessionId}|${String(row.model ?? '')}`) ?? priceBook.get(row.model);
				if (price !== undefined) {
					cost = number(row.input) * price.input
						+ number(row.output) * price.output
						+ number(row.cacheRead) * price.cacheRead
						+ number(row.cacheWrite) * price.cacheWrite;
					row.usd = cost;
					row.usdAt = Date.now();
					row.unpriced = 0;
					spend.write(sessionId, messageId, row);
					archived += 1;
				} else {
					unpriced = 1;
				}
			} else if (typeof row.cost === 'number') {
				cost = row.cost;
				unpriced = number(row.unpriced) > 0 ? 1 : 0;
			} else {
				unpriced = 1;
			}
			if (row.before === 1) {
				before.cost += cost;
				before.requests += 1;
				before.unpriced += unpriced;
				continue;
			}
			total.cost += cost;
			total.requests += 1;
			total.unpriced += unpriced;
			const turnKey = typeof row.turn === 'number' ? String(row.turn) : undefined;
			if (turnKey !== undefined) {
				const turn = turns[turnKey] ?? { cost: 0, requests: 0, unpriced: 0 };
				turn.cost += cost;
				turn.requests += 1;
				turn.unpriced += unpriced;
				turns[turnKey] = turn;
			}
			const modelKey = `${String(row.provider ?? 'openrouter')}\u0000${String(row.model ?? '')}`;
			const line = models.get(modelKey) ?? {
				provider: String(row.provider ?? 'openrouter'),
				model: String(row.model ?? ''),
				currency: 'USD',
				cost: 0,
				requests: 0,
				unpriced: 0,
			};
			line.cost += cost;
			line.requests += 1;
			line.unpriced += unpriced;
			models.set(modelKey, line);
		}
		if (archived > 0) spend.flush();
		return { USD: total, before, turns, models: [...models.values()] };
	};

	/** Register the read-only routes the settings rows and spend pill use. */
	const registerRoutes = () => {
		const webServer = ctx.webServer;
		if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return () => {};
		const disposers = [];
		disposers.push(webServer.register({
			kind: 'exact',
			path: UPSTREAM_ROUTE,
			handler: (req, res) => {
				if (req.method !== 'GET') {
					res.writeHead(405, { allow: 'GET' });
					res.end();
					return;
				}
				let url;
				try {
					url = new URL(req.url ?? '/', 'http://localhost');
				} catch {
					sendJson(res, 400, { ok: false, error: 'bad url' });
					return;
				}
				const ids = String(url.searchParams.get('sessions') ?? '')
					.split(',')
					.map((id) => id.trim())
					.filter((id) => id !== '')
					.slice(0, 50);
				if (ids.length > 0) {
					const pins = pinsOf();
					const sessions = {};
					for (const id of ids) {
						const models = {};
						for (const [model, info] of sessionUpstreams.get(id) ?? []) {
							models[model] = {
								provider: info.provider,
								at: info.at,
								pinned: typeof pins[model] === 'string' && pins[model] !== '',
								priced: autoPrices.has(`${id}|${model}`) || priceBook.has(model),
							};
						}
						sessions[id] = { models };
					}
					sendJson(res, 200, { version: 1, sessions });
					return;
				}
				sendJson(res, 200, { version: 1, models: Object.fromEntries(upstreams) });
			},
		}));
		disposers.push(webServer.register({
			kind: 'exact',
			path: UPSTREAM_PRICE_ROUTE,
			handler: (req, res) => {
				if (req.method !== 'POST') {
					res.writeHead(405, { allow: 'POST' });
					res.end();
					return;
				}
				void readJsonBody(req).then((body) => {
					const model = typeof body?.model === 'string' ? body.model.trim() : '';
					const input = Number(body?.input);
					const output = Number(body?.output);
					const cacheRead = Number(body?.cacheRead);
					const cacheWrite = Number(body?.cacheWrite ?? 0);
					const valid = model !== ''
						&& [input, output, cacheRead, cacheWrite].every((value) => Number.isFinite(value) && value >= 0);
					if (!valid) {
						sendJson(res, 400, { ok: false, error: 'invalid price' });
						return;
					}
					const rates = { input, output, cacheRead, cacheWrite };
					const scope = body?.scope === 'session' ? 'session' : 'global';
					if (scope === 'session') {
						const session = typeof body?.session === 'string' ? body.session : '';
						if (session === '') {
							sendJson(res, 400, { ok: false, error: 'session price needs a session' });
							return;
						}
						autoPrices.set(`${session}|${model}`, rates);
						if (autoPrices.size > 512) {
							const oldest = autoPrices.keys().next();
							if (oldest.done !== true) autoPrices.delete(oldest.value);
						}
					} else {
						priceBook.set(model, rates);
					}
					sendJson(res, 200, { ok: true, model, scope });
				});
			},
		}));
		disposers.push(webServer.register({
			kind: 'exact',
			path: UPSTREAM_SPEND_ROUTE,
			handler: (req, res) => {
				if (req.method !== 'GET') {
					res.writeHead(405, { allow: 'GET' });
					res.end();
					return;
				}
				let url;
				try {
					url = new URL(req.url ?? '/', 'http://localhost');
				} catch {
					sendJson(res, 400, { ok: false, error: 'bad url' });
					return;
				}
				const ids = String(url.searchParams.get('sessions') ?? '')
					.split(',')
					.map((id) => id.trim())
					.filter((id) => id !== '')
					.slice(0, 50);
				const sessions = {};
				for (const id of ids) {
					try {
						sessions[id] = usdOfSession(id);
					} catch {
						sessions[id] = { USD: { cost: 0, requests: 0, unpriced: 0 }, before: { cost: 0, requests: 0, unpriced: 0 }, turns: {}, models: [] };
					}
				}
				sendJson(res, 200, { version: 1, sessions });
			},
		}));
		return () => {
			for (const dispose of disposers) dispose();
		};
	};
	if (typeof ctx.effect === 'function') ctx.effect(registerRoutes);
	else registerRoutes();

	/**
	 * Fetch every pinned endpoint's price once, in parallel, at host start. The
	 * settings box is not involved: this only seeds the price book so a pinned
	 * model is not priced from yesterday's number before its row is opened.
	 */
	const seedPinnedPrices = async () => {
		const entries = Object.entries(pinsOf()).filter(([, tag]) => typeof tag === 'string' && tag.trim() !== '');
		if (entries.length === 0) return;
		/** One GET with a bounded timeout and a couple of retries (Cloudflare is flaky). */
		const readCatalogue = async (url) => {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				try {
					const response = await fetch(url, {
						headers: { accept: 'application/json' },
						signal: AbortSignal.timeout(20_000),
					});
					if (response.ok) return response;
				} catch {
					/* retry */
				}
				await new Promise((resolve) => setTimeout(resolve, 2000));
			}
			return undefined;
		};
		await Promise.allSettled(entries.map(async ([model, tag]) => {
			try {
				const path = String(model).split('/').map((part) => encodeURIComponent(part)).join('/');
				const response = await readCatalogue(`https://openrouter.ai/api/v1/models/${path}/endpoints`);
				if (response === undefined) return;
				const body = await response.json();
				const endpoints = Array.isArray(body?.data?.endpoints) ? body.data.endpoints : [];
				const text = String(tag).trim();
				const endpoint = endpoints.find((row) => row?.tag === text)
					?? endpoints.find((row) => typeof row?.provider_name === 'string'
						&& providerSlug(row.provider_name) === providerSlug(text.split('/')[0]));
				const pricing = endpoint?.pricing;
				if (pricing === undefined) return;
				priceBook.set(model, {
					input: Number(pricing.prompt),
					output: Number(pricing.completion),
					cacheRead: Number(pricing.input_cache_read),
					cacheWrite: Number(pricing.input_cache_write ?? 0),
				});
				logger?.info?.(`startup price: ${model} @ ${String(endpoint.tag ?? text)}`);
			} catch (error) {
				logger?.warn?.(`startup pinned price failed for ${model}: ${String(error)}`);
			}
		}));
	};
	void seedPinnedPrices();

	const original = globalThis.fetch;
	if (typeof original !== 'function') {
		logger?.warn?.('global fetch is unavailable; OpenRouter pins stay unapplied');
		return disposeSpend;
	}
	if (original[WRAPPER_MARK] === true) {
		logger?.info?.('fetch interceptor already installed; skipping the duplicate');
		return disposeSpend;
	}

	/** Endpoint tags already reported, so one line per distinct pin+model. */
	const reported = new Set();

	/**
	 * Read the harness session id pi-ai puts on an OpenRouter request.
	 * @param init - the request init.
	 * @returns the id, or an empty string when absent.
	 */
	const sessionOfInit = (init) => {
		try {
			const value = new Headers(init?.headers).get('x-session-id');
			return typeof value === 'string' ? value.trim() : '';
		} catch {
			return '';
		}
	};

	const wrapped = async (input, init) => {
		const chat = chatCompletionOf(input, init);
		const session = chat === undefined ? '' : sessionOfInit(init);
		const plan = allowed && chat !== undefined ? planRewrite(input, init, pinsOf()) : undefined;
		let response;
		if (plan !== undefined) {
			try {
				const key = `${plan.model} -> ${plan.pin}`;
				if (!reported.has(key)) {
					reported.add(key);
					logger?.info?.(`routing OpenRouter model "${plan.model}" to "${plan.pin}"`);
				}
				response = await original(plan.url, plan.init);
			} catch (error) {
				// A rewrite must never take a request down with it: the caller expects
				// the provider error path, not a wrapper exception.
				logger?.warn?.(`rewrite failed, sending the original request: ${String(error)}`);
				response = await original(input, init);
			}
		} else {
			response = await original(input, init);
		}
		if (chat !== undefined) observeUpstream(response, chat.model, session);
		return response;
	};
	wrapped[WRAPPER_MARK] = true;

	const restore = () => {
		if (globalThis.fetch === wrapped) globalThis.fetch = original;
	};

	const install = () => {
		globalThis.fetch = wrapped;
		if (globalThis.fetch !== wrapped) {
			logger?.warn?.('global fetch refused the interceptor; pins stay unapplied');
			return () => {};
		}
		logger?.info?.('fetch interceptor installed');
		return restore;
	};

	if (typeof ctx.effect === 'function') {
		ctx.effect(install);
		return disposeSpend;
	}
	const disposePin = install();
	return () => {
		disposePin?.();
		disposeSpend?.();
	};
}


/**
 * Session spend (host half).
 *
 * Folds the one usage-bearing durable event (`assistant/message`) into a
 * per-session amount, in the currency the producing provider actually bills:
 *
 *   - `deepseek-official`  -> CNY, DeepSeek's published peak / off-peak rates
 *                             (Beijing time, peak = 1x, off-peak = 0.5x)
 *   - everything else      -> USD, OpenRouter's live per-model rates
 *
 * The fold is a `sessionProjections` unit, so the value is computed once,
 * checkpointed with the other projections, and served to the Client through
 * its `wire.view` (read in the browser with `useProjection('sessionSpend')`).
 *
 *
 * @module @local/dsh-session-cost
 */

/** Default rates. DeepSeek's are CNY per 1e6 tokens, from api-docs.deepseek.com. */
const DEFAULTS = {
	/** Off-peak price as a fraction of the peak price (DeepSeek publishes exactly one half). */
	offPeakMultiplier: 0.5,
	/** DeepSeek peak windows in Beijing time, `HH:MM`..`HH:MM`, Monday through Friday. */
	peakWindows: [['09:00', '12:00'], ['14:00', '18:00']],
	/** DeepSeek `deepseek-flash` peak rates, CNY per 1e6 tokens. */
	deepseek: {
		cacheHit: 0.04,
		cacheMiss: 2,
		output: 8,
		cacheWriteIsMiss: false,
	},
	/** Hours between OpenRouter catalog refreshes. */
	ratesRefreshHours: 24,
	/** Per-model USD overrides, keyed by OpenRouter model id. */
	openrouterModels: {},
};

/** Where the durable ledger and the OpenRouter rate snapshot live. */
const STATE_DIR = 'session-cost';
const LEDGER_FILE = 'ledger.json';
const RATES_FILE = 'openrouter-rates.json';
/** Pinned endpoint tags only. Quotes are transient and never written down. */
const PINS_FILE = 'spend-pins.json';
/** Outgoing header the pin plugin puts on a pinned request, read before it strips it. */
const PIN_HEADER = 'x-dsh-spend-pin';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

/** Currency of each provider route; anything unlisted is billed in USD. */
const PROVIDER_CURRENCY = {
	'deepseek-official': 'CNY',
	'deepseek-account': 'CNY',
};

const HOUR_MS = 60 * 60 * 1000;

/**
 * Resolve the harness home the same way the launcher does.
 * @returns absolute DSH home directory.
 */
function dshHome() {
	const configured = process.env.DSH_HOME;
	if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
	const profile = process.env.DSH_PROFILE_DIR;
	if (typeof profile === 'string' && profile.trim() !== '') return dirname(dirname(profile.trim()));
	const userProfile = process.env.USERPROFILE ?? process.env.HOME ?? '.';
	return join(userProfile, '.dsh');
}

/**
 * Merge one user-supplied sub-object over its defaults, ignoring junk.
 * @param base - default object.
 * @param given - user config value.
 * @returns a fresh merged object.
 */
function merge(base, given) {
	const out = { ...base };
	if (given === null || typeof given !== 'object' || Array.isArray(given)) return out;
	for (const [key, value] of Object.entries(given)) {
		if (value === undefined || value === null) continue;
		const previous = out[key];
		if (previous !== null && typeof previous === 'object' && !Array.isArray(previous)
			&& typeof value === 'object' && !Array.isArray(value)) {
			out[key] = merge(previous, value);
		} else {
			out[key] = value;
		}
	}
	return out;
}

/**
 * Validate the row's `config` into the shape the plugin actually uses.
 * @param given - raw config from the profile patch.
 * @returns validated configuration.
 */
function resolveConfig(given) {
	const config = merge(DEFAULTS, given);
	const numbers = ['offPeakMultiplier', 'ratesRefreshHours'];
	for (const key of numbers) {
		if (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] <= 0) {
			throw new Error(`session-cost: ${key} must be a positive number`);
		}
	}
	for (const key of ['cacheHit', 'cacheMiss', 'output']) {
		if (typeof config.deepseek[key] !== 'number' || !Number.isFinite(config.deepseek[key]) || config.deepseek[key] < 0) {
			throw new Error(`session-cost: deepseek.${key} must be a non-negative number`);
		}
	}
	if (!Array.isArray(config.peakWindows)) throw new Error('session-cost: peakWindows must be an array of [start, end] pairs');
	for (const window of config.peakWindows) {
		if (!Array.isArray(window) || window.length !== 2 || !window.every((edge) => typeof edge === 'string' && /^\d{1,2}:\d{2}$/.test(edge))) {
			throw new Error(`session-cost: peak window ${JSON.stringify(window)} must be ["HH:MM", "HH:MM"]`);
		}
	}
	return config;
}

/**
 * Parse `HH:MM` into minutes past midnight.
 * @param text - `HH:MM`.
 * @returns minutes past midnight.
 */
function minutesOfDay(text) {
	const [hours, minutes] = text.split(':');
	return Number(hours) * 60 + Number(minutes);
}

/**
 * Whether an instant falls in DeepSeek's peak window.
 *
 * Peak is Beijing time (UTC+8) Monday through Friday, inside one of the
 * configured windows. Everything else is off-peak, which DeepSeek prices at
 * exactly half. Chinese statutory holidays are not modelled: they read as peak
 * here, so the estimate runs slightly high on those days and the daily
 * reconciliation corrects it.
 *
 * @param timeMs - event time, Unix epoch milliseconds.
 * @param config - resolved configuration.
 * @returns whether the instant is peak.
 */
function isPeak(timeMs, config) {
	const beijing = new Date(timeMs + 8 * HOUR_MS);
	const weekday = beijing.getUTCDay();
	if (weekday === 0 || weekday === 6) return false;
	const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
	return config.peakWindows.some(([start, end]) => minutes >= minutesOfDay(start) && minutes < minutesOfDay(end));
}

/**
 * GET a JSON document.
 * @param url - absolute URL.
 * @param headers - request headers.
 * @returns parsed JSON body.
 */
async function getJson(url, headers = {}) {
	const response = await fetch(url, { headers: { accept: 'application/json', ...headers } });
	const text = await response.text();
	if (!response.ok) throw new Error(`HTTP ${String(response.status)}: ${text.slice(0, 300)}`);
	return JSON.parse(text);
}

/**
 * The spend ledger: money computed **once per message**, then read back verbatim.
 *
 * This file is the point of the whole design. A projection state is transient —
 * the registry drops it when its `stateVersion` changes or the cache is evicted
 * — so a number derivable only from "today's prices" changes under the user's
 * feet. Here each `assistant/message` is priced exactly once, keyed by its own
 * id, and every later read returns that same amount no matter what the price
 * list says now. A re-fold therefore reproduces the history instead of
 * recomputing it.
 */
class SpendStore {
	/**
	 * @param root - directory holding one file per session.
	 * @param logger - optional logger.
	 */
	constructor(root, logger) {
		this.root = root;
		this.logger = logger;
		/** session id -> { messages: { messageId: row } } */
		this.books = new Map();
		this.dirty = new Set();
		this.timer = undefined;
	}

	/**
	 * @param sessionId - session id.
	 * @returns the session's book, loaded on first use.
	 */
	book(sessionId) {
		const cached = this.books.get(sessionId);
		if (cached !== undefined) return cached;
		let book = { version: 1, messages: {} };
		try {
			const parsed = JSON.parse(readFileSync(this.fileOf(sessionId), 'utf8'));
			if (parsed !== null && typeof parsed === 'object' && parsed.messages !== null && typeof parsed.messages === 'object') {
				book = { version: 1, messages: parsed.messages };
			}
		} catch {
			/* first run for this session */
		}
		this.books.set(sessionId, book);
		return book;
	}

	/**
	 * @param sessionId - session id.
	 * @returns that session's book path.
	 */
	fileOf(sessionId) {
		return join(this.root, `${String(sessionId).replace(/[^\w.-]/g, '_')}.json`);
	}

	/**
	 * The amount already computed for one message.
	 * @param sessionId - session id.
	 * @param messageId - assistant message id.
	 * @returns `{ cost, unpriced }`, or undefined when never priced.
	 */
	read(sessionId, messageId) {
		if (sessionId === '' || messageId === '') return undefined;
		return this.book(sessionId).messages?.[messageId];
	}

	/**
	 * Record one message's amount and queue a debounced flush.
	 * @param sessionId - session id.
	 * @param messageId - assistant message id.
	 * @param row - `{ cost, unpriced }`.
	 */
	write(sessionId, messageId, row) {
		if (sessionId === '' || messageId === '') return;
		this.book(sessionId).messages[messageId] = row;
		this.dirty.add(sessionId);
		if (this.timer === undefined) {
			this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 2000);
			this.timer.unref?.();
		}
	}

	/** Persist every book changed since the last flush. */
	flush() {
		for (const sessionId of this.dirty) {
			const book = this.books.get(sessionId);
			if (book === undefined) continue;
			try {
				mkdirSync(this.root, { recursive: true });
				const path = this.fileOf(sessionId);
				writeFileSync(`${path}.tmp`, `${JSON.stringify(book)}\n`, 'utf8');
				renameSync(`${path}.tmp`, path);
			} catch (error) {
				this.logger?.warn?.(`could not persist the spend ledger: ${String(error)}`);
			}
		}
		this.dirty.clear();
	}
}

/**
 * The pinned endpoint each model is bound to, and only that.
 *
 * A quote is a **transient** reading: it is fetched for the turn being priced,
 * used once, and dropped. Nothing about a price is written down here — the money
 * that results from it is frozen in the spend ledger instead, so a later price
 * can never move an amount that has already been shown.
 */
class PinRegistry {
	/**
	 * @param path - pins file path (endpoint tags only, never prices).
	 * @param logger - optional logger.
	 */
	constructor(path, logger) {
		this.path = path;
		this.logger = logger;
		this.data = { version: 1, pins: {} };
		/**
		 * The single quote slot that pricing reads, and the one fetched during the
		 * current turn waiting to take its place. Keeping exactly one of each makes
		 * a turn's pricing deterministic: the quote never changes mid-turn.
		 */
		this.current = new Map();
		this.pending = new Map();
		this.load();
	}

	/** Read the recorded pins. */
	load() {
		try {
			const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
			if (parsed !== null && typeof parsed === 'object' && parsed.pins !== null && typeof parsed.pins === 'object') {
				this.data.pins = parsed.pins;
			}
		} catch {
			/* first run */
		}
	}

	/** Persist the pins. */
	save() {
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			const temporary = `${this.path}.tmp`;
			writeFileSync(temporary, `${JSON.stringify(this.data, null, 1)}\n`, 'utf8');
			renameSync(temporary, this.path);
		} catch (error) {
			this.logger?.warn?.(`could not persist pinned endpoints: ${String(error)}`);
		}
	}

	/**
	 * Remember which endpoint a model is pinned to.
	 * @param model - OpenRouter model id.
	 * @param tag - endpoint tag, e.g. `morph/fp8`.
	 */
	setPin(model, tag) {
		if (typeof model !== 'string' || typeof tag !== 'string' || tag === '') return;
		if (this.data.pins[model] === tag) return;
		this.data.pins[model] = tag;
		this.save();
	}

	/**
	 * @param model - OpenRouter model id.
	 * @returns the endpoint tag, or undefined.
	 */
	pinOf(model) {
		return this.data.pins?.[model];
	}

	/** Every model with a recorded pin. */
	pinnedModels() {
		return Object.keys(this.data.pins ?? {});
	}

	/**
	 * Fill the slot pricing reads right now. Used once at startup so the first
	 * turn is not priced from the catalog.
	 * @param model - OpenRouter model id.
	 * @param quote - `{ tag, input, output, cacheRead }` in USD per 1e6 tokens.
	 */
	primeQuote(model, quote) {
		this.current.set(model, quote);
	}

	/**
	 * Park a freshly fetched quote until the turn ends. Nothing written to disk:
	 * a quote lives for one turn and is then replaced or dropped.
	 * @param model - OpenRouter model id.
	 * @param quote - `{ tag, input, output, cacheRead }`.
	 */
	queueQuote(model, quote) {
		this.pending.set(model, quote);
	}

	/**
	 * @param model - OpenRouter model id.
	 * @returns whether a fetch is already parked for the next turn.
	 */
	hasPending(model) {
		return this.pending.has(model);
	}

	/**
	 * Move every parked quote into the slot pricing reads. Called when a turn
	 * ends, so the next turn is priced with the newest quote while the turn that
	 * just finished keeps what it used.
	 */
	promote() {
		for (const [model, quote] of this.pending) this.current.set(model, quote);
		this.pending.clear();
	}

	/**
	 * @param model - OpenRouter model id.
	 * @returns the quote for the current turn, or undefined.
	 */
	quoteOf(model) {
		return this.current.get(model);
	}
}

/**
 * Durable plugin state: when the rate catalog was last fetched, and from where.
 * Nothing else needs to survive a restart — every displayed amount is derived
 * from the session logs.
 */
class Ledger {
	/**
	 * @param path - ledger file path.
	 * @param logger - optional logger.
	 */
	constructor(path, logger) {
		this.path = path;
		this.logger = logger;
		this.data = { version: 2, ratesAt: null, ratesSource: null };
		this.load();
	}

	/** Read the ledger from disk, keeping defaults for anything unreadable. */
	load() {
		try {
			const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
			if (parsed !== null && typeof parsed === 'object') {
				if (typeof parsed.ratesAt === 'number') this.data.ratesAt = parsed.ratesAt;
				if (typeof parsed.ratesSource === 'string') this.data.ratesSource = parsed.ratesSource;
			}
		} catch {
			/* first run, or an unreadable file: defaults are correct. */
		}
	}

	/** Persist the ledger atomically. */
	save() {
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			const temporary = `${this.path}.tmp`;
			writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
			renameSync(temporary, this.path);
		} catch (error) {
			this.logger?.warn?.(`could not persist the spend ledger: ${String(error)}`);
		}
	}
}

/**
 * The pricing brain: DeepSeek's published schedule and OpenRouter's live catalog.
 */
class Pricing {
	/**
	 * @param config - resolved configuration.
	 * @param ledger - durable ledger.
	 * @param logger - optional logger.
	 */
	constructor(config, ledger, logger, quotes, spend) {
		this.config = config;
		this.ledger = ledger;
		this.logger = logger;
		/** Money already computed per message; read before any pricing happens. */
		this.spend = spend;
		/** Pinned-endpoint price history. */
		this.quotes = quotes;
		/** Kick a quote fetch when a turn starts; it lands in the pending slot. */
		this.onTurnStart = undefined;
		/** Promote the pending quote when a turn ends, so it prices the next turn. */
		this.onTurnEnd = undefined;
		/** OpenRouter model id -> USD per 1e6 tokens, with tier overrides. */
		this.models = new Map();
		this.loadRates();
	}


	/** Read the cached OpenRouter rate snapshot, if one was written. */
	loadRates() {
		try {
			const parsed = JSON.parse(readFileSync(join(dshHome(), 'storages', STATE_DIR, RATES_FILE), 'utf8'));
			if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.models)) {
				for (const model of parsed.models) if (model?.id !== undefined) this.models.set(model.id, model);
			}
		} catch {
			/* no snapshot yet: the live fetch fills this in. */
		}
	}

	/**
	 * Currency one route bills in.
	 * @param provider - provider route id from the message source.
	 * @returns `CNY` or `USD`.
	 */
	currencyOf(provider) {
		return PROVIDER_CURRENCY[provider] ?? 'USD';
	}

	/**
	 * Price one usage record. Buckets are disjoint, and reasoning tokens are
	 * already inside `outputTokens`, so they are not charged again.
	 *
	 * @param usage - the event's `data.usage`.
	 * @param provider - producing route.
	 * @param model - producing model id.
	 * @param timeMs - event time, epoch milliseconds.
	 * @returns `{ currency, cost }`, or undefined when pricing is unknown.
	 */
	price(usage, provider, model, timeMs) {
		const currency = this.currencyOf(provider);
		const uncached = number(usage.inputTokens);
		const cacheRead = number(usage.cacheReadTokens);
		const cacheWrite = number(usage.cacheWriteTokens);
		const output = number(usage.outputTokens);
		if (currency === 'CNY') return this.priceDeepseek(uncached, cacheRead, cacheWrite, output, timeMs);
		// OpenRouter amounts are not priced here: the settings box is the only
		// price source, and the USD route computes them from the price book it
		// posts. Until that book has this model, the row is reported unpriced.
		return undefined;
	}

	/**
	 * Price a pinned route with the quote in force at that event's time. The
	 * quote comes from the plugin's own observation history, never from the
	 * catalog, so a pin's discount and a later pin switch both show up correctly
	 * and an already-frozen amount cannot drift.
	 *
	 * @param model - OpenRouter model id.
	 * @param uncached - uncached input tokens.
	 * @param cacheRead - cache-hit input tokens.
	 * @param cacheWrite - cache-write tokens.
	 * @param output - output tokens.
	 * @param timeMs - event time, epoch milliseconds.
	 * @returns priced buckets, or undefined when the pin or its quote is unknown.
	 */
	pricePinned(model, uncached, cacheRead, cacheWrite, output, timeMs) {
		void timeMs;
		const quote = this.quotes?.quoteOf(model);
		if (quote === undefined) return undefined;
		const cost = (quote.input / 1e6) * uncached
			+ (quote.output / 1e6) * output
			+ (quote.cacheRead / 1e6) * cacheRead
			+ (quote.cacheRead / 1e6) * cacheWrite;
		return { currency: 'USD', cost };
	}

	/**
	 * DeepSeek official rates, with the peak/off-peak schedule.
	 * @param uncached - uncached input tokens.
	 * @param cacheRead - cache-hit input tokens.
	 * @param cacheWrite - cache-write tokens.
	 * @param output - output tokens.
	 * @param timeMs - event time, epoch milliseconds.
	 * @returns priced buckets.
	 */
	priceDeepseek(uncached, cacheRead, cacheWrite, output, timeMs) {
		const { deepseek } = this.config;
		const peak = isPeak(timeMs, this.config);
		const multiplier = peak ? 1 : this.config.offPeakMultiplier;
		const perToken = (rate) => (rate / 1e6) * multiplier;
		const missInput = uncached + (deepseek.cacheWriteIsMiss ? cacheWrite : 0);
		return {
			currency: 'CNY',
			cost: perToken(deepseek.cacheMiss) * missInput
				+ perToken(deepseek.cacheHit) * cacheRead
				+ perToken(deepseek.output) * output,
		};
	}

	/**
	 * OpenRouter model rates, including `inputTokensAbove` tier overrides.
	 * @param model - OpenRouter model id.
	 * @param uncached - uncached input tokens.
	 * @param cacheRead - cache-hit input tokens.
	 * @param cacheWrite - cache-write tokens.
	 * @param output - output tokens.
	 * @returns priced buckets, or undefined when the catalog lacks the model.
	 */
	priceOpenrouter(model, uncached, cacheRead, cacheWrite, output) {
		const entry = this.ratesFor(model);
		if (entry === undefined) return undefined;
		const promptTokens = uncached + cacheRead + cacheWrite;
		let rates = entry.rates;
		let best = -1;
		for (const tier of entry.tiers ?? []) {
			if (promptTokens > tier.inputTokensAbove && tier.inputTokensAbove > best) {
				best = tier.inputTokensAbove;
				rates = tier;
			}
		}
		return {
			currency: 'USD',
			cost: (rates.input / 1e6) * uncached + (rates.output / 1e6) * output
				+ (rates.cacheRead / 1e6) * cacheRead + (rates.cacheWrite / 1e6) * cacheWrite,
		};
	}


	/**
	 * Rates for one model: a user override, else the live snapshot.
	 * @param model - OpenRouter model id.
	 * @returns rates and tiers, or undefined.
	 */
	ratesFor(model) {
		const override = this.config.openrouterModels?.[model];
		if (override !== undefined && typeof override === 'object') {
			return {
				rates: {
					input: number(override.input),
					output: number(override.output),
					cacheRead: number(override.cacheRead),
					cacheWrite: number(override.cacheWrite),
				},
				tiers: [],
			};
		}
		return this.models.get(model);
	}

	/**
	 * Refresh the OpenRouter catalog.
	 * @returns the number of models stored.
	 */
	async refreshRates() {
		const body = await getJson(OPENROUTER_MODELS_URL);
		const models = [];
		for (const entry of body.data ?? []) {
			if (typeof entry?.id !== 'string') continue;
			const pricing = entry.pricing ?? {};
			const rates = {
				input: perMillion(pricing.prompt),
				output: perMillion(pricing.completion),
				cacheRead: perMillion(pricing.input_cache_read),
				cacheWrite: perMillion(pricing.input_cache_write),
			};
			const tiers = Array.isArray(pricing.overrides)
				? pricing.overrides
					.filter((tier) => typeof tier?.min_prompt_tokens === 'number')
					.map((tier) => ({
						inputTokensAbove: tier.min_prompt_tokens,
						input: perMillion(tier.prompt),
						output: perMillion(tier.completion),
						cacheRead: perMillion(tier.input_cache_read),
						cacheWrite: perMillion(tier.input_cache_write),
					}))
				: [];
			models.push({ id: entry.id, name: entry.name ?? entry.id, rates, tiers });
		}
		this.models = new Map(models.map((model) => [model.id, model]));
		const path = join(dshHome(), 'storages', STATE_DIR, RATES_FILE);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ at: Date.now(), source: OPENROUTER_MODELS_URL, models }, null, 2)}\n`, 'utf8');
		return models.length;
	}
}

/**
 * OpenRouter publishes USD per token as decimal strings; the plugin works in USD per 1e6.
 * @param value - decimal string or number.
 * @returns USD per 1e6 tokens.
 */
function perMillion(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed * 1e6 : 0;
}

/**
 * Coerce a token count to a finite number.
 * @param value - raw count.
 * @returns the count, or 0.
 */
function number(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** One empty currency bucket. */
function emptyBucket() {
	return { cost: 0, requests: 0, unpriced: 0 };
}

/**
 * Check that a persisted bucket shape is what this unit writes.
 * @param value - untrusted value.
 * @returns whether it is a bucket.
 */
function isBucket(value) {
	if (value === null || typeof value !== 'object') return false;
	return ['cost', 'requests', 'unpriced']
		.every((key) => typeof value[key] === 'number');
}

/**
 * Check that a persisted per-model row carries the numbers the panel prints.
 * @param value - untrusted value.
 * @returns whether it is a model row.
 */
function isModelRow(value) {
	if (value === null || typeof value !== 'object') return false;
	if (typeof value.provider !== 'string' || typeof value.model !== 'string') return false;
	if (typeof value.currency !== 'string') return false;
	return ['cost', 'requests', 'unpriced'].every((key) => typeof value[key] === 'number');
}

/**
 * Minimal `stateSchema` contract: the registry only calls `parse`, and an
 * invalid row must throw so the cached checkpoint is discarded instead of
 * forward-applied into a corrupt fold.
 */
const stateSchema = {
	/**
	 * @param value - persisted state candidate.
	 * @returns the state.
	 */
	parse(value) {
		if (value === null || typeof value !== 'object') throw new Error('session-cost: state must be an object');
		if (!isBucket(value.CNY) || !isBucket(value.USD)) throw new Error('session-cost: state buckets are malformed');
		if (value.before === null || typeof value.before !== 'object') throw new Error('session-cost: state has no before buckets');
		if (!isBucket(value.before.CNY) || !isBucket(value.before.USD)) throw new Error('session-cost: state before buckets are malformed');
		if (!Array.isArray(value.before.subagents)) throw new Error('session-cost: state before has no subagents');
		if (typeof value.sessionId !== 'string') throw new Error('session-cost: state has no sessionId');
		if (value.currentTurn !== undefined && typeof value.currentTurn !== 'number') {
			throw new Error('session-cost: state currentTurn is malformed');
		}
		if (typeof value.lastTimeMs !== 'number') throw new Error('session-cost: state has no lastTimeMs');
		if (!Array.isArray(value.models)) throw new Error('session-cost: state has no models');
		if (!value.models.every(isModelRow)) throw new Error('session-cost: state model rows are malformed');
		if (!Array.isArray(value.subagents)) throw new Error('session-cost: state has no subagents');
		if (value.messages === null || typeof value.messages !== 'object' || Array.isArray(value.messages)) {
			throw new Error('session-cost: state has no messages');
		}
		if (value.turns === null || typeof value.turns !== 'object' || Array.isArray(value.turns)) {
			throw new Error('session-cost: state has no turns');
		}
		if (typeof value.inheritedEventCount !== 'number') throw new Error('session-cost: state has no inheritedEventCount');
		return value;
	},
};

/**
 * Pull the usage a settlement reported: the event's own `usage`, else the last
 * `usage` chunk inside its recorded stream.
 * @param event - a committed session event.
 * @returns the usage record, or undefined.
 */
function usageOf(event) {
	if (event?.type !== 'assistant/message') return undefined;
	if (event.data?.usage !== undefined) return event.data.usage;
	const stream = event.data?.stream;
	if (!Array.isArray(stream)) return undefined;
	for (let index = stream.length - 1; index >= 0; index -= 1) {
		const chunk = stream[index]?.chunk;
		if (chunk?.type === 'usage' && chunk.usage !== undefined) return chunk.usage;
	}
	return undefined;
}

/**
 * Fold one subagent discovery fact into the state's child list.
 *
 * The parent's own log carries a `subagent/catalog` event per direct child, so
 * the session that paid for a subagent is the one that knows it exists — no
 * cross-session lookup and no client-side catalog read is needed.
 *
 * @param state - previous state.
 * @param event - committed session event.
 * @returns next state, or the same reference when the event is not a discovery.
 */
function decodeWindow(event) {
	const stream = event?.data?.stream;
	if (!Array.isArray(stream) || stream.length === 0) return undefined;
	let first;
	let fallback;
	let last;
	for (const entry of stream) {
		const at = typeof entry?.time === 'number' ? entry.time : undefined;
		const start = typeof entry?.time0 === 'number' ? entry.time0 : undefined;
		if (start !== undefined && first === undefined) first = start;
		if (at !== undefined) {
			if (fallback === undefined) fallback = at;
			if (last === undefined || at > last) last = at;
		}
	}
	if (last === undefined) return undefined;
	const begin = first ?? fallback;
	if (begin === undefined || last <= begin) return undefined;
	return { first: begin, last };
}

function foldCatalog(state, event) {
	if (event?.type !== 'subagent/catalog') return state;
	const data = event.data;
	const childId = typeof data?.childId === 'string' ? data.childId : undefined;
	if (childId === undefined || state.subagents.some((row) => row.id === childId)) return state;
	return {
		...state,
		subagents: [...state.subagents, {
			id: childId,
			createdAt: number(data.childCreatedAt),
			mode: typeof data.mode === 'string' ? data.mode : 'unknown',
			...(typeof data.label === 'string' ? { label: data.label } : {}),
		}],
	};
}

/**
 * Fold one settlement into a state, returning the same reference when the
 * event is not a priced settlement (the registry's zero-work path).
 *
 * @param state - previous state.
 * @param event - committed session event.
 * @param pricing - pricing brain.
 * @returns next state.
 */
/**
 * Track the four readings the harness's own stats dialog shows, per turn: model
 * time, tool time, average time to first token, and decode speed.
 *
 * Only event timestamps are needed: a step's start comes from `step/start`, a
 * settlement's own `time` is completion, and the stream inside that settlement
 * pins the first token and the finish frame.
 *
 * @param state - folded state.
 * @param event - committed session event.
 * @returns next state, or the same reference when the event carries no timing.
 */
function foldTiming(state, event) {
	const turn = typeof event?.data?.turn === 'number' ? event.data.turn : undefined;
	const type = event?.type;
	if (type === 'step/start' && turn !== undefined) {
		const step = typeof event.data?.step === 'number' ? event.data.step : 0;
		return { ...state, stepStart: { ...(state.stepStart ?? {}), [`${String(turn)}:${String(step)}`]: event.time } };
	}
	if (type === 'tool/call') {
		const callId = typeof event.data?.callId === 'string' ? event.data.callId : undefined;
		if (callId === undefined) return state;
		return { ...state, callStart: { ...(state.callStart ?? {}), [callId]: event.time } };
	}
	if (type === 'tool/result') {
		const callId = typeof event.data?.message?.toolCallId === 'string' ? event.data.message.toolCallId : undefined;
		const calls = state.callStart ?? {};
		if (callId === undefined || typeof calls[callId] !== 'number' || turn === undefined) return state;
		const spent = Math.max(0, event.time - calls[callId]);
		const callStart = { ...calls };
		delete callStart[callId];
		const previous = state.turns[String(turn)] ?? { CNY: 0, USD: 0, unpriced: 0, models: [] };
		return {
			...state,
			callStart,
			turns: {
				...state.turns,
				[String(turn)]: { ...previous, toolMs: number(previous.toolMs) + spent },
			},
		};
	}
	return state;
}

/**
 * Fold one compaction summary settlement. The harness records the summary's
 * own provider, model and token usage on `compaction/summary`, so its cost is
 * computed here exactly like an assistant message — no OpenRouter query and no
 * separate accounting path. The count of summaries in the turn is what the
 * per-turn pill shows as `压缩摘要*N`.
 *
 * @param state - previous state.
 * @param event - committed `compaction/summary` event.
 * @param pricing - pricing brain.
 * @returns next state.
 */
function foldCompaction(state, event, pricing) {
	const usage = event?.data?.usage;
	const provider = event?.data?.provider;
	const model = event?.data?.model;
	if (usage === undefined || typeof provider !== 'string' || typeof model !== 'string') return state;
	const timeMs = typeof event.time === 'number' ? event.time : state.lastTimeMs;
	const currency = pricing.currencyOf(provider);
	const turn = number(state.currentTurn);
	const inherited = typeof event.seq === 'number' && event.seq < state.inheritedEventCount;
	const sessionId = typeof state.sessionId === 'string' ? state.sessionId : '';
	const messageId = `compaction:${String(event.data?.compactionId ?? event.seq)}`;
	const stored = sessionId !== '' ? pricing.spend?.read(sessionId, messageId) : undefined;
	const priced = stored !== undefined
		? (stored.unpriced > 0 ? undefined : { currency, cost: stored.cost })
		: pricing.price(usage, provider, model, timeMs);
	if (sessionId !== '' && (stored === undefined || typeof stored.input !== 'number')) {
		pricing.spend?.write(sessionId, messageId, {
			cost: priced?.cost ?? 0,
			unpriced: priced === undefined ? 1 : 0,
			currency,
			provider,
			model,
			turn: turn ?? null,
			before: inherited ? 1 : 0,
			input: number(usage.inputTokens),
			output: number(usage.outputTokens),
			cacheRead: number(usage.cacheReadTokens),
			cacheWrite: number(usage.cacheWriteTokens),
			compaction: true,
		});
	}
	const amount = priced === undefined ? 0 : priced.cost;
	const missing = priced === undefined ? 1 : 0;
	if (inherited) {
		const carried = { ...state.before[currency] };
		carried.requests += 1;
		if (priced === undefined) carried.unpriced += 1;
		else carried.cost += priced.cost;
		return { ...state, before: { ...state.before, [currency]: carried }, lastTimeMs: timeMs };
	}
	const bucket = { ...state[currency] };
	bucket.requests += 1;
	if (priced === undefined) bucket.unpriced += 1;
	else bucket.cost += priced.cost;
	const lines = state.models.slice();
	const at = lines.findIndex((line) => line.provider === provider && line.model === model);
	if (at === -1) {
		lines.push({ provider, model, currency, cost: amount, requests: 1, unpriced: missing });
	} else {
		lines[at] = {
			...lines[at],
			cost: lines[at].cost + amount,
			requests: lines[at].requests + 1,
			unpriced: lines[at].unpriced + missing,
		};
	}
	let turns = state.turns;
	if (turn !== undefined) {
		const key = String(turn);
		const previous = state.turns[key] ?? {
			CNY: 0,
			USD: 0,
			unpriced: 0,
			models: [],
			decodeMs: 0,
			decodeTokens: 0,
			llmMs: 0,
			toolMs: 0,
			ttftMs: 0,
			ttftSteps: 0,
			compactions: 0,
		};
		const known = previous.models.some((route) => route.provider === provider && route.model === model);
		turns = {
			...state.turns,
			[key]: {
				...previous,
				[currency]: number(previous[currency]) + amount,
				unpriced: number(previous.unpriced) + missing,
				compactions: number(previous.compactions) + 1,
				models: known ? previous.models : [...previous.models, { provider, model, currency }],
			},
		};
	}
	return { ...state, [currency]: bucket, models: lines, turns, lastTimeMs: timeMs };
}

function fold(state, event, pricing) {
	// The compaction summary event does not carry a turn number; the open turn
	// is what tells the pill which turn it belongs to.
	if (event?.type === 'turn/start') {
		const turn = number(event.data?.turn);
		if (turn !== undefined) state = { ...state, currentTurn: turn };
	} else if (event?.type === 'turn/end') {
		if (state.currentTurn !== undefined) state = { ...state, currentTurn: undefined };
	}
	if (event?.type === 'compaction/summary') return foldCompaction(state, event, pricing);
	// Timings (model/tool/first-token) are read from event timestamps alone.
	const timed = foldTiming(state, event);
	if (timed !== state) return timed;
	// A new turn is the moment to refresh the pinned endpoint's price: the fetch
	// is asynchronous and off the fold path, and by the time this turn's
	// settlements arrive the fresh quote is already recorded.
	if (event?.type === 'turn/start') pricing.onTurnStart?.();
	if (event?.type === 'turn/end') pricing.onTurnEnd?.();
	// A branched Session's log begins with a copy of its parent's history. Those
	// events were billed *before* the branch, so they are priced into a separate
	// `before` bucket — never into this branch's own spend, and never into its
	// model/route/turn detail (that detail belongs to the history, not this run).
	const inherited = typeof event?.seq === 'number' && event.seq < state.inheritedEventCount;
	if (inherited && event?.type === 'subagent/catalog') {
		// The inherited history also names the subagents that ran *before* the
		// branch: their spend belongs to 分支前, not to this branch's own children.
		const childId = typeof event.data?.childId === 'string' ? event.data.childId : undefined;
		if (childId === undefined || state.before.subagents.includes(childId)) return state;
		return { ...state, before: { ...state.before, subagents: [...state.before.subagents, childId] } };
	}
	const catalog = inherited ? state : foldCatalog(state, event);
	if (catalog !== state) return catalog;
	const usage = usageOf(event);
	if (usage === undefined) return state;
	const provider = event.data?.message?.source?.provider;
	const model = event.data?.message?.source?.model;
	if (typeof provider !== 'string' || typeof model !== 'string') return state;
	const timeMs = typeof event.time === 'number' ? event.time : state.lastTimeMs;
	const currency = pricing.currencyOf(provider);
	const messageId = event.data?.message?.id;
	const turn = typeof event.data?.turn === 'number' ? event.data.turn : undefined;
	// The amount for this message is looked up in the spend ledger first. Once a
	// message has been priced, that number is what every later fold and every
	// display uses — no re-pricing, no drift when the price list moves.
	const sessionId = typeof state.sessionId === 'string' ? state.sessionId : '';
	const stored = typeof messageId === 'string' ? pricing.spend?.read(sessionId, messageId) : undefined;
	const priced = stored !== undefined
		? (stored.unpriced > 0 ? undefined : { currency, cost: stored.cost })
		: pricing.price(usage, provider, model, timeMs);
	// Keep the tokens with the frozen row: the USD route multiplies them by the
	// price book the settings box posts, so a later price can price this message
	// without re-fold and without the cost side fetching anything.
	if (typeof messageId === 'string' && (stored === undefined || typeof stored.input !== 'number')) {
		pricing.spend?.write(sessionId, messageId, {
			cost: priced?.cost ?? stored?.cost ?? 0,
			unpriced: priced === undefined ? 1 : 0,
			currency,
			provider,
			model,
			turn: turn ?? null,
			before: inherited ? 1 : 0,
			input: number(usage.inputTokens),
			output: number(usage.outputTokens),
			cacheRead: number(usage.cacheReadTokens),
			cacheWrite: number(usage.cacheWriteTokens),
		});
	}
	if (inherited) {
		const carried = { ...state.before[currency] };
		carried.requests += 1;
		if (priced === undefined) carried.unpriced += 1;
		else carried.cost += priced.cost;
		return {
			...state,
			before: { ...state.before, [currency]: carried },
			lastTimeMs: timeMs,
		};
	}
	const bucket = { ...state[currency] };
	bucket.requests += 1;
	if (priced === undefined) {
		bucket.unpriced += 1;
	} else {
		bucket.cost += priced.cost;
	}
	const lines = state.models;
	const at = lines.findIndex((line) => line.provider === provider && line.model === model);
	const amount = priced === undefined ? 0 : priced.cost;
	const missing = priced === undefined ? 1 : 0;
	const models = lines.slice();
	if (at === -1) {
		models.push({ provider, model, currency, cost: amount, requests: 1, unpriced: missing });
	} else {
		const row = lines[at];
		models[at] = {
			...row,
			cost: row.cost + amount,
			requests: row.requests + 1,
			unpriced: row.unpriced + missing,
		};
	}
	// One row per Turn, plus a message -> turn index so the browser can price the
	// row it draws beside the harness's own "this turn" token figure. A turn
	// spans many assistant messages (128 in a long one), so a per-message figure
	// would not match the token number next to it.
	const turnKey = turn === undefined ? undefined : String(turn);
	let turns = state.turns;
	if (turnKey !== undefined) {
		const previous = state.turns[turnKey] ?? { CNY: 0, USD: 0, unpriced: 0, models: [], decodeMs: 0, decodeTokens: 0 };
		const window = decodeWindow(event);
		const outTokens = number(usage.outputTokens);
		const decodeMs = number(previous.decodeMs) + (window === undefined ? 0 : window.last - window.first);
		const decodeTokens = number(previous.decodeTokens) + (window === undefined ? 0 : outTokens);
		// A step's start is recorded by its own event; the settlement's time is
		// completion, so the difference is the model's wall time for that step.
		const step = typeof event.data?.step === 'number' ? event.data.step : 0;
		const stepKey = `${String(turn)}:${String(step)}`;
		const starts = state.stepStart ?? {};
		const startedAt = typeof starts[stepKey] === 'number' ? starts[stepKey] : undefined;
		const llmMs = number(previous.llmMs) + (startedAt === undefined ? 0 : Math.max(0, event.time - startedAt));
		const ttftMs = number(previous.ttftMs) + (startedAt === undefined || window === undefined ? 0 : Math.max(0, window.first - startedAt));
		const ttftSteps = number(previous.ttftSteps) + (startedAt === undefined || window === undefined ? 0 : 1);
		const known = previous.models.some((route) => route.provider === provider && route.model === model);
		turns = {
			...state.turns,
			[turnKey]: {
				...previous,
				[currency]: previous[currency] + amount,
				unpriced: previous.unpriced + missing,
				models: known ? previous.models : [...previous.models, { provider, model, currency }],
				decodeMs,
				decodeTokens,
				llmMs,
				ttftMs,
				ttftSteps,
			},
		};
	}
	const messages = typeof messageId === 'string' && turnKey !== undefined
		? { ...state.messages, [messageId]: turnKey }
		: state.messages;
	return {
		...state,
		[currency]: bucket,
		lastTimeMs: timeMs,
		models,
		messages,
		turns,
	};
}

/**
 * The session spend projection unit.
 * @param pricing - pricing brain.
 * @returns a projection definition.
 */
function projectionDefinition(pricing) {
	return {
		key: 'sessionSpend',
		stateVersion: 12,
		stateSchema,
		init: (header, inheritedEventCount) => ({
			// Needed to find this session's own spend ledger.
			sessionId: typeof header?.id === 'string' ? header.id : '',
			// The turn that is currently open; a compaction summary carries no turn
			// of its own and is attributed to this one.
			currentTurn: undefined,
			CNY: emptyBucket(),
			USD: emptyBucket(),
			// Spend carried in from the branch point: a branched Session's log opens
			// with a copy of its parent's history, priced here instead of into the
			// branch's own buckets.
			before: { CNY: emptyBucket(), USD: emptyBucket(), subagents: [] },
			lastTimeMs: Date.now(),
			models: [],
			messages: {},
			turns: {},
			subagents: [],
			stepStart: {},
			callStart: {},
			inheritedEventCount: typeof inheritedEventCount === 'number' ? inheritedEventCount : 0,
		}),
		apply: (state, event) => fold(state, event, pricing),
		wire: {
			viewSchema: {
				/**
				 * @param value - the wire payload.
				 * @returns the payload.
				 */
				parse: (value) => value,
			},
			view: (state) => view(state),
		},
	};
}

/**
 * Project one folded state onto the client payload. The view object identity
 * changes whenever a displayed number changes, which is what publishes it.
 *
 * @param state - folded state.
 * @returns the client-visible value.
 */
function view(state) {
	return {
		CNY: projectBucket(state.CNY),
		USD: projectBucket(state.USD),
		// What the branch point already carried, so the panel can show 分支前/分支后.
		before: {
			CNY: projectBucket(state.before.CNY),
			USD: projectBucket(state.before.USD),
			// Subagents that ran before the branch point; their spend is looked up
			// in their own Sessions and added to 分支前 by the browser.
			subagents: [...state.before.subagents],
		},
		models: state.models.map((row) => projectModel(row)),
		// The browser looks a message up in `messages` to find its turn, then
		// reads that turn's amount and routes from `turns`.
		messages: { ...state.messages },
		turns: Object.fromEntries(Object.entries(state.turns).map(([id, row]) => [id, projectTurn(row)])),
		subagents: state.subagents.map((row) => ({ ...row })),
		// Changes with every settlement; the Client uses it to key its USD read
		// so a new message never reuses a stale amount.
		lastTimeMs: state.lastTimeMs,
	};
}

/**
 * @param bucket - folded bucket.
 * @returns the wire bucket.
 */
function projectBucket(bucket) {
	return {
		cost: bucket.cost,
		requests: bucket.requests,
		unpriced: bucket.unpriced,
	};
}

/**
 * @param row - folded per-model row.
 * @returns the wire row.
 */
function projectModel(row) {
	return {
		provider: row.provider,
		model: row.model,
		currency: row.currency,
		cost: row.cost,
		requests: row.requests,
		unpriced: row.unpriced,
	};
}

/**
 * @param row - folded per-turn row.
 * @returns the wire row for one turn: its amount per currency and the routes it used.
 */
function projectTurn(row) {
	return {
		CNY: row.CNY,
		USD: row.USD,
		unpriced: row.unpriced,
		compactions: number(row.compactions),
		models: row.models.map((route) => ({ ...route })),
		tokensPerSecond: number(row.decodeMs) > 0 && number(row.decodeTokens) > 0
			? number(row.decodeTokens) / (number(row.decodeMs) / 1000)
			: null,
		// The four readings the harness's own stats dialog shows.
		llmMs: number(row.llmMs),
		toolMs: number(row.toolMs),
		ttftMs: number(row.ttftMs),
		ttftSteps: number(row.ttftSteps),
		decodeMs: number(row.decodeMs),
		decodeTokens: number(row.decodeTokens),
	};
}

/**
 * Services this plugin reads. Declaring `sessionProjections` is what admits
 * the plugin at all: an undeclared service access throws.
 */

/**
 * Host half of the session-cost bundle: prices every settlement, exposes the
 * per-session amount to the Client, and reconciles against billed anchors once
 * a day.
 *
 * @param ctx - the plugin context.
 * @param rawConfig - the row's validated `config`.
 * @param spend - the shared spend ledger store.
 * @returns a disposer joining every resource this plugin owns.
 */
function applySpend(ctx, rawConfig, spend) {
	const config = resolveConfig(rawConfig);
	const logger = ctx.logger?.('session-cost');
	const statePath = join(dshHome(), 'storages', STATE_DIR, LEDGER_FILE);
	const ledger = new Ledger(statePath, logger);
	const quotes = new PinRegistry(join(dshHome(), 'storages', STATE_DIR, PINS_FILE), logger);
	const pricing = new Pricing(config, ledger, logger, quotes, spend);
	/**
	 * Read one pinned provider's current endpoint price and record it.
	 * The model's endpoint tag is what the pin plugin put on the request.
	 * @param model - OpenRouter model id.
	 */
	const refreshPinned = async (model, slot = 'pending') => {
		const tag = quotes.pinOf(model);
		if (tag === undefined) return;
		// One quote per turn is enough; a second fetch while one is parked is waste.
		if (slot === 'pending' && quotes.hasPending(model)) return;
		try {
			const body = await getJson(`${OPENROUTER_MODELS_URL}/${model}/endpoints`);
			const endpoints = Array.isArray(body?.data?.endpoints) ? body.data.endpoints : [];
			const endpoint = endpoints.find((row) => row?.tag === tag) ?? endpoints.find((row) => row?.pricing !== undefined);
			const pricing = endpoint?.pricing;
			if (pricing === undefined) return;
			// Kept in memory for the turn being priced, then dropped: a quote is
			// never written down — only the money it produced is.
			const quote = {
				tag,
				input: perMillion(pricing.prompt),
				output: perMillion(pricing.completion),
				cacheRead: perMillion(pricing.input_cache_read),
			};
			// Startup fills the slot in use; a turn parks it for the next turn.
			if (slot === 'current') quotes.primeQuote(model, quote);
			else quotes.queueQuote(model, quote);
			logger?.info?.(`session-cost: pinned quote for ${model} @ ${tag} = ${perMillion(pricing.prompt)}/M in, ${perMillion(pricing.completion)}/M out`);
		} catch (error) {
			logger?.warn?.(`session-cost: pinned quote fetch failed for ${model}: ${String(error)}`);
		}
	};

	/**
	 * Fetch the current price for every pinned model. The fetch is asynchronous
	 * and never blocks a fold: its result is parked and promoted when the turn
	 * ends, so one turn is always priced with exactly one quote.
	 */
	const refreshAllPins = () => {
		for (const model of quotes.pinnedModels()) {
			if (!quotes.hasPending(model)) void refreshPinned(model, 'pending');
		}
	};
	void refreshAllPins;

	/**
	 * Learn which endpoint each model is pinned to by reading the header the pin
	 * plugin puts on the outgoing request (installed after it, so this wrapper is
	 * the outer one and still sees the header before it is stripped).
	 */
	const capturePins = () => {
		const original = globalThis.fetch;
		if (typeof original !== 'function' || original.__sessionCostPins === true) return () => {};
		const wrapped = function (input, init) {
			try {
				const headers = init?.headers;
				const tag = headers instanceof Map
					? headers.get(PIN_HEADER)
					: typeof headers?.get === 'function' ? headers.get(PIN_HEADER) : headers?.[PIN_HEADER];
				const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
				const model = body?.model;
				if (typeof tag === 'string' && tag !== '' && typeof model === 'string') {
					const known = quotes.pinOf(model);
					quotes.setPin(model, tag);
					if (known !== tag) void refreshPinned(model);
				}
			} catch { /* a request we cannot read is not our business */ }
			return original.apply(this, arguments);
		};
		wrapped.__sessionCostPins = true;
		globalThis.fetch = wrapped;
		return () => {
			if (globalThis.fetch === wrapped) globalThis.fetch = original;
		};
	};

	const disposers = [];
	const register = () => ctx.sessionProjections.register(projectionDefinition(pricing));
	if (typeof ctx.effect === 'function') ctx.effect(register);
	else disposers.push(register());

	/**
	 * Refresh the OpenRouter catalog: one price list for every model, shared by
	 * every provider, so a pinned or custom route is priced the same way as a
	 * plain one.
	 */
	const refresh = async () => {
		try {
			const models = await pricing.refreshRates();
			ledger.data.ratesAt = Date.now();
			ledger.data.ratesSource = `openrouter.ai (${String(models)} models)`;
			ledger.save();
			logger?.info?.(`session-cost: cached rates for ${String(models)} OpenRouter models`);
		} catch (error) {
			logger?.warn?.(`session-cost: OpenRouter rate refresh failed: ${String(error)}`);
		}
	};

	const due = () => {
		const at = ledger.data.ratesAt;
		return typeof at !== 'number' || Date.now() - at >= config.ratesRefreshHours * HOUR_MS;
	};

	logger?.info?.('session-cost: ready (OpenRouter amounts come from the settings price book)');

	return () => {
		for (const dispose of disposers.splice(0)) dispose();
		// The ledger of computed amounts is the durable record; flush it last.
		spend.flush();
		ledger.save();
	};
}

