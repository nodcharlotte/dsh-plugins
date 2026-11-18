/**
 * OpenRouter pinned-upstream client half.
 *
 * The plugin renders nothing of its own on the Models page: OpenRouter is added
 * and edited through DSH's own provider editor. What this half contributes is
 * one row under each model's "Input types" field — the pinned upstream endpoint
 * plus the [Update] / [Reset] actions — and the endpoint's live price block
 * beneath it.
 *
 * The Models section declares only `settings.models.provider-card` (above the
 * editor) and `settings.models.footer`; there is no seat inside a model row.
 * This half therefore registers the provider-card seat purely as a marker that
 * identifies the OpenRouter card (the route id arrives in its owner props), then
 * anchors a React portal directly after the model row's input-type fieldset.
 * The anchor is re-created whenever the native markup replaces the fieldset, and
 * removed when the row folds or the card closes.
 *
 * Pins live in this bundle's own settings namespace (`spend-pin`), never in
 * the `llm-pi-ai` provider profile: the native editor holds the revision it read
 * when it opened, so writing into its subtree would make its own Apply fail as a
 * conflict. The host half reads the same table and rewrites the OpenRouter
 * request body.
 *
 * @module @local/dsh-spend-pin/client
 */

window.__ModuleLoader__.load({
	id: '@local/dsh-spend-pin',
	factory(require) {
		const React = require('react');
		const ReactDOM = require('react-dom');
		const h = React.createElement;

		/** Locale namespace this plugin registers its copy under. */
		const LOCALE_NS = 'spend-pin';
		/** This bundle's own settings namespace, where the pin table lives. */
		const CONFIG_NS = 'spend-pin';
		/** Settings namespace that owns pi-ai provider routes. */
		const PI_AI_NS = 'llm-pi-ai';
		/** Public OpenRouter model catalogue root, used for endpoint pricing. */
		const MODELS_URL = 'https://openrouter.ai/api/v1/models';
		/** Local record of the last prices seen per model/endpoint. */
		const PRICE_CACHE_KEY = 'dsh-spend-pin:last-price';
		/** Endpoint tags travel through an HTTP header's worth of ASCII. */
		const TAG_PATTERN = /^[\x21-\x7E]{1,200}$/;
		/** Hosts this plugin treats as OpenRouter. */
		const OPENROUTER_HOST = /(^|\.)openrouter\.ai$/i;
		/**
		 * This page load's start. The observed-upstream box is deliberately
		 * page-lifetime only: an observation made before this page loaded is
		 * ignored, so refreshing or restarting DSH leaves the box empty until a
		 * new reply arrives.
		 */
		const PAGE_STARTED_AT = Date.now();
		/** Host route serving the in-memory provider observations. */
		const UPSTREAM_URL = '/spend-pin/api/upstream';
		/** Host route receiving the per-token price the box fetched. */
		const PRICE_URL = '/spend-pin/api/price';
		/** Host route returning a session's USD amounts under that price book. */
		const SPEND_URL = '/spend-pin/api/spend';

		const dictionaries = {
			zh: {
				pinLabel: '固定供应商',
				pinPlaceholder: '无',
				pinHint: 'OpenRouter 的 endpoint tag（提供商/量化）。点「更新」立即生效，不需要再点原生保存；留空或「重置」回到自动选路。',
				update: '更新',
				reset: '重置',
				busy: '写入中…',
				saved: '已固定到 {tag}。',
				cleared: '已恢复自动选路。',
				unchanged: '已是当前固定，价格已刷新。',
				invalid: '只能填可打印 ASCII 字符，不能包含空格。',
				conflict: '设置刚被其他窗口修改，请再试一次。',
				refused: '写入被拒绝',
				readOnly: '当前 profile 不可写。',
				unavailable: 'spend-pin 设置不可用。',
				priceTitle: '上游价格',
				priceInput: '输入',
				priceOutput: '输出',
				priceCacheRead: '缓存读取',
				perM: '/M tokens',
				priceLoading: '正在拉取该 endpoint 的价格…',
				priceError: '价格拉取失败',
				priceUnmatched: 'OpenRouter 没列出这个 endpoint 的价格。',
				priceUnpinned: '未固定 provider，价格由 OpenRouter 实时选路决定。',
				priceRefresh: '刷新',
				priceDiscount: '含折扣',
				priceChanged: '价格已变动',
				priceChangedHint: '红=涨价、绿=降价；旧价观测于 {time}。',
				priceClear: '清除对比',
				priceSource: '数据来自 OpenRouter endpoint 目录',
				priceUpdated: '更新于 {time}',
				observedTitle: '上游价格',
				observedActual: '实际路由',
			},
			en: {
				pinLabel: 'Pinned provider',
				pinPlaceholder: 'none',
				pinHint: 'An OpenRouter endpoint tag (provider/quantization). Update takes effect immediately — no separate Save needed. Leave it empty or Reset to return to automatic routing.',
				update: 'Update',
				reset: 'Reset',
				busy: 'Writing…',
				saved: 'Pinned to {tag}.',
				cleared: 'Back to automatic routing.',
				unchanged: 'Already pinned there; price refreshed.',
				invalid: 'Only printable ASCII characters, no whitespace.',
				conflict: 'Settings changed in another window; try again.',
				refused: 'Write refused',
				readOnly: 'This profile is read-only.',
				unavailable: 'The spend-pin settings namespace is unavailable.',
				priceTitle: 'Upstream price',
				priceInput: 'Input',
				priceOutput: 'Output',
				priceCacheRead: 'Cache read',
				perM: '/M tokens',
				priceLoading: 'Reading this endpoint’s price…',
				priceError: 'Price lookup failed',
				priceUnmatched: 'OpenRouter lists no price for this endpoint.',
				priceUnpinned: 'No pinned provider; the price follows OpenRouter routing.',
				priceRefresh: 'Refresh',
				priceDiscount: 'Discounted',
				priceChanged: 'Price changed',
				priceChangedHint: 'Red = up, green = down; old price seen {time}.',
				priceClear: 'Clear comparison',
				priceSource: 'From the OpenRouter endpoint catalogue',
				priceUpdated: 'updated {time}',
				observedTitle: 'Upstream price',
				observedActual: 'Actual route',
			},
		};

		/** Compact rows that sit inside one expanded model entry. */
		const CSS = `
.dshOrpinExtra{grid-column:1/-1;display:flex;flex-direction:column;gap:6px;min-width:0;margin-top:2px}
.dshOrpinPinRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dshOrpinPinLabel{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dshOrpinPinInput{box-sizing:border-box;flex:1 1 180px;min-width:0;height:32px;padding:0 10px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);outline:none}
.dshOrpinPinInput:focus{border-color:var(--dsw-alias-brand-primary)}
.dshOrpinPinInput:disabled{opacity:.5}
.dshOrpinPinButton{box-sizing:border-box;flex:none;height:32px;padding:0 12px;border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dshOrpinPinButton:disabled{opacity:.4;cursor:default}
.dshOrpinPinButton:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline:none}
.dshOrpinPinGhost{box-sizing:border-box;flex:none;height:32px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dshOrpinPinGhost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshOrpinPinGhost:disabled{opacity:.4;cursor:default}
.dshOrpinNote{margin:0;font-size:11px;line-height:16px}
.dshOrpinNoteError{color:var(--dsw-alias-state-error-primary)}
.dshOrpinNoteWarn{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
.dshOrpinNoteOk{color:var(--dsw-alias-state-success-primary)}
.dshOrpinHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dshOrpinPrice{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}
.dshOrpinPriceHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dshOrpinPriceTitle{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;line-height:18px}
.dshOrpinPriceMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;min-width:0;overflow-wrap:anywhere}
.dshOrpinDiscount{flex:none;padding:0 5px;border-radius:var(--dsw-radius-xs);border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:15px}
.dshOrpinPriceActions{margin-left:auto;display:inline-flex;align-items:center;gap:2px}
.dshOrpinPriceAction{flex:none;padding:2px 6px;border:none;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:17px;cursor:pointer}
.dshOrpinPriceAction:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshOrpinPriceRow{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.dshOrpinPriceLabel{min-width:0}
.dshOrpinPriceValue{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);white-space:nowrap}
.dshOrpinOld{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}
.dshOrpinArrow{color:var(--dsw-alias-label-tertiary)}
.dshOrpinNewUp{color:var(--dsw-alias-state-error-primary);font-weight:500}
.dshOrpinNewDown{color:var(--dsw-alias-state-success-primary);font-weight:500}
`;

		// --- pricing helpers (pure; exercised by check-pricing.mjs) -------------
		/* @pricing-helpers:start */

		/**
		 * Render one per-token USD price as a per-million-token figure.
		 * @param value - USD per token, as the catalogue publishes it.
		 * @returns `$0.098`-style text, or an em dash when unusable.
		 */
		function formatPerM(value) {
			const amount = Number(value) * 1e6;
			if (!Number.isFinite(amount)) return '—';
			return `$${String(Number(amount.toPrecision(4)))}`;
		}

		/**
		 * Normalise a provider display name into OpenRouter's slug spelling.
		 * @param name - e.g. `DeepInfra`.
		 * @returns e.g. `deepinfra`.
		 */
		function normalizeSlug(name) {
			return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
		}

		/**
		 * Build the public catalogue URL for one model's endpoints.
		 * @param model - the provider model id, `author/slug`.
		 * @returns the endpoints URL.
		 */
		function endpointsUrl(model) {
			const path = String(model).split('/').map((part) => encodeURIComponent(part)).join('/');
			return `${MODELS_URL}/${path}/endpoints`;
		}

		/**
		 * Read the numbers this row displays from one endpoint record.
		 * @param endpoint - one catalogue endpoint.
		 * @returns per-token prices and the catalogue's discount fraction.
		 */
		function readNumbers(endpoint) {
			const pricing = endpoint?.pricing ?? {};
			return {
				input: Number(pricing.prompt ?? NaN),
				output: Number(pricing.completion ?? NaN),
				cacheRead: Number(pricing.input_cache_read ?? NaN),
				discount: Number(pricing.discount ?? 0),
			};
		}

		/**
		 * Pick the catalogue endpoint a pinned tag names.
		 *
		 * An exact tag always wins (`deepinfra/fp8`). A tag the catalogue
		 * spells differently falls back to provider-name plus quantization
		 * matching, so `deepinfra` and `DeepInfra` still resolve.
		 *
		 * @param endpoints - the catalogue's endpoint list.
		 * @param pin - the pinned endpoint tag.
		 * @returns the matching endpoint, or undefined.
		 */
		function matchEndpoint(endpoints, pin) {
			const text = String(pin).trim();
			if (text === '' || !Array.isArray(endpoints)) return undefined;
			const exact = endpoints.find((endpoint) => typeof endpoint?.tag === 'string' && endpoint.tag === text);
			if (exact !== undefined) return exact;
			const segments = text.split('/').map((segment) => segment.trim()).filter((segment) => segment !== '');
			if (segments.length === 0) return undefined;
			const providerSlug = normalizeSlug(segments[0]);
			const quantization = segments.length > 1 ? segments[1].toLowerCase() : undefined;
			return endpoints.find((endpoint) => {
				if (typeof endpoint?.provider_name !== 'string') return false;
				if (normalizeSlug(endpoint.provider_name) !== providerSlug) return false;
				if (quantization === undefined) return true;
				return String(endpoint.quantization ?? '').toLowerCase() === quantization;
			});
		}

		/**
		 * Whether two quotes describe the same price.
		 *
		 * The discount fraction counts as part of the quote: a promotion ending
		 * changes it even before the numbers move.
		 *
		 * @param a - one quote.
		 * @param b - another quote.
		 * @returns whether every displayed number matches.
		 */
		function sameQuote(a, b) {
			for (const key of ['input', 'output', 'cacheRead']) {
				if (Number(a?.[key]) !== Number(b?.[key])) return false;
			}
			return Number(a?.discount ?? 0) === Number(b?.discount ?? 0);
		}

		/**
		 * Fold one fresh observation into the stored quote record.
		 *
		 * The pair is sticky: an observation equal to the stored `current`
		 * keeps whatever `previous` the record already carries, so the
		 * `$old → $new` line survives reloads and refreshes. Only an
		 * observation that differs replaces `previous` with the old `current`.
		 *
		 * @param record - stored record, or undefined on first sight.
		 * @param observed - the quote just read.
		 * @param now - observation time, epoch milliseconds.
		 * @returns the record to store and render.
		 */
		function nextPriceRecord(record, observed, now) {
			const storedCurrent = record?.current;
			if (storedCurrent === undefined) return { current: observed, at: now };
			if (sameQuote(storedCurrent, observed)) return { ...record, current: observed, at: now };
			const previous = { ...storedCurrent, at: record.at };
			return { previous, current: observed, changedAt: now, at: now };
		}
		/* @pricing-helpers:end */

		/* @storage-helpers:start */

		/**
		 * Key one endpoint's recorded price inside the local map.
		 * @param model - provider model id.
		 * @param pin - pinned endpoint tag.
		 * @returns the local key.
		 */
		function priceKey(model, pin) {
			return `${String(model).trim()}|${String(pin).trim()}`;
		}

		/**
		 * Read the local price map, keeping an unreadable value empty.
		 * @returns model/pin key -> recorded numbers.
		 */
		function readPriceBook() {
			try {
				const raw = globalThis.localStorage?.getItem(PRICE_CACHE_KEY);
				if (raw === null || raw === undefined || raw === '') return {};
				const parsed = JSON.parse(raw);
				return parsed !== null && typeof parsed === 'object' ? parsed : {};
			} catch {
				return {};
			}
		}

		/**
		 * Stored quote pair for one model/endpoint: the price last observed and,
		 * when a change was seen, the price it replaced. `current`/`previous`
		 * survive reloads so the `$old → $new` line stays until the next change.
		 * A record written by an older build (flat numbers) is read as
		 * `{ current }`.
		 *
		 * @param model - provider model id.
		 * @param pin - pinned endpoint tag.
		 * @returns the record, or undefined when none was stored.
		 */
		function readPriceRecord(model, pin) {
			const record = readPriceBook()[priceKey(model, pin)];
			if (record === null || record === undefined || typeof record !== 'object') return undefined;
			if (record.current !== null && typeof record.current === 'object') return record;
			if (typeof record.input === 'number') return { current: record, at: record.at };
			return undefined;
		}

		/**
		 * Record the observed quote pair so the delta survives reloads.
		 * @param model - provider model id.
		 * @param pin - pinned endpoint tag.
		 * @param record - `{ current, previous?, at, changedAt? }` to store.
		 */
		function writePriceRecord(model, pin, record) {
			try {
				const book = readPriceBook();
				book[priceKey(model, pin)] = record;
				globalThis.localStorage?.setItem(PRICE_CACHE_KEY, JSON.stringify(book));
			} catch {
				/* private mode or a full quota: the row still shows the current price */
			}
		}

		/**
		 * Drop one recorded pair, so the next read begins a fresh baseline.
		 * @param model - provider model id.
		 * @param pin - pinned endpoint tag.
		 */
		function clearPriceRecord(model, pin) {
			try {
				const book = readPriceBook();
				delete book[priceKey(model, pin)];
				globalThis.localStorage?.setItem(PRICE_CACHE_KEY, JSON.stringify(book));
			} catch {
				/* private mode or a full quota: nothing to clear */
			}
		}
		/* @storage-helpers:end */

		/**
		 * Whether one provider card is an OpenRouter card.
		 * @param provider - the card's directory row.
		 * @returns whether this plugin decorates it.
		 */
		function isOpenRouterEntry(provider) {
			if (provider?.provider === 'openrouter') return true;
			const base = provider?.defaultBaseURL;
			if (typeof base !== 'string') return false;
			try {
				return OPENROUTER_HOST.test(new URL(base).hostname);
			} catch {
				return false;
			}
		}

		/**
		 * Render an instant as local date and time.
		 * @param at - epoch milliseconds.
		 * @returns display text.
		 */
		function formatTime(at) {
			const value = Number(at);
			if (!Number.isFinite(value)) return '—';
			return new Date(value).toLocaleString();
		}

		/**
		 * Whether one catalogue endpoint belongs to the provider OpenRouter named.
		 * The response carries the display name (`DeepInfra`), the catalogue the
		 * same field, so an exact match is the normal case; the slug comparison
		 * covers a spelling difference.
		 *
		 * @param endpoint - one catalogue endpoint.
		 * @param provider - provider display name from the response.
		 * @returns whether they name the same provider.
		 */
		function sameProvider(endpoint, provider) {
			const name = String(endpoint?.provider_name ?? '');
			if (name === provider) return true;
			if (normalizeSlug(name) === normalizeSlug(provider)) return true;
			return name.toLowerCase() === String(provider).toLowerCase();
		}

		/**
		 * Pick the endpoint whose price the box shows for a provider. The
		 * response names the provider but not its variant (`fp8`, `flex`,
		 * `priority`), so the tag with the fewest segments wins — that is the
		 * provider's standard endpoint — and the cheapest breaks a tie.
		 *
		 * @param endpoints - every endpoint of this model.
		 * @param provider - provider display name from the response.
		 * @returns the endpoint to display, or undefined.
		 */
		function pickProviderEndpoint(endpoints, provider) {
			const matches = endpoints.filter((endpoint) => sameProvider(endpoint, provider));
			if (matches.length === 0) return undefined;
			const depth = (endpoint) => String(endpoint?.tag ?? '').split('/').filter((segment) => segment !== '').length;
			return [...matches].sort((left, right) => {
				const byDepth = depth(left) - depth(right);
				if (byDepth !== 0) return byDepth;
				return Number(left?.pricing?.prompt ?? Infinity) - Number(right?.pricing?.prompt ?? Infinity);
			})[0];
		}

		/**
		 * Read the host's in-memory provider observation for one model.
		 *
		 * Exactly one read, when the model row opens: no timer, no focus or
		 * visibility listener. Only a reading made after this page loaded is
		 * accepted, so a refresh or a DSH restart shows nothing until the model
		 * is used again.
		 *
		 * @param modelId - provider model id.
		 * @param enabled - whether this row should read at all (unpinned rows).
		 * @returns the accepted observation, or null.
		 */
		function useObservedUpstream(modelId, enabled) {
			const [entry, setEntry] = React.useState(null);
			React.useEffect(() => {
				if (!enabled) {
					setEntry(null);
					return undefined;
				}
				let cancelled = false;
				void (async () => {
					try {
						const response = await fetch(`${UPSTREAM_URL}?x=${String(Date.now())}`, {
							cache: 'no-store',
							headers: { accept: 'application/json' },
						});
						if (!response.ok) return;
						const body = await response.json();
						const row = body?.models?.[modelId];
						if (row === null || typeof row !== 'object') return;
						if (typeof row.provider !== 'string' || row.provider === '') return;
						if (!(Number(row.at) >= PAGE_STARTED_AT - 1000)) return;
						if (!cancelled) setEntry({ provider: row.provider, at: Number(row.at) });
					} catch {
						/* the host route is optional; leave the box hidden */
					}
				})();
				return () => {
					cancelled = true;
				};
			}, [modelId, enabled]);
			return entry;
		}

		/**
		 * Hand the price the box just read to the host. The host is the only
		 * place spend reads prices from, so this is the whole master → slave
		 * hand-off: the box acquires the price, the host uses it.
		 * @param model - provider model id.
		 * @param numbers - per-token input/output/cacheRead numbers.
		 */
		function postPrice(model, numbers) {
			const input = Number(numbers?.input);
			const output = Number(numbers?.output);
			const cacheRead = Number(numbers?.cacheRead);
			if (![input, output, cacheRead].every((value) => Number.isFinite(value) && value >= 0)) return;
			void fetch(PRICE_URL, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ model, input, output, cacheRead }),
			}).then(() => {
				try {
					window.dispatchEvent(new Event('spend-pin:price'));
				} catch {
					/* a page without events is still fine */
				}
			}).catch(() => {});
		}

		/**
		 * Last quote the unpinned box read for each model, page-lifetime only.
		 * It is the baseline for the box's red/green “old → new” rows, including
		 * a switch to another provider; a refresh or plugin reload clears it.
		 */
		const observedQuotes = new Map();

		/**
		 * Fetch the catalogue price of the provider actually serving one model.
		 * @param modelId - provider model id.
		 * @param provider - provider display name, or undefined while unobserved.
		 * @returns `{ status, tag, numbers, at, message }`.
		 */
		function useObservedPrice(modelId, provider) {
			const [price, setPrice] = React.useState({ status: 'idle' });
			React.useEffect(() => {
				if (provider === undefined) {
					setPrice({ status: 'idle' });
					return undefined;
				}
				let cancelled = false;
				setPrice({ status: 'loading' });
				void (async () => {
					try {
						const response = await fetch(`${endpointsUrl(modelId)}?x=${String(Date.now())}`, {
							cache: 'no-store',
							headers: { accept: 'application/json' },
						});
						if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
						const body = await response.json();
						const endpoints = Array.isArray(body?.data?.endpoints) ? body.data.endpoints : [];
						const endpoint = pickProviderEndpoint(endpoints, provider);
						if (endpoint === undefined) {
							if (!cancelled) setPrice({ status: 'unmatched' });
							return;
						}
						const numbers = readNumbers(endpoint);
						const record = nextPriceRecord(observedQuotes.get(modelId), numbers, Date.now());
						observedQuotes.set(modelId, record);
						if (!cancelled) {
							setPrice({
								status: 'ready',
								tag: String(endpoint.tag ?? ''),
								numbers: record.current,
								previous: record.previous,
								discount: Number(endpoint?.pricing?.discount ?? 0),
								at: record.at,
								changedAt: record.changedAt,
							});
						}
					} catch (error) {
						if (!cancelled) setPrice({ status: 'error', message: String(error?.message ?? error) });
					}
				})();
				return () => {
					cancelled = true;
				};
			}, [modelId, provider]);
			return price;
		}

		/** Pin table plus its write face, shared by every model row of one card. */
		const PinConfigContext = React.createContext(null);

		/**
		 * Read the pin table out of this bundle's settings namespace.
		 * @param ctx - the client plugin context.
		 * @param t - the plugin's translate function.
		 * @returns the provider value consumed by {@link usePinConfig}.
		 */
		function usePinConfigState(ctx, t) {
			const [state, setState] = React.useState({ status: 'loading', pins: {}, writable: true, error: null });

			const read = React.useCallback(async () => {
				try {
					const described = await ctx.remote.settings.describe();
					if (described === null || described === undefined || described.ok !== true) {
						setState((current) => ({ ...current, status: 'error', error: described?.error?.message ?? t('unavailable') }));
						return;
					}
					const view = (described.value.namespaces ?? []).find((entry) => entry.ns === CONFIG_NS);
					if (view === undefined) {
						setState((current) => ({ ...current, status: 'error', error: t('unavailable') }));
						return;
					}
					const raw = view.value !== null && typeof view.value === 'object' ? view.value.pins : undefined;
					const pins = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
					setState({ status: 'ready', pins, writable: described.value.writable !== false, error: null });
				} catch (error) {
					setState((current) => ({ ...current, status: 'error', error: String(error?.message ?? error) }));
				}
			}, [ctx, t]);

			React.useEffect(() => {
				void read();
				const off = ctx.remote?.$on?.('settings/document-updated', (ns) => {
					if (ns === CONFIG_NS) void read();
				});
				return () => {
					if (typeof off === 'function') off();
				};
			}, [read]);

			const mutate = React.useCallback(async (ops) => {
				for (let attempt = 0; attempt < 2; attempt += 1) {
					let described;
					try {
						described = await ctx.remote.settings.describe();
					} catch (error) {
						return { ok: false, error: String(error?.message ?? error) };
					}
					if (described === null || described === undefined || described.ok !== true) {
						return { ok: false, error: described?.error?.message ?? t('unavailable') };
					}
					const view = (described.value.namespaces ?? []).find((entry) => entry.ns === CONFIG_NS);
					if (view === undefined) return { ok: false, error: t('unavailable') };
					if (described.value.writable === false) return { ok: false, error: t('readOnly') };
					let written;
					try {
						written = await ctx.remote.settings.mutate(CONFIG_NS, ops, view.revision);
					} catch (error) {
						return { ok: false, error: String(error?.message ?? error) };
					}
					if (written !== null && written !== undefined && written.ok === true) {
						await read();
						return { ok: true };
					}
					if (written?.error?.code !== 'settings/conflict') {
						return { ok: false, error: written?.error?.message ?? t('refused') };
					}
				}
				return { ok: false, error: t('conflict') };
			}, [ctx, t, read]);

			return React.useMemo(() => ({ ...state, mutate }), [state, mutate]);
		}

		/**
		 * Provide the pin table to every model row portal of one card.
		 * @param props - client context, translate function, and children.
		 * @returns the context provider.
		 */
		function PinConfigProvider({ ctx, t, children }) {
			const value = usePinConfigState(ctx, t);
			return h(PinConfigContext.Provider, { value }, children);
		}

		/**
		 * Read the shared pin table.
		 * @returns `{ status, pins, writable, error, mutate }`.
		 */
		function usePinConfig() {
			const value = React.useContext(PinConfigContext);
			if (value === null) throw new Error('spend-pin: missing pin config context');
			return value;
		}

		/**
		 * Key one model row's portal.
		 * @param previous - current rows.
		 * @param next - scanned rows.
		 * @returns whether nothing changed.
		 */
		function sameRows(previous, next) {
			if (previous.length !== next.length) return false;
			for (let index = 0; index < previous.length; index += 1) {
				const a = previous[index];
				const b = next[index];
				if (a.key !== b.key || a.modelId !== b.modelId || a.anchor !== b.anchor) return false;
			}
			return true;
		}

		/** Stable portal key per native model entry. */
		let portalSequence = 0;

		/**
		 * Marker component that anchors one portal after each native model row's
		 * input-type fieldset.
		 *
		 * The Models section has no slot inside a model row, so the only way to
		 * sit under "Input types" is to place an element there ourselves. The
		 * scan is idempotent: every native re-render that replaces the fieldset
		 * re-inserts the anchor, and folding the row or closing the card removes
		 * it. A missing anchor renders nothing rather than breaking the card.
		 *
		 * @param props - the card's directory row, whether it is configured, and
		 * the client context/translate function.
		 * @returns the hidden marker plus one portal per expanded model row.
		 */
		function ModelRowPortals({ provider, configured, ctx, t }) {
			const hostRef = React.useRef(null);
			const [rows, setRows] = React.useState([]);
			const eligible = configured === true && isOpenRouterEntry(provider);

			React.useEffect(() => {
				if (!eligible) {
					setRows((current) => (current.length === 0 ? current : []));
					return undefined;
				}
				const host = hostRef.current;
				const card = host?.closest('li') ?? host?.closest('[class*="rowCard"]');
				if (!card) return undefined;

				/** One anchor per native model entry, keyed by that entry element. */
				const records = new Map();
				let scheduled = false;
				let disposed = false;

				const scan = () => {
					scheduled = false;
					if (disposed) return;
					const next = [];
					const seen = new Set();
					for (const entry of card.querySelectorAll('[class*="modelEntry"]')) {
						seen.add(entry);
						const advanced = entry.querySelector('[class*="modelAdvanced"]');
						const fieldset = advanced?.querySelector('fieldset') ?? entry.querySelector('fieldset');
						if (!fieldset) continue;
						const idInput = entry.querySelector('[class*="modelRow"] input') ?? entry.querySelector('input[type="text"]');
						const modelId = typeof idInput?.value === 'string' ? idInput.value.trim() : '';
						if (modelId === '') continue;
						let record = records.get(entry);
						if (record === undefined) {
							const anchor = document.createElement('div');
							anchor.className = 'dshOrpinExtra';
							anchor.dataset.dshOrpin = 'model-extra';
							record = { anchor, key: `orx-${++portalSequence}`, modelId };
							records.set(entry, record);
						}
						record.modelId = modelId;
						if (fieldset.nextElementSibling !== record.anchor) {
							fieldset.insertAdjacentElement('afterend', record.anchor);
						}
						next.push({ key: record.key, modelId, anchor: record.anchor });
					}
					for (const [entry, record] of records) {
						if (seen.has(entry)) continue;
						record.anchor.remove();
						records.delete(entry);
					}
					setRows((current) => (sameRows(current, next) ? current : next));
				};

				const schedule = () => {
					if (scheduled || disposed) return;
					scheduled = true;
					queueMicrotask(scan);
				};

				const observer = new MutationObserver(schedule);
				observer.observe(card, { childList: true, subtree: true });
				const onInput = (event) => {
					if (event.target instanceof HTMLInputElement) schedule();
				};
				card.addEventListener('input', onInput, true);
				schedule();

				return () => {
					disposed = true;
					observer.disconnect();
					card.removeEventListener('input', onInput, true);
					for (const record of records.values()) record.anchor.remove();
					records.clear();
				};
			}, [eligible]);

			return h(React.Fragment, null,
				h('span', { ref: hostRef, hidden: true }),
				rows.map((row) => ReactDOM.createPortal(
					h(PinRow, { key: row.key, ctx, t, modelId: row.modelId }),
					row.anchor,
					row.key,
				)),
			);
		}

		/**
		 * One model's pin row plus its endpoint price block.
		 * @param props - client context, translate function, and model id.
		 * @returns the pinned-provider controls.
		 */
		function PinRow({ ctx, t, modelId }) {
			const config = usePinConfig();
			const savedPin = typeof config.pins[modelId] === 'string' ? config.pins[modelId] : '';
			const [draftTag, setDraftTag] = React.useState(savedPin);
			const [busy, setBusy] = React.useState(false);
			const [note, setNote] = React.useState(null);
			const [price, setPrice] = React.useState({ status: 'idle' });
			const [nonce, setNonce] = React.useState(0);
			const unpinned = savedPin === '';
			const observed = useObservedUpstream(modelId, unpinned);
			const observedPrice = useObservedPrice(modelId, unpinned && observed !== null ? observed.provider : undefined);

			// Reopening a saved model, or renaming the row, starts from what is
			// actually stored rather than a stale draft.
			React.useEffect(() => {
				setDraftTag(savedPin);
			}, [modelId, savedPin]);

			React.useEffect(() => {
				if (savedPin === '') {
					setPrice({ status: 'unpinned' });
					return undefined;
				}
				let cancelled = false;
				setPrice({ status: 'loading' });
				void (async () => {
					try {
						// A cache-buster keeps OpenRouter's CDN from replaying a stale
						// catalogue: a stale price would show as a fake change pair.
						const response = await fetch(`${endpointsUrl(modelId)}?x=${String(Date.now())}`, {
							cache: 'no-store',
							headers: { accept: 'application/json' },
						});
						if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
						const body = await response.json();
						const endpoints = Array.isArray(body?.data?.endpoints) ? body.data.endpoints : [];
						const endpoint = matchEndpoint(endpoints, savedPin);
						if (endpoint === undefined) {
							if (!cancelled) setPrice({ status: 'unmatched' });
							return;
						}
						const observed = readNumbers(endpoint);
						const next = nextPriceRecord(readPriceRecord(modelId, savedPin), observed, Date.now());
						writePriceRecord(modelId, savedPin, next);
						// The box is the price master: hand what it read to the host.
						postPrice(modelId, next.current);
						if (!cancelled) {
							setPrice({
								status: 'ready',
								provider: String(endpoint.provider_name ?? ''),
								tag: String(endpoint.tag ?? savedPin),
								current: next.current,
								previous: next.previous,
								discount: Number(next.current.discount ?? 0),
								at: next.at,
								changedAt: next.changedAt,
							});
						}
					} catch (error) {
						if (!cancelled) setPrice({ status: 'error', message: String(error?.message ?? error) });
					}
				})();
				return () => {
					cancelled = true;
				};
			}, [modelId, savedPin, nonce]);

			const writable = config.writable !== false;
			const ready = config.status === 'ready';
			const noteClass = note === null
				? ''
				: note.tone === 'error'
					? 'dshOrpinNote dshOrpinNoteError'
					: note.tone === 'warn'
						? 'dshOrpinNote dshOrpinNoteWarn'
						: 'dshOrpinNote dshOrpinNoteOk';

			/**
			 * Commit the typed endpoint tag. An empty field is the same as Reset:
			 * the model goes back to OpenRouter's own routing.
			 */
			const update = async () => {
				if (busy || !writable) return;
				const tag = draftTag.trim();
				if (tag === savedPin) {
					setNonce((value) => value + 1);
					setNote({ tone: 'ok', text: t('unchanged') });
					return;
				}
				if (tag !== '' && !TAG_PATTERN.test(tag)) {
					setNote({ tone: 'error', text: t('invalid') });
					return;
				}
				setBusy(true);
				setNote(null);
				try {
					const ops = tag === ''
						? [{ op: 'unset', path: ['pins', modelId] }]
						: [{ op: 'set', path: ['pins', modelId], value: tag }];
					const result = await config.mutate(ops);
					if (result.ok !== true) {
						setNote({ tone: 'error', text: result.error });
						return;
					}
					if (tag === '') {
						if (savedPin !== '') clearPriceRecord(modelId, savedPin);
						setNote({ tone: 'ok', text: t('cleared') });
					} else {
						setNote({ tone: 'ok', text: t('saved').replace('{tag}', tag) });
					}
					setNonce((value) => value + 1);
				} finally {
					setBusy(false);
				}
			};

			/** Drop this model's pin and its local price comparison baseline. */
			const reset = async () => {
				if (busy || !writable) return;
				if (savedPin === '') {
					setDraftTag('');
					setNote(null);
					return;
				}
				setBusy(true);
				setNote(null);
				try {
					const result = await config.mutate([{ op: 'unset', path: ['pins', modelId] }]);
					if (result.ok !== true) {
						setNote({ tone: 'error', text: result.error });
						return;
					}
					clearPriceRecord(modelId, savedPin);
					setNote({ tone: 'ok', text: t('cleared') });
					setNonce((value) => value + 1);
				} finally {
					setBusy(false);
				}
			};

			/** Forget the persisted pair so the next reading starts a new baseline. */
			const forgetPrice = () => {
				if (savedPin === '') return;
				clearPriceRecord(modelId, savedPin);
				setNonce((value) => value + 1);
			};

			const priceRow = (label, key) => {
				const current = price.current === undefined ? undefined : price.current[key];
				const previous = price.previous === undefined ? undefined : price.previous[key];
				const changed = previous !== undefined && current !== undefined && Number(previous) !== Number(current);
				const direction = changed ? (Number(current) > Number(previous) ? 'dshOrpinNewUp' : 'dshOrpinNewDown') : null;
				return h('div', { className: 'dshOrpinPriceRow', key },
					h('span', { className: 'dshOrpinPriceLabel' }, label),
					h('span', { className: 'dshOrpinPriceValue' },
						changed ? h('span', { className: 'dshOrpinOld' }, formatPerM(previous)) : null,
						changed ? h('span', { className: 'dshOrpinArrow' }, ' → ') : null,
						h('span', { className: direction }, `${formatPerM(current)} ${t('perM')}`),
					),
				);
			};

			/**
			 * One price row of the observed-provider box. Its baseline is the
			 * page-lifetime quote for this model, so a price change or a provider
			 * switch shows the old → new pair exactly like the pinned box.
			 * @param label - localized row label.
			 * @param key - `input` | `output` | `cacheRead`.
			 * @returns the row element.
			 */
			const observedRow = (label, key) => {
				const current = observedPrice.numbers === undefined ? undefined : observedPrice.numbers[key];
				const previous = observedPrice.previous === undefined ? undefined : observedPrice.previous[key];
				const changed = previous !== undefined && current !== undefined && Number(previous) !== Number(current);
				const direction = changed ? (Number(current) > Number(previous) ? 'dshOrpinNewUp' : 'dshOrpinNewDown') : null;
				return h('div', { className: 'dshOrpinPriceRow', key },
					h('span', { className: 'dshOrpinPriceLabel' }, label),
					h('span', { className: 'dshOrpinPriceValue' },
						changed ? h('span', { className: 'dshOrpinOld' }, formatPerM(previous)) : null,
						changed ? h('span', { className: 'dshOrpinArrow' }, ' → ') : null,
						h('span', { className: direction }, `${formatPerM(current)} ${t('perM')}`),
					),
				);
			};

			/**
			 * The block written under an unpinned model row: the provider
			 * OpenRouter actually routed to on this page, plus that provider's
			 * catalogue price. It never reads or writes local storage.
			 */
			let observedBlock;
			if (observed === null) {
				observedBlock = null;
			} else if (observedPrice.status === 'ready') {
				observedBlock = h('div', { className: 'dshOrpinPrice' },
					h('div', { className: 'dshOrpinPriceHead' },
						h('span', { className: 'dshOrpinPriceTitle' }, t('observedTitle')),
						h('span', { className: 'dshOrpinPriceMeta' }, `${observed.provider}`),
						observedPrice.discount > 0 ? h('span', { className: 'dshOrpinDiscount' }, t('priceDiscount')) : null,
					),
					observedRow(t('priceInput'), 'input'),
					observedRow(t('priceOutput'), 'output'),
					observedRow(t('priceCacheRead'), 'cacheRead'),
					h('p', { className: 'dshOrpinHint' }, `${t('observedActual')} · ${t('priceUpdated').replace('{time}', formatTime(observed.at))}`),
				);
			} else if (observedPrice.status === 'unmatched') {
				observedBlock = h('p', { className: 'dshOrpinHint' }, t('priceUnmatched'));
			} else if (observedPrice.status === 'error') {
				observedBlock = h('p', { className: 'dshOrpinNote dshOrpinNoteWarn' }, `${t('priceError')}：${String(observedPrice.message ?? '')}`);
			} else {
				observedBlock = null;
			}

			let priceBlock;
			if (savedPin === '') {
				priceBlock = observedBlock;
			} else if (price.status === 'ready') {
				priceBlock = h('div', { className: 'dshOrpinPrice' },
					h('div', { className: 'dshOrpinPriceHead' },
						h('span', { className: 'dshOrpinPriceTitle' }, t('priceTitle')),
						h('span', { className: 'dshOrpinPriceMeta' }, `${price.provider}`),
						price.discount > 0 ? h('span', { className: 'dshOrpinDiscount' }, t('priceDiscount')) : null,
						h('span', { className: 'dshOrpinPriceActions' },
							price.previous === undefined
								? null
								: h('button', {
									className: 'dshOrpinPriceAction',
									type: 'button',
									onClick: forgetPrice,
								}, t('priceClear')),
							h('button', {
								className: 'dshOrpinPriceAction',
								type: 'button',
								onClick: () => setNonce((value) => value + 1),
							}, t('priceRefresh')),
						),
					),
					priceRow(t('priceInput'), 'input'),
					priceRow(t('priceOutput'), 'output'),
					priceRow(t('priceCacheRead'), 'cacheRead'),
					price.previous === undefined
						? null
						: h('p', { className: 'dshOrpinNote dshOrpinNoteWarn' }, `${t('priceChanged')}：${t('priceChangedHint').replace('{time}', formatTime(price.previous.at ?? price.changedAt ?? price.at))}`),
					h('p', { className: 'dshOrpinHint' }, `${t('priceSource')} · ${t('priceUpdated').replace('{time}', formatTime(price.at))}`),
				);
			} else if (price.status === 'unmatched') {
				priceBlock = h('p', { className: 'dshOrpinHint' }, t('priceUnmatched'));
			} else if (price.status === 'error') {
				priceBlock = h('p', { className: 'dshOrpinNote dshOrpinNoteWarn' }, `${t('priceError')}：${String(price.message ?? '')}`);
			} else {
				priceBlock = h('p', { className: 'dshOrpinHint' }, t('priceLoading'));
			}

			return h(React.Fragment, null,
				h('div', { className: 'dshOrpinPinRow' },
					h('span', { className: 'dshOrpinPinLabel', title: t('pinHint') }, t('pinLabel')),
					h('input', {
						className: 'dshOrpinPinInput',
						type: 'text',
						value: draftTag,
						spellCheck: false,
						autoComplete: 'off',
						placeholder: t('pinPlaceholder'),
						'aria-label': t('pinLabel'),
						disabled: busy || !writable || !ready,
						onChange: (event) => setDraftTag(event.target.value),
						onKeyDown: (event) => {
							if (event.key === 'Enter') {
								event.preventDefault();
								void update();
							}
						},
					}),
					h('button', {
						className: 'dshOrpinPinButton',
						type: 'button',
						disabled: busy || !writable || !ready || (draftTag.trim() === '' && savedPin === ''),
						onClick: () => { void update(); },
					}, busy ? t('busy') : t('update')),
					h('button', {
						className: 'dshOrpinPinGhost',
						type: 'button',
						disabled: busy || !writable || !ready || (savedPin === '' && draftTag === ''),
						onClick: () => { void reset(); },
					}, t('reset')),
				),
				note === null ? null : h('p', { className: noteClass }, note.text),
				config.status === 'error' && note === null
					? h('p', { className: 'dshOrpinNote dshOrpinNoteWarn' }, String(config.error ?? t('unavailable')))
					: null,
				priceBlock,
			);
		}

		/**
		 * The provider-card seat contribution. It only identifies the OpenRouter
		 * card; the visible UI is anchored inside the model rows.
		 * @param props - owner props plus the bound client context.
		 * @returns the marker/portals, or nothing for other providers.
		 */
		function ProviderExtras({ provider, configured, ctx, t }) {
			if (configured !== true || !isOpenRouterEntry(provider)) return null;
			return h(PinConfigProvider, { ctx, t },
				h(ModelRowPortals, { provider, configured, ctx, t }),
			);
		}

		return {
			inject: ['slots', 'locale', 'remote', 'remote.settings', 'sessions'],
			apply(ctx) {
				ctx.effect(() => ctx.locale.register(LOCALE_NS, dictionaries), 'spend-pin: copy dictionaries');
				ctx.effect(() => {
					const style = document.createElement('style');
					style.dataset.dshPlugin = LOCALE_NS;
					style.textContent = CSS;
					document.head.appendChild(style);
					return () => style.remove();
				}, 'spend-pin: model row styles');
				const t = ctx.locale.bind(LOCALE_NS);
				const Extras = (props) => h(ProviderExtras, { ...props, ctx, t });
				ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
					name: 'settings.models.provider-card',
					key: PI_AI_NS,
				}, Extras));
				const spendModule = createSpendModule(require, {
					UPSTREAM_URL,
					PRICE_URL,
					SPEND_URL,
					endpointsUrl,
					pickProviderEndpoint,
					readNumbers,
				});
				const disposeSpend = spendModule.apply(ctx);
				return () => {
					if (typeof disposeSpend === 'function') disposeSpend();
				};
			},
		};
	},
});


/**
 * Session spend (client half).
 *
 * Renders the amount the session tree has cost so far as a pill in the composer
 * dock, immediately after the harness's own stats pills — so it reads as
 * `… · 缓存命中 97% · ¥0.0372`. The value comes from the host's `sessionSpend`
 * projection (`wire.view`), so this half folds nothing itself.
 *
 * Currency follows the provider that produced the work: DeepSeek official
 * charges CNY, OpenRouter charges USD. Each row is quoted in its own currency.
 *
 * The pill opens a breakdown dialog laid out like the harness's own usage
 * dialog: icon plus title, a rule, then the grey detail rows. Subagent spends
 * come from each child Session's own `sessionSpend` projection value; because
 * the host loads a Session's projections on demand, this half asks for the
 * children it finds (`sessions.refreshProjections`), exactly as the shipped
 * subagent UI does.
 *
 * @module @local/dsh-session-cost/client
 */
function createSpendModule(require, deps) {
		const React = require('react');
		const h = React.createElement;
		const reactDom = require('react-dom');
		// The pin module owns these route names and the endpoint-matching helpers;
		// this spend module lives outside its factory, so they are passed in.
		const { UPSTREAM_URL, PRICE_URL, SPEND_URL, endpointsUrl, pickProviderEndpoint, readNumbers } = deps;

		/** Host building blocks; the primitives entry is what the shipped siblings require. */
		const primitives = (() => {
			try {
				return require('@deepseek-ai/dsh-client-ui-primitives');
			} catch {
				return undefined;
			}
		})();

		/**
		 * Read one export off the primitives namespace, whichever shape the
		 * loader hands back.
		 * @param name - export name.
		 * @returns the export, or undefined.
		 */
		function primitive(name) {
			if (primitives === undefined || primitives === null) return undefined;
			return primitives[name] ?? primitives.default?.[name];
		}

		/** Distance between the trigger's top edge and the panel's bottom (host value). */
		const PANEL_GAP = 8;
		/** Viewport margin the placement clamp keeps (host value). */
		const PANEL_MARGIN = 12;
		/**
		 * Unplaced portal panel: hidden but laid out so the clamp measures real
		 * dimensions (the host's measure pass).
		 */
		const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };
		/** Sessions whose projection load this page has already asked for. */
		const requested = new Set();

		/** Visual language copied from the host stats pills and stat dialogs. */
		const CSS = [
			'.dshSpend_root{min-width:0;display:inline-flex}',
			'.dshSpend_pill{min-width:0;height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);font-variant-numeric:tabular-nums;line-height:calc(24px + var(--dsh-content-font-delta,0px));white-space:nowrap;cursor:pointer;background:0 0;border:none;align-items:center;gap:4px;padding:6px 8px;display:inline-flex}',
			'.dshSpend_pill:hover,.dshSpend_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}',
			'.dshSpend_pill svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px));flex:none}',
			'.dshSpend_label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
			'@media (width<=480px){.dshSpend_pill{width:calc(28px + var(--dsh-content-font-delta,0px));justify-content:center;padding:6px}.dshSpend_pill .dshSpend_label{display:none}}',
			'.dshSpend_panel{position:fixed;z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px}',
			'.dshSpend_title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}',
			'.dshSpend_titleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}',
			'.dshSpend_titleLabel svg{width:14px;height:14px;flex:none}',
			'.dshSpend_titleValue{font-variant-numeric:tabular-nums}',
			'.dshSpend_rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
			'.dshSpend_details{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}',
			'.dshSpend_term{min-width:0;margin:0;overflow-wrap:anywhere}',
			'.dshSpend_value{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right;min-width:0;margin:0}',
			'.dshSpend_gap{grid-column:1/-1;height:6px}',
			// The message action row puts the harness's token figure and the clock in
			// one `endInfo` cell that has no slot between them. `display:contents`
			// dissolves that cell so the three become siblings of the row, and `order`
			// seats the money between them: … 分支 · token用量 · 金额 · 时间.
			'[class*="_endInfo"]{display:contents}',
			// The dissolved cell's first child is the harness's token figure; seat it
			// after the speed reading and before the money.
			'[class*="_endInfo"] > *:first-child{order:2}',
			'[class*="_timeEnd"]{order:4}',
			'.dshSpend_speed{order:1;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;align-items:center;gap:4px;min-width:0;display:inline-flex}',
			'.dshSpend_action{order:3;min-width:0;display:inline-flex}',
		].join('');

		/**
		 * @param value - untrusted number.
		 * @returns the number, or 0.
		 */
		function num(value) {
			return typeof value === 'number' && Number.isFinite(value) ? value : 0;
		}

		/**
		 * Format an amount the way its currency is actually quoted.
		 * @param currency - `CNY` or `USD`.
		 * @param amount - amount in that currency.
		 * @returns display text.
		 */
		function money(currency, amount) {
			if (currency === 'CNY') {
				return `¥${amount.toFixed(amount < 10 ? 4 : 2)}`;
			}
			return `$${amount.toFixed(4)}`;
		}

		/**
		 * The automatic unpinned path: ask the host which provider each session
		 * actually used, fetch that provider's endpoint price, and post it
		 * session-scoped. The host's `priced` flag is the dedupe (so a host
		 * restart that lost the price causes one fresh fetch); this set only
		 * stops two concurrent components from fetching the same thing.
		 */
		const autoInFlight = new Set();
		async function ensureSessionPrices(sessionsKey) {
			if (sessionsKey === '') return;
			const sessions = sessionsKey.split(',').filter((id) => id !== '');
			if (sessions.length === 0) return;
			let body;
			try {
				const response = await fetch(`${UPSTREAM_URL}?sessions=${encodeURIComponent(sessionsKey)}&x=${String(Date.now())}`, {
					cache: 'no-store',
					headers: { accept: 'application/json' },
				});
				if (!response.ok) return;
				body = await response.json();
			} catch {
				return;
			}
			const jobs = [];
			for (const [sessionId, entry] of Object.entries(body?.sessions ?? {})) {
				for (const [model, info] of Object.entries(entry?.models ?? {})) {
					if (info?.pinned === true) continue;
					// The host already has a price for this session/model (it
					// survives page refreshes and plugin reloads).
					if (info?.priced === true) continue;
					if (typeof info?.provider !== 'string' || info.provider === '') continue;
					const key = `${sessionId}|${model}|${info.provider}`;
					if (autoInFlight.has(key)) continue;
					autoInFlight.add(key);
					const job = (async () => {
						let posted = false;
						try {
							const response = await fetch(`${endpointsUrl(model)}?x=${String(Date.now())}`, {
								cache: 'no-store',
								headers: { accept: 'application/json' },
							});
							if (!response.ok) return;
							const catalogue = await response.json();
							const endpoints = Array.isArray(catalogue?.data?.endpoints) ? catalogue.data.endpoints : [];
							const endpoint = pickProviderEndpoint(endpoints, info.provider);
							if (endpoint === undefined) return;
							const numbers = readNumbers(endpoint);
							const written = await fetch(PRICE_URL, {
								method: 'POST',
								headers: { 'content-type': 'application/json', accept: 'application/json' },
								body: JSON.stringify({
									model,
									input: numbers.input,
									output: numbers.output,
									cacheRead: numbers.cacheRead,
									scope: 'session',
									session: sessionId,
								}),
							});
							posted = written.ok;
						} catch {
							/* leave this session unpriced; a later message retries */
						} finally {
							autoInFlight.delete(key);
						}
						if (posted) {
							try {
								window.dispatchEvent(new Event('spend-pin:price'));
							} catch {
								/* a page without events is still fine */
							}
						}
					})();
					jobs.push(job);
				}
			}
			await Promise.allSettled(jobs);
		}

		/**
		 * Read the host's USD amounts for the sessions on screen. One local GET
		 * per distinct session set; every pill and message action sharing a key
		 * shares that read. The settings price hand-off bumps a revision.
		 *
		 * @param ids - session ids (this session, its children, carried children).
		 * @param stamp - projection settlement time, so a new message never reuses stale data.
		 * @returns session id -> `{ USD, before, turns, models }`, or null.
		 */
		const usdReads = new Map();
		function useUsdSpend(ids, stamp) {
			const [sessions, setSessions] = React.useState(null);
			const [revision, setRevision] = React.useState(0);
			const sessionsKey = ids.filter((id) => typeof id === 'string' && id !== '').join(',');
			const key = `${sessionsKey}|${String(stamp ?? 0)}`;
			React.useEffect(() => {
				const onPrice = () => setRevision((value) => value + 1);
				window.addEventListener('spend-pin:price', onPrice);
				return () => window.removeEventListener('spend-pin:price', onPrice);
			}, []);
			React.useEffect(() => {
				if (sessionsKey === '') {
					setSessions(null);
					return undefined;
				}
				let cancelled = false;
				let entry = usdReads.get(key);
				if (entry === undefined || entry.revision !== revision) {
					const listeners = new Set();
					const previous = entry?.data ?? null;
					entry = { revision, data: previous, listeners };
					usdReads.set(key, entry);
					if (usdReads.size > 64) {
						const oldest = usdReads.keys().next();
						if (oldest.done !== true) usdReads.delete(oldest.value);
					}
					const current = entry;
					void (async () => {
						let data = previous;
						try {
							await ensureSessionPrices(sessionsKey);
							const response = await fetch(`${SPEND_URL}?sessions=${encodeURIComponent(sessionsKey)}&x=${String(Date.now())}`, {
								cache: 'no-store',
								headers: { accept: 'application/json' },
							});
							if (response.ok) {
								const body = await response.json();
								if (body?.sessions !== null && typeof body?.sessions === 'object') data = body.sessions;
							}
						} catch {
							/* the host route is optional; keep the projection's number */
						}
						current.data = data;
						for (const listener of current.listeners) listener(data);
					})();
				}
				const listener = (data) => {
					if (!cancelled) setSessions(data);
				};
				entry.listeners.add(listener);
				if (entry.data !== null) setSessions(entry.data);
				return () => {
					cancelled = true;
					entry.listeners.delete(listener);
				};
			}, [key, revision, sessionsKey]);
			return sessions;
		}

		/**
		 * Replace a projection value's USD half with the host's book-priced half.
		 * CNY, subagents and the message→turn index stay exactly as folded.
		 *
		 * @param spend - one session's projection value.
		 * @param usd - that session's host USD reading, or undefined.
		 * @returns the merged value.
		 */
		function withUsd(spend, usd) {
			if (spend === null || spend === undefined || usd === null || usd === undefined) return spend;
			const turns = { ...(spend.turns ?? {}) };
			for (const turn of Object.keys(turns)) {
				const row = usd.turns?.[turn];
				if (row === undefined) {
					// A CNY-only turn keeps its own unpriced count; its USD half is zero.
					if (num(turns[turn].USD) !== 0) turns[turn] = { ...turns[turn], USD: 0 };
					continue;
				}
				turns[turn] = { ...turns[turn], USD: num(row.cost), unpriced: num(row.unpriced) };
			}
			for (const [turn, row] of Object.entries(usd.turns ?? {})) {
				if (turns[turn] !== undefined) continue;
				turns[turn] = { CNY: 0, USD: num(row.cost), unpriced: num(row.unpriced), models: [] };
			}
			const models = [
				...(Array.isArray(spend.models) ? spend.models.filter((row) => row?.currency !== 'USD') : []),
				...(Array.isArray(usd.models) ? usd.models : []),
			];
			return {
				...spend,
				USD: usd.USD,
				before: { ...(spend.before ?? {}), USD: usd.before },
				models,
				turns,
			};
		}

		/**
		 * Name the API that bills a provider id.
		 * @param provider - provider id from the route.
		 * @returns a display name.
		 */
		function apiLabel(provider) {
			const id = String(provider ?? '').toLowerCase();
			if (id.includes('openrouter')) return 'OpenRouter';
			if (id.includes('deepseek')) return 'DeepSeek 官方';
			return provider === undefined || provider === '' ? '未知 API' : String(provider);
		}

		/**
		 * The label for one route row.
		 * @param route - merged route row.
		 * @returns display text.
		 */
		function routeLabel(route) {
			return `${apiLabel(route?.provider)} ${modelLabel(route?.model)}`;
		}

		/**
		 * The bare model name, without the vendor namespace the route carries.
		 * @param model - model id from the route.
		 * @returns display text.
		 */
		function modelLabel(model) {
			const text = String(model ?? '');
			const at = text.lastIndexOf('/');
			return at === -1 ? text : text.slice(at + 1);
		}

		/**
		 * The currency a session's routes bill in, for the zero-spend case: its own
		 * routes first, then whatever the branch it came from had already used.
		 * @param spend - one session's wire value.
		 * @param hints - wire values whose currencies may stand in (the branch point).
		 * @returns `CNY` or `USD`.
		 */
		function defaultCurrency(spend, hints) {
			const rows = Array.isArray(spend?.models) ? spend.models : [];
			for (const row of rows) {
				if (row?.currency === 'CNY' || row?.currency === 'USD') return row.currency;
			}
			for (const hint of hints ?? []) {
				if (num(hint?.USD?.requests) > 0) return 'USD';
				if (num(hint?.CNY?.requests) > 0) return 'CNY';
			}
			return 'CNY';
		}

		/**
		 * Quote one currency bucket, flagging whatever the price list missed.
		 * @param currency - `CNY` or `USD`.
		 * @param bucket - the wire bucket.
		 * @returns display text.
		 */
		function bucketText(currency, bucket) {
			const cost = num(bucket?.cost);
			if (num(bucket?.unpriced) === 0) return money(currency, cost);
			return cost > 0 ? `${money(currency, cost)}?` : (currency === 'CNY' ? '¥?' : '$?');
		}

		/**
		 * Quote the session total: priced money only. A USD bucket with no priced
		 * row is left out entirely instead of showing `$?`; a partially priced
		 * USD bucket shows the known amount without a question mark.
		 * @param spend - the summed buckets.
		 * @param hints - wire values whose currencies may stand in for an empty one.
		 * @returns display text.
		 */
		function totalText(spend, ...hints) {
			const parts = [];
			const cny = spend?.CNY;
			if (num(cny?.requests) > 0 || num(cny?.cost) > 0) parts.push(bucketText('CNY', cny));
			const usd = spend?.USD;
			if (num(usd?.cost) > 0) parts.push(money('USD', num(usd.cost)));
			if (parts.length === 0) return money(defaultCurrency(spend, hints), 0);
			return parts.join(' · ');
		}

		/**
		 * Quote one session's own spend, one entry per currency it used.
		 * @param spend - one session's wire value.
		 * @param hints - wire values whose currencies may stand in for an empty one.
		 * @returns display text.
		 */
		function spendText(spend, ...hints) {
			const parts = [];
			for (const currency of ['CNY', 'USD']) {
				const bucket = spend?.[currency];
				if (num(bucket?.requests) === 0 && num(bucket?.cost) === 0) continue;
				parts.push(bucketText(currency, bucket));
			}
			if (parts.length === 0) return money(defaultCurrency(spend, hints), 0);
			return parts.join(' · ');
		}

		/**
		 * Quote a subagent's spend, or mark it unknown while its projection value
		 * has not arrived — never a confident zero for work that may be billed.
		 * @param spend - the child session's wire value, if any.
		 * @returns display text.
		 */
		function childAmount(spend) {
			if (spend === undefined || spend === null) return '—';
			return spendText(spend);
		}

		/**
		 * Sum parent plus subagent spend.
		 * @param spends - every wire value in the session tree.
		 * @returns totals per currency.
		 */
		function totalSpend(spends) {
			const totals = { CNY: { cost: 0, requests: 0, unpriced: 0 }, USD: { cost: 0, requests: 0, unpriced: 0 } };
			for (const spend of spends) {
				for (const currency of ['CNY', 'USD']) {
					totals[currency].cost += num(spend?.[currency]?.cost);
					totals[currency].requests += num(spend?.[currency]?.requests);
					totals[currency].unpriced += num(spend?.[currency]?.unpriced);
				}
			}
			return totals;
		}

		/**
		 * Merge every route in the tree into one row per API and model.
		 * @param spends - every wire value in the session tree.
		 * @returns rows, dearest first.
		 */
		function routeRows(spends) {
			const merged = new Map();
			for (const spend of spends) {
				const rows = Array.isArray(spend?.models) ? spend.models : [];
				for (const row of rows) {
					if (row === null || typeof row !== 'object') continue;
					const key = `${String(row.provider)}\u0000${String(row.model)}\u0000${String(row.currency)}`;
					const current = merged.get(key) ?? {
						provider: row.provider,
						model: row.model,
						currency: row.currency,
						cost: 0,
						unpriced: 0,
					};
					current.cost += num(row.cost);
					current.unpriced += num(row.unpriced);
					merged.set(key, current);
				}
			}
			return [...merged.values()].sort((left, right) => right.cost - left.cost);
		}

		/**
		 * Quote one merged route row.
		 * @param row - a merged route row.
		 * @returns display text.
		 */
		function routeText(row) {
			const currency = row.currency === 'CNY' ? 'CNY' : 'USD';
			const cost = num(row.cost);
			if (currency === 'USD') return money('USD', cost);
			if (num(row.unpriced) === 0) return money('CNY', cost);
			return cost > 0 ? `${money('CNY', cost)}?` : '¥?';
		}

		/**
		 * The session's direct subagents, in discovery order.
		 *
		 * The host folds the parent's own `subagent/catalog` events into the
		 * `subagents` list of this session's projection, so the ids arrive with
		 * the very value the pill already reads. DSH's own catalog projection is
		 * used only as a fallback, and the session list as a last one.
		 *
		 * @param spend - this session's own wire value.
		 * @param projections - `projectionsBySession` from the session list.
		 * @param byId - the session list rows.
		 * @param sessionId - the current session.
		 * @returns child session ids.
		 */
		function childIds(spend, projections, byId, sessionId) {
			const ids = [];
			const declared = Array.isArray(spend?.subagents) ? spend.subagents : [];
			for (const entry of declared) {
				const id = typeof entry === 'string' ? entry : entry?.id;
				if (typeof id === 'string' && !ids.includes(id)) ids.push(id);
			}
			const catalog = projections?.[sessionId]?.values?.subagentCatalog;
			if (Array.isArray(catalog)) {
				for (const entry of catalog) {
					if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && !ids.includes(entry.id)) {
						ids.push(entry.id);
					}
				}
			}
			if (byId === null || typeof byId !== 'object') return ids;
			for (const id of Object.keys(byId)) {
				if (id === sessionId || ids.includes(id)) continue;
				const row = byId[id];
				if (row?.origin === 'subagent' && row?.parentId === sessionId) ids.push(id);
			}
			return ids;
		}

		/**
		 * One child's spend: its loaded projection store first, because a cold
		 * child has no row in the session list at all, then that row if present.
		 * @param id - child session id.
		 * @param projections - `projectionsBySession`.
		 * @param byId - the session list rows.
		 * @returns the child's wire value, or undefined while it is not loaded.
		 */
		function childSpend(id, projections, byId) {
			return projections?.[id]?.values?.sessionSpend ?? byId?.[id]?.projectionValues?.sessionSpend;
		}

		/**
		 * Local stand-in for the host's `useAnchoredPosition`, used only when the
		 * primitives entry does not resolve: place the panel above the anchor.
		 * @param options - `open`, `anchorRef`, `panelRef`, `gap`, `margin`.
		 * @returns `{left, top}`, or null while unmeasured.
		 */
		function useLocalAnchor({ open, anchorRef, panelRef, gap = PANEL_GAP, margin = PANEL_MARGIN }) {
			const [pos, setPos] = React.useState(null);
			React.useEffect(() => {
				if (!open) {
					setPos(null);
					return undefined;
				}
				const place = () => {
					const anchor = anchorRef.current?.getBoundingClientRect();
					const panel = panelRef.current;
					if (anchor === undefined || panel === null) return;
					const width = panel.offsetWidth;
					const height = panel.offsetHeight;
					setPos({
						left: Math.min(Math.max(margin, anchor.left), Math.max(margin, window.innerWidth - width - margin)),
						top: Math.max(margin, anchor.top - gap - height),
					});
				};
				place();
				window.addEventListener('resize', place);
				window.addEventListener('scroll', place, true);
				return () => {
					window.removeEventListener('resize', place);
					window.removeEventListener('scroll', place, true);
				};
			}, [open, anchorRef, panelRef, gap, margin]);
			return pos;
		}

		/**
		 * Local stand-in for the host's `useDismissOnOutsidePointer`.
		 * @param rootRef - the trigger's element.
		 * @param open - whether the panel is open.
		 * @param setOpen - open-state writer.
		 * @param panelRef - the portaled panel's element.
		 */
		function useLocalOutsideDismiss(rootRef, open, setOpen, panelRef) {
			React.useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					const target = event.target;
					if (rootRef.current?.contains(target) === true) return;
					if (panelRef?.current?.contains(target) === true) return;
					setOpen(false);
				};
				document.addEventListener('pointerdown', onPointerDown);
				return () => {
					document.removeEventListener('pointerdown', onPointerDown);
				};
			}, [rootRef, panelRef, open, setOpen]);
		}

		/** The host's placement and dismissal hooks, or equivalent local ones. */
		const useAnchoredPosition = primitive('useAnchoredPosition') ?? useLocalAnchor;
		const useDismissOnOutsidePointer = primitive('useDismissOnOutsidePointer') ?? useLocalOutsideDismiss;

		/**
		 * The trigger-anchored dialog seat both money pills use: open state,
		 * clamped placement above the trigger, outside-pointer and Escape close —
		 * the same behaviour the harness's own stats dialogs have.
		 * @returns the seat; spread `pos ?? MEASURE_STYLE` onto the portaled panel.
		 */
		function useSpendDialog() {
			const [open, setOpen] = React.useState(false);
			const rootRef = React.useRef(null);
			const panelRef = React.useRef(null);
			const pos = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: PANEL_GAP, margin: PANEL_MARGIN });
			useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);
			React.useEffect(() => {
				if (!open) return undefined;
				const onKeyDown = (event) => {
					if (event.key === 'Escape') setOpen(false);
				};
				document.addEventListener('keydown', onKeyDown);
				return () => {
					document.removeEventListener('keydown', onKeyDown);
				};
			}, [open]);
			return { open, setOpen, rootRef, panelRef, pos };
		}

		/**
		 * A banknote, drawn to the host icon conventions (16px box, 1px stroke):
		 * the harness ships no currency icon, and the database icon it uses for
		 * token figures must not be repeated here.
		 * @returns the icon element.
		 */
		function IconBanknote() {
			return h('svg', {
				viewBox: '0 0 16 16',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1,
				'aria-hidden': true,
			},
			h('rect', { x: 1.5, y: 4.2, width: 13, height: 7.6, rx: 1.7 }),
			h('circle', { cx: 8, cy: 8, r: 1.9 }),
			h('path', { d: 'M4.2 6.4v3.2' }),
			h('path', { d: 'M11.8 6.4v3.2' }));
		}

		/**
		 * The spend pill plus its breakdown dialog.
		 * @param props - the session standard seat, plus the projection loader.
		 * @returns the pill, or null while nothing in the tree has been billed.
		 */
		function SpendPill({ useProjection, useSessions, sessionId, refreshProjections }) {
			const spend = useProjection === undefined ? undefined : useProjection('sessionSpend');
			const byId = useSessions === undefined ? undefined : useSessions((state) => state.byId);
			const projections = useSessions === undefined ? undefined : useSessions((state) => state.projectionsBySession);
			const { open, setOpen, rootRef, panelRef, pos } = useSpendDialog();

			const children = sessionId === undefined ? [] : childIds(spend, projections, byId, sessionId);
			const childSpends = children.map((id) => childSpend(id, projections, byId));
			// Money carried in from the branch point. A branched Session's log opens
			// with a copy of its parent's history; the host prices those events into
			// `before` and names the subagents that had already run there — their
			// spend is read from their own Sessions and counts as 分支前 too.
			const carriedSpends = (Array.isArray(spend?.before?.subagents) ? spend.before.subagents : [])
				.map((id) => childSpend(id, projections, byId));
			// USD is not the projection's frozen number: the host computes it from
			// the tokens it recorded and the price book the settings box posted.
			const usdSpends = useUsdSpend([sessionId, ...children, ...(Array.isArray(spend?.before?.subagents) ? spend.before.subagents : [])]
				.filter((id) => typeof id === 'string'), spend?.lastTimeMs);
			const currentSpend = withUsd(spend, sessionId === undefined ? undefined : usdSpends?.[sessionId]);
			const mergedChildSpends = childSpends.map((child, index) => withUsd(child, usdSpends?.[children[index]]));
			const mergedCarriedSpends = carriedSpends.map((child, index) => withUsd(child, usdSpends?.[spend?.before?.subagents?.[index]]));
			const spends = [currentSpend, ...mergedChildSpends];
			const totals = totalSpend(spends);
			const carried = currentSpend?.before;
			const carriedChildren = Array.isArray(carried?.subagents) ? carried.subagents : [];
			const carriedTotals = totalSpend(mergedCarriedSpends);
			const beforeCny = num(carried?.CNY?.cost) + carriedTotals.CNY.cost;
			const beforeUsd = num(carried?.USD?.cost) + carriedTotals.USD.cost;
			const beforeRequests = num(carried?.CNY?.requests) + num(carried?.USD?.requests) + carriedTotals.CNY.requests + carriedTotals.USD.requests;
			const branched = beforeRequests > 0;
			const beforeBucket = {
				CNY: { cost: beforeCny, requests: num(carried?.CNY?.requests) + carriedTotals.CNY.requests, unpriced: num(carried?.CNY?.unpriced) },
				USD: { cost: beforeUsd, requests: num(carried?.USD?.requests) + carriedTotals.USD.requests, unpriced: num(carried?.USD?.unpriced) },
			};
			const beforeText = branched ? totalText(beforeBucket, carried) : totalText({ CNY: carried?.CNY, USD: carried?.USD });
			// A branch that has not spent anything yet still belongs to the currency
			// its inherited history used — never a bare ¥0.0000 for a USD tree.
			const afterText = totalText({ CNY: totals.CNY, USD: totals.USD }, currentSpend, carried);
			// The headline is the whole tree from the branch point on: 分支前 + 分支后.
			// Request counts are the real ones: a currency nobody billed stays out of
			// the line, instead of being forced in as a meaningless ¥0.0000.
			const label = branched
				? totalText({
					CNY: {
						cost: totals.CNY.cost + beforeCny,
						requests: num(carried?.CNY?.requests) + carriedTotals.CNY.requests + totals.CNY.requests,
						unpriced: totals.CNY.unpriced + num(carried?.CNY?.unpriced),
					},
					USD: {
						cost: totals.USD.cost + beforeUsd,
						requests: num(carried?.USD?.requests) + carriedTotals.USD.requests + totals.USD.requests,
						unpriced: totals.USD.unpriced + num(carried?.USD?.unpriced),
					},
				}, carried)
				: afterText;
			const routes = routeRows(spends)
				.filter((row) => row.currency !== 'USD' || num(row.cost) > 0);
			const key = children.concat(carriedChildren).join(',');

			/**
			 * The host reads a Session's projections only on demand, so a child
			 * this page has never opened carries no value at all. Ask for every
			 * child that has none — each id once per page, and again on reopening
			 * so a failed read has a way to recover. This session's own value
			 * needs no request: the pill only renders because it arrived.
			 */
			React.useEffect(() => {
				if (refreshProjections === undefined) return;
				// Pre-branch subagents count towards 分支前, so their values are needed too.
				const wanted = children.concat(carriedChildren);
				if (open) {
					for (const id of wanted) {
						if (childSpend(id, projections, byId) === undefined) requested.delete(id);
					}
				}
				for (const id of wanted) {
					if (requested.has(id) || childSpend(id, projections, byId) !== undefined) continue;
					requested.add(id);
					refreshProjections(id);
				}
			}, [refreshProjections, key, open]); // eslint-disable-line react-hooks/exhaustive-deps

			if (spend === undefined || spend === null) return null;
			if (totals.CNY.requests + totals.USD.requests === 0) return null;

			const pill = h('button', {
				type: 'button',
				className: 'dshSpend_pill',
				'aria-haspopup': 'dialog',
				'aria-expanded': open,
				'aria-label': `本会话已用金额 ${label}`,
				onClick: () => { setOpen(!open); },
			}, h(IconBanknote, null), h('span', { className: 'dshSpend_label' }, label));

			/**
			 * The money grid: for a branched Session the branch point comes first
			 * (分支前金额 / 分支后金额), then one row per subagent, then the routes.
			 */
			const rows = [];
			if (branched) {
				rows.push(h('span', { className: 'dshSpend_term', key: 't-before' }, '分支前金额'));
				rows.push(h('span', { className: 'dshSpend_value', key: 'v-before' }, beforeText));
				rows.push(h('span', { className: 'dshSpend_term', key: 't-after' }, '分支后金额'));
				rows.push(h('span', { className: 'dshSpend_value', key: 'v-after' }, afterText));
			}
			children.forEach((id, index) => {
				rows.push(h('span', { className: 'dshSpend_term', key: `t-${id}` }, `子智能体${String(index + 1)}花费`));
				rows.push(h('span', { className: 'dshSpend_value', key: `v-${id}` }, childAmount(mergedChildSpends[index])));
			});
			if (routes.length > 0) rows.push(h('div', { className: 'dshSpend_gap', key: 'gap', 'aria-hidden': true }));
			routes.forEach((route, index) => {
				const id = `${String(route.provider)}/${String(route.model)}/${String(index)}`;
				rows.push(h('span', { className: 'dshSpend_term', key: `t-${id}` }, routeLabel(route)));
				rows.push(h('span', { className: 'dshSpend_value', key: `v-${id}` }, routeText(route)));
			});

			const panel = open
				? reactDom.createPortal(h('div', {
					ref: panelRef,
					className: 'dshSpend_panel',
					role: 'dialog',
					'aria-label': '本会话金额明细',
					'data-session-spend': true,
					style: pos ?? MEASURE_STYLE,
				},
				h('div', { className: 'dshSpend_title' },
					h('span', { className: 'dshSpend_titleLabel' }, h(IconBanknote, null), '总花费'),
					h('span', { className: 'dshSpend_titleValue' }, label)),
				h('div', { className: 'dshSpend_rule', 'aria-hidden': true }),
				h('div', { className: 'dshSpend_details' }, rows)), document.body)
				: null;

			return h('div', { className: 'dshSpend_root', 'data-composer-spend': true, ref: rootRef },
				pill,
				panel);
		}

		/**
		 * Quote one turn the way the harness's token figure quotes it: the whole
		 * turn, per currency, or `¥?` when nothing in it could be priced.
		 * @param row - the wire turn row.
		 * @returns display text.
		 */
		function turnText(row) {
			const parts = [];
			for (const currency of ['CNY', 'USD']) {
				const cost = num(row?.[currency]);
				if (cost > 0) parts.push(money(currency, cost));
			}
			if (parts.length > 0) return parts.join(' · ');
			const first = Array.isArray(row?.models) ? row.models[0] : undefined;
			const currency = first?.currency === 'USD' ? 'USD' : 'CNY';
			return num(row?.unpriced) > 0 ? (currency === 'CNY' ? '¥?' : '$?') : money(currency, 0);
		}

		/**
		 * A wall-time reading in the user's units.
		 * @param ms - milliseconds.
		 * @returns display text.
		 */
		function durationText(ms) {
			const value = num(ms);
			if (value <= 0) return '—';
			if (value < 1000) return `${String(Math.round(value))} ms`;
			const seconds = value / 1000;
			return `${seconds >= 60 ? (seconds / 60).toFixed(1) + ' min' : seconds.toFixed(1) + ' s'}`;
		}

		/** A speed glyph for the pill. */
		function IconBolt() {
			return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
				h('path', {
					d: 'M9 1 3 9h3.5L6 15l6-8H8.5L9 1Z',
					stroke: 'currentColor',
					strokeWidth: 1.3,
					strokeLinejoin: 'round',
				}));
		}

		/**
		 * This Turn's timings, shown exactly like the harness's own session stats
		 * dialog: model time, tool time, average time to first token, decode speed.
		 * @param props - owner props (`messageId`) and the projection seat.
		 * @returns the pill and, while open, its portaled dialog.
		 */
		function TurnSpeedAction({ messageId, useProjection }) {
			const { open, setOpen, rootRef, panelRef, pos } = useSpendDialog();
			const spend = useProjection === undefined ? undefined : useProjection('sessionSpend');
			const turn = typeof messageId === 'string' ? spend?.messages?.[messageId] : undefined;
			const row = turn === undefined ? undefined : spend?.turns?.[turn];
			const speed = num(row?.tokensPerSecond);
			if (!(speed > 0)) return null;
			const text = speed >= 10 ? String(Math.round(speed)) : String(Math.round(speed * 10) / 10);
			const label = `${text} tok/s`;
			const ttft = num(row?.ttftSteps) > 0 ? num(row?.ttftMs) / num(row?.ttftSteps) : 0;

			const pill = h('button', {
				type: 'button',
				className: 'dshSpend_pill',
				'aria-haspopup': 'dialog',
				'aria-expanded': open,
				'aria-label': `本轮输出速度 ${label}`,
				onClick: () => { setOpen(!open); },
			}, h(IconBolt, null), h('span', { className: 'dshSpend_label' }, label));

			const rows = [];
			const pairs = [
				['模型用时', durationText(row?.llmMs)],
				['工具调用用时', durationText(row?.toolMs)],
				['首 token 平均（TTFT）', durationText(ttft)],
				['输出速度（TPS）', label],
			];
			pairs.forEach(([term, value], index) => {
				rows.push(h('span', { className: 'dshSpend_term', key: `t-${String(index)}` }, term));
				rows.push(h('span', { className: 'dshSpend_value', key: `v-${String(index)}` }, value));
			});

			const panel = open
				? reactDom.createPortal(h('div', {
					ref: panelRef,
					className: 'dshSpend_panel',
					role: 'dialog',
					'aria-label': '本轮统计',
					'data-turn-speed': true,
					style: pos ?? MEASURE_STYLE,
				},
				h('div', { className: 'dshSpend_title' },
					h('span', { className: 'dshSpend_titleLabel' }, h(IconBolt, null), '会话统计'),
					h('span', { className: 'dshSpend_titleValue' }, label)),
				h('div', { className: 'dshSpend_rule', 'aria-hidden': true }),
				h('div', { className: 'dshSpend_details' }, rows)), document.body)
				: null;

			return h('div', { className: 'dshSpend_speed', ref: rootRef, 'data-turn-speed': true }, pill, panel);
		}

		/**
		 * One Turn's spend, for the message action row — the figure beside the
		 * harness's own "this turn" token count, so it covers every assistant
		 * message in that turn rather than the message the row belongs to.
		 * The host indexes messages to turns, and a session with no billed turn
		 * renders nothing at all.
		 * @param props - the slot owner props (`messageId`) and the session seat.
		 * @returns the pill and, while open, its portaled dialog.
		 */
		function MessageSpendAction({ messageId, useProjection, sessionId }) {
			const { open, setOpen, rootRef, panelRef, pos } = useSpendDialog();
			const spend = useProjection === undefined ? undefined : useProjection('sessionSpend');
			const usdSpends = useUsdSpend(typeof sessionId === 'string' ? [sessionId] : [], spend?.lastTimeMs);
			const merged = withUsd(spend, typeof sessionId === 'string' ? usdSpends?.[sessionId] : undefined);
			const turn = typeof messageId === 'string' ? merged?.messages?.[messageId] : undefined;
			const row = turn === undefined ? undefined : merged?.turns?.[turn];
			if (row === undefined || row === null) return null;
			const amount = turnText(row);
			const compactions = num(row.compactions);
			const routes = (Array.isArray(row.models) ? row.models : [])
				.map((route) => routeLabel(route))
				.join(' · ');

			const pill = h('button', {
				type: 'button',
				className: 'dshSpend_pill',
				'aria-haspopup': 'dialog',
				'aria-expanded': open,
				'aria-label': `本轮花费 ${amount}`,
				onClick: () => { setOpen(!open); },
			}, h(IconBanknote, null), h('span', { className: 'dshSpend_label' }, amount));

			const panel = open
				? reactDom.createPortal(h('div', {
					ref: panelRef,
					className: 'dshSpend_panel',
					role: 'dialog',
					'aria-label': '本轮花费',
					'data-turn-spend': true,
					style: pos ?? MEASURE_STYLE,
				},
				h('div', { className: 'dshSpend_title' },
					h('span', { className: 'dshSpend_titleLabel' }, h(IconBanknote, null), '花费'),
					h('span', { className: 'dshSpend_titleValue' }, amount)),
				h('div', { className: 'dshSpend_rule', 'aria-hidden': true }),
				h('div', { className: 'dshSpend_details' },
					routes === '' ? null : h('span', { className: 'dshSpend_term' }, routes),
					compactions > 0
						? h('span', { className: 'dshSpend_term', style: { gridColumn: '1 / -1' } }, `压缩摘要*${String(compactions)}`)
						: null)), document.body)
				: null;

			return h('span', { className: 'dshSpend_action', ref: rootRef },
				pill,
				panel);
		}

		return {
			// `sessions` is the session controller service: without it in this
			// cordis inject list, reading `ctx.sessions` throws and the child
			// sessions could never be asked for their projections.
			inject: ['slots', 'sessions'],
			name: 'session-cost',
			/**
			 * Register the pill and keep the copied stylesheet mounted while the
			 * plugin is loaded.
			 * @param ctx - the client plugin context.
			 * @returns a disposer removing the style tag.
			 */
			apply(ctx) {
				const style = document.createElement('style');
				style.dataset.plugin = '@local/dsh-session-cost';
				style.textContent = CSS;
				document.head.appendChild(style);
				const sessions = (() => {
					try {
						return ctx.sessions;
					} catch {
						return undefined;
					}
				})();
				/** Hand the seat its projection loader, when the host service is injected. */
				const seat = (props) => h(SpendPill, {
					...props,
					refreshProjections: typeof sessions?.refreshProjections === 'function'
						? (id) => { try { sessions.refreshProjections(id); } catch { /* the host read path is optional */ } }
						: undefined,
				});
				ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
					name: 'conversation.composer.dock',
					id: 'session-cost',
					// The harness fills this row with two cells: `activity` (order 0) and
					// `usage` (order 1, the token/cache-hit figure). 2 seats the money
					// immediately after the token figure.
					order: 2,
				}, seat));
				// The message action row. The slot renders beside the feedback buttons;
				// the pill's own CSS `order` (see `.dshSpend_action`) then seats it
				// between the token figure and the clock, which the harness draws as
				// one cell with no insertion point of its own.
				// The Turn's output speed, rendered before the harness's own token figure.
				ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
					name: 'conversation.chat.assistant-actions',
					id: 'session-cost-speed',
					order: 50,
				}, TurnSpeedAction));
				ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
					name: 'conversation.chat.assistant-actions',
					id: 'session-cost',
					order: 100,
				}, MessageSpendAction));
				return () => {
					style.remove();
				};
			},
		};
}
