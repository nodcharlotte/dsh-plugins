/**
 * Live code (client half).
 *
 * Opens a right-sidebar tab for every file the agent touches with `read`,
 * `write` or `edit`, showing that file with line numbers, the changed lines
 * highlighted, the view scrolled to the change, and the harness's own syntax
 * colours.
 *
 * One tab per *file*, not per operation: the tab is addressed as a
 * `dsh-resource://live-code/<file>` resource, so editing the same file again
 * re-uses its tab (and its chip, which decodes the file name from the address).
 * Nothing here carries a placement or size option, and the body never reports
 * room, so the sidebar keeps the width the user chose.
 *
 * @module @local/dsh-live-code/client
 */
window.__ModuleLoader__.load({
	id: '@local/dsh-live-code',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		/** Host building blocks: the code highlighter and the path -> language table. */
		const primitives = (() => {
			try {
				return require('@deepseek-ai/dsh-client-ui-primitives');
			} catch {
				return undefined;
			}
		})();

		/**
		 * Read one export off the primitives namespace, whichever shape the loader hands back.
		 * @param name - export name.
		 * @returns the export, or undefined.
		 */
		function primitive(name) {
			if (primitives === undefined || primitives === null) return undefined;
			return primitives[name] ?? primitives.default?.[name];
		}

		const useCodeHighlighter = primitive('useCodeHighlighter');
		const languageForPath = primitive('languageForPath');

		/** The tab kind this plugin owns. */
		const KIND = 'live-code';
		/** Resource addresses: one per file, so a file keeps one tab for good. */
		const ADDRESS_PREFIX = `dsh-resource://${KIND}/`;
		/** Tool name -> how the header names it. */
		const TOOL_LABEL = { read: '读取', write: '写入', edit: '编辑' };
		/** Operations whose tab this page has already opened or adopted. */
		const opened = new Set();
		/** The follow-scroll preference: remembered for every tab, and across reloads. */
		const FOLLOW_KEY = 'dsh-live-code:follow';
		let followPreference = (() => {
			try {
				const stored = window.localStorage?.getItem(FOLLOW_KEY);
				return stored === null || stored === undefined ? true : stored === 'true';
			} catch {
				return true;
			}
		})();

		/**
		 * Persist the follow preference so every tab — and the next page load — agrees.
		 * @param value - the new preference.
		 */
		function rememberFollow(value) {
			followPreference = value;
			try {
				window.localStorage?.setItem(FOLLOW_KEY, String(value));
			} catch { /* private mode: the preference just will not survive a reload */ }
		}

		/** Visual language borrowed from the harness's own panels: theme tokens only. */
		const CSS = [
			// The panel wears the harness document-preview surface, so a file opened
			// here looks like the same file opened from the Files tab. `--shiki-*`
			// only exists inside shiki's own element, so it cannot paint a container.
			'.dshLive_root{box-sizing:border-box;min-height:0;height:100%;background:var(--dsw-alias-bg-document-preview,var(--dsw-specific-menu));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;flex-direction:column;display:flex}',
			'.dshLive_head{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:8px 12px;gap:4px;flex-direction:column;flex:none;display:flex}',
			'.dshLive_headline{align-items:center;gap:8px;display:flex}',
			'.dshLive_name{color:var(--dsw-alias-label-primary);font-weight:500;text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
			'.dshLive_badge{border:1px solid var(--dsw-alias-border-l1);border-radius:4px;color:var(--dsw-alias-label-tertiary);flex:none;padding:0 5px;font-size:11px}',
			'.dshLive_status{color:var(--dsw-alias-label-tertiary);flex:none}',
			'.dshLive_follow{align-items:center;gap:4px;color:var(--dsw-alias-label-tertiary);cursor:pointer;margin-left:auto;flex:none;display:inline-flex}',
			'.dshLive_path{color:var(--dsw-alias-label-tertiary);direction:rtl;text-align:left;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
			'.dshLive_body{min-height:0;flex:auto;overflow:auto;padding:6px 0;background:var(--dsw-alias-bg-document-preview,var(--dsw-specific-menu))}',
			'.dshLive_code{margin:0;font-family:var(--dsh-font-family-mono,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace));font-size:12px;line-height:20px;white-space:pre;tab-size:2;display:block}',
			'.dshLive_line{min-width:max-content;display:flex}',
			'.dshLive_no{color:var(--dsw-alias-label-tertiary);width:52px;text-align:right;padding-right:12px;flex:none;user-select:none;font-variant-numeric:tabular-nums}',
			'.dshLive_text{white-space:pre;padding-right:16px}',
			'.dshLive_changed{background:var(--dsw-alias-interactive-bg-hover);box-shadow:inset 3px 0 0 var(--dsw-alias-state-business-primary)}',
			'.dshLive_targetNo{color:var(--dsw-alias-state-business-primary);font-weight:600}',
			'.dshLive_note{color:var(--dsw-alias-label-tertiary);margin:0;padding:14px 12px}',
			'.dshLive_foot{border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);padding:4px 12px;flex:none}',
		].join('');

		/**
		 * The file's last path segment.
		 * @param path - full path.
		 * @returns the file name.
		 */
		function basename(path) {
			const text = String(path ?? '');
			const at = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
			return at === -1 ? text : text.slice(at + 1);
		}

		/**
		 * The resource address that owns one file's tab.
		 * @param path - file path.
		 * @returns the address.
		 */
		function addressFor(path) {
			return ADDRESS_PREFIX + encodeURIComponent(String(path ?? ''));
		}

		/**
		 * The file a tab is about: from its params, else decoded from its address.
		 * @param navigation - the tab's navigation record.
		 * @returns the path, or an empty string.
		 */
		function pathOf(navigation) {
			const fromParams = navigation?.params?.path;
			if (typeof fromParams === 'string' && fromParams !== '') return fromParams;
			const address = typeof navigation?.address === 'string' ? navigation.address : '';
			return address.startsWith(ADDRESS_PREFIX) ? decodeURIComponent(address.slice(ADDRESS_PREFIX.length)) : '';
		}

		/**
		 * The newest shipped operation for one file.
		 * @param wire - the projection value.
		 * @param path - the file path.
		 * @returns the wire entry, or undefined.
		 */
		function entryForPath(wire, path) {
			if (path === '') return undefined;
			return (wire?.ops ?? []).find((row) => row.op?.path === path);
		}

		/**
		 * The running call that is about to touch one file, with its payload.
		 *
		 * DSH hands tool views complete arguments only once the call starts
		 * (`StartedToolCall.argsRaw`); a `preparing` call carries none ("arguments
		 * are not yet available to tool views"). So this is the earliest moment the
		 * incoming text exists at all — there is no per-character stream to read.
		 *
		 * @param running - `useChat((s) => s.runningCalls)`.
		 * @param path - the file this tab is about.
		 * @returns `{tool, text}` while the file is being written, else undefined.
		 */
		function incomingFor(running, path) {
			if (path === '') return undefined;
			for (const call of running ?? []) {
				if (call?.phase !== 'start' || typeof call?.argsRaw !== 'string') continue;
				if (typeof call.name !== 'string' || TOOL_LABEL[call.name] === undefined) continue;
				let args;
				try {
					args = JSON.parse(call.argsRaw);
				} catch {
					continue;
				}
				if (args?.file_path !== path) continue;
				const text = call.name === 'write' ? args.content : call.name === 'edit' ? args.new_string : undefined;
				return { tool: call.name, text: typeof text === 'string' ? text : undefined };
			}
			return undefined;
		}

		/**
		 * Reveal incoming text a slice at a time, so code appears while the tool
		 * runs. Hosts without timers (tests included) draw it all at once.
		 * @param text - the incoming payload.
		 * @returns how many characters to draw.
		 */
		function useReveal(text) {
			const total = typeof text === 'string' ? text.length : 0;
			const animated = typeof setInterval === 'function' && total > 64;
			const [shown, setShown] = React.useState(animated ? 0 : total);
			React.useEffect(() => {
				if (!animated) return undefined;
				setShown(0);
				const step = Math.max(1, Math.ceil(total / 40));
				const timer = setInterval(() => {
					setShown((current) => {
						const next = current + step;
						if (next >= total) {
							clearInterval(timer);
							return total;
						}
						return next;
					});
				}, 24);
				return () => { clearInterval(timer); };
			}, [text, total, animated]);
			return animated ? Math.min(shown, total) : total;
		}

		/**
		 * A synthetic file record for text still arriving: every line counts as
		 * changed and the jump target is the last one, so the view follows along.
		 * @param text - the incoming payload.
		 * @returns a wire file record.
		 */
		function incomingFile(text) {
			const all = String(text ?? '').split('\n');
			const cap = 400;
			const truncated = all.length > cap;
			const kept = truncated ? all.slice(0, cap) : all;
			return {
				total: all.length,
				from: 1,
				to: kept.length,
				truncated,
				changed: { from: 1, to: kept.length },
				target: kept.length,
				lines: kept.map((line, index) => [index + 1, line]),
			};
		}

		/**
		 * Why a file could not be shown, in the user's words.
		 * @param file - the wire file record.
		 * @returns display text.
		 */
		function errorText(file) {
			const error = file?.error;
			if (error === 'binary') return '这是二进制文件，不能按文本显示';
			if (error === 'too-large') return `文件过大（约 ${String(Math.round((file?.bytes ?? 0) / 1024))} KB），未显示正文`;
			if (error === 'ENOENT') return '文件不存在：可能刚被删除，或还没创建';
			if (error === 'not-a-file') return '这个路径不是普通文件';
			return `无法读取：${String(error)}`;
		}

		/**
		 * One rendered line: its number, its tokens, and its highlight classes.
		 * @param props - line number, text, tokens, changed/target flags.
		 * @returns the row element.
		 */
		function CodeLine({ number, text, spans, changed, target }) {
			const classes = `dshLive_line${changed ? ' dshLive_changed' : ''}`;
			const body = spans === undefined
				? text
				: spans.map((span, index) => h('span', { key: index, style: span.style }, span.text));
			return h('div', { className: classes, 'data-line': number },
				h('span', { className: `dshLive_no${target ? ' dshLive_targetNo' : ''}` }, String(number)),
				h('span', { className: 'dshLive_text' }, body));
		}

		/**
		 * The code, with a number gutter, changed lines highlighted, syntax colours
		 * from the harness's highlighter, and the view scrolled to the change.
		 * @param props - the wire file record, the follow flag, a highlighter and the path.
		 * @returns the scrollable code body.
		 */
		function CodeView({ file, follow, highlight, path }) {
			const bodyRef = React.useRef(null);
			const target = typeof file?.target === 'number' ? file.target : null;
			const lines = file?.lines;
			const text = (lines ?? []).map(([, line]) => line).join('\n');
			const spans = React.useMemo(() => {
				if (highlight === undefined || lines === undefined) return undefined;
				try {
					return highlight(text);
				} catch {
					return undefined;
				}
			}, [highlight, text, lines]);
			React.useEffect(() => {
				const body = bodyRef.current;
				if (body === null || follow !== true || target === null) return;
				const row = body.querySelector(`[data-line="${String(target)}"]`);
				if (row === null) return;
				body.scrollTop = Math.max(0, row.offsetTop - body.clientHeight / 3);
			}, [follow, target, file?.from, file?.to, file?.error]);
			if (file === null || file === undefined) return null;
			if (file.error !== undefined && file.error !== null) {
				return h('p', { className: 'dshLive_note' }, errorText(file));
			}
			const changed = file.changed ?? null;
			const rows = (lines ?? []).map(([number, line], index) => h(CodeLine, {
				key: number,
				number,
				text: line,
				spans: spans?.[index],
				changed: changed !== null && number >= changed.from && number <= changed.to,
				target: number === target,
			}));
			const foot = [];
			if (typeof path === 'string' && path !== '') foot.push(basename(path));
			if (file.truncated === true) foot.push(`${String(file.total)} 行，只显示 ${String(file.from)}–${String(file.to)}`);
			if (file.changed !== null && file.changed !== undefined) {
				foot.push(file.changed.from === file.changed.to
					? `变更行 ${String(file.changed.from)}`
					: `变更行 ${String(file.changed.from)}–${String(file.changed.to)}`);
			}
			return h('div', { className: 'dshLive_body', ref: bodyRef },
				h('pre', { className: 'dshLive_code' }, rows),
				foot.length === 0 ? null : h('div', { className: 'dshLive_foot' }, foot.join(' · ')));
		}

		/**
		 * One file's panel. The tab is addressed by file, so its content is the
		 * newest operation on that path — editing the file again updates this tab.
		 * @param props - the tab seat.
		 * @returns the panel.
		 */
		function LiveCodeTab({ useTabInfo, useProjection, useChat, close }) {
			const info = useTabInfo === undefined ? undefined : useTabInfo();
			const path = pathOf(info?.tab?.navigation);
			const tabId = info?.tab?.id;
			const wire = useProjection === undefined ? undefined : useProjection('liveCode');
			const [follow, setFollow] = React.useState(followPreference);
			const running = useChat === undefined ? undefined : useChat((state) => state.runningCalls);
			const incoming = incomingFor(running, path);
			const reveal = useReveal(incoming?.text);
			const language = languageForPath === undefined ? undefined : languageForPath(path);
			const highlight = useCodeHighlighter === undefined ? undefined : useCodeHighlighter(language);
			const entry = entryForPath(wire, path);
			// While the tool is still running, the incoming payload is all there is:
			// for a new file the disk read would still say "not created yet".
			const streaming = typeof incoming?.text === 'string' && incoming.text !== ''
				? { tool: incoming.tool, text: incoming.text.slice(0, reveal) }
				: undefined;
			// Nothing left to show: the operation aged out and no new call targets this
			// file. Such a tab is dead weight, so it closes itself.
			const empty = wire !== undefined && streaming === undefined && entry === undefined && incoming === undefined;
			React.useEffect(() => {
				if (empty && typeof tabId === 'string' && close !== undefined) close(tabId);
			}, [empty, tabId, close]);
			if (wire === undefined) {
				return h('div', { className: 'dshLive_root' }, h('p', { className: 'dshLive_note' }, '正在读取…'));
			}
			if (empty) {
				return h('div', { className: 'dshLive_root' }, h('p', { className: 'dshLive_note' }, '这个文件没有新的读写操作，正在关闭…'));
			}
			if (streaming === undefined && entry === undefined) {
				return h('div', { className: 'dshLive_root' },
					h('p', { className: 'dshLive_note' }, '等待这次操作的内容…'));
			}
			const tool = streaming === undefined ? entry.op.tool : streaming.tool;
			const status = streaming === undefined
				? (entry.op.status === 'running' ? '进行中' : '已完成')
				: (tool === 'edit' ? '编辑中' : '写入中');
			const file = streaming === undefined ? entry.file : incomingFile(streaming.text);
			return h('div', { className: 'dshLive_root' },
				h('div', { className: 'dshLive_head' },
					h('div', { className: 'dshLive_headline' },
						h('span', { className: 'dshLive_name' }, basename(path)),
						h('span', { className: 'dshLive_badge' }, TOOL_LABEL[tool] ?? String(tool)),
						h('span', { className: 'dshLive_status' }, status),
						h('label', { className: 'dshLive_follow' },
							h('input', {
								type: 'checkbox',
								checked: follow,
								onChange: () => {
									rememberFollow(!follow);
									setFollow(!follow);
								},
							}),
							'跟随')),
					h('div', { className: 'dshLive_path' }, path)),
				h(CodeView, { file, follow, highlight, path }));
		}

		/**
		 * The tab's chip text: decoded from the resource address, so it names the
		 * file even when the operation behind it is long gone.
		 * @param props - the tab seat.
		 * @returns the title element.
		 */
		function LiveCodeTitle({ useTabInfo }) {
			const info = useTabInfo === undefined ? undefined : useTabInfo();
			const path = pathOf(info?.tab?.navigation);
			return h('span', { className: 'dshLive_name' }, path === '' ? '实时代码' : basename(path));
		}

		/**
		 * The file a tab's content address names.
		 * @param address - a tab content id.
		 * @returns the path, or an empty string.
		 */
		function pathFromAddress(address) {
			const text = typeof address === 'string' ? address : '';
			return text.startsWith(ADDRESS_PREFIX) ? decodeURIComponent(text.slice(ADDRESS_PREFIX.length)) : '';
		}

		/**
		 * Every file this plugin still has something to show for: the paths in the
		 * shipped window, plus the files a running call is about to touch.
		 * @param wire - the projection value.
		 * @param running - `runningCalls`.
		 * @returns the live path set.
		 */
		function livePaths(wire, running) {
			const alive = new Set();
			for (const row of wire?.ops ?? []) {
				if (typeof row.op?.path === 'string') alive.add(row.op.path);
			}
			for (const call of running ?? []) {
				if (call?.phase !== 'start' || typeof call?.argsRaw !== 'string') continue;
				if (typeof call.name !== 'string' || TOOL_LABEL[call.name] === undefined) continue;
				try {
					const args = JSON.parse(call.argsRaw);
					if (typeof args?.file_path === 'string') alive.add(args.file_path);
				} catch { /* a call we cannot read keeps nothing alive */ }
			}
			return alive;
		}

		/**
		 * Opens — or re-reveals — the one tab that belongs to a file, and closes the
		 * tabs whose file no longer has anything to show. It renders nothing: only a
		 * mounted component can see the tab strip, and a tab's own body is not mounted
		 * until that tab is activated — which is why the cleanup has to live here.
		 * @param props - the composer seat plus `open`, `listTabs` and `close`.
		 * @returns null.
		 */
		function LiveCodeWatcher({ useProjection, useChat, open, listTabs, close }) {
			const wire = useProjection === undefined ? undefined : useProjection('liveCode');
			const running = useChat === undefined ? undefined : useChat((state) => state.runningCalls);
			const ops = wire?.ops ?? [];
			// A reload lands on the operations already recorded: adopt them silently
			// and open a tab only for what happens next.
			const primed = React.useRef(false);
			React.useEffect(() => {
				const alive = livePaths(wire, running);
				if (primed.current && listTabs !== undefined && close !== undefined) {
					for (const tab of listTabs() ?? []) {
						if (tab?.kind !== KIND) continue;
						const path = pathFromAddress(tab.contentId);
						if (path === '' || alive.has(path)) continue;
						close(tab.tabId);
					}
				}
				for (const row of ops) {
					const callId = row.op?.callId;
					const path = row.op?.path;
					if (typeof callId !== 'string' || typeof path !== 'string') continue;
					if (!primed.current) {
						opened.add(callId);
						continue;
					}
					if (opened.has(callId)) continue;
					opened.add(callId);
					if (open !== undefined) open(path);
				}
				primed.current = true;
			}, [open, close, listTabs, ops, running, wire]);
			return null;
		}

		return {
			// `slots` draws the panel, the two sidebar services own tab placement.
			inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
			name: 'live-code',
			/**
			 * Register the tab type, its body, its title, and the silent watcher.
			 * @param ctx - the client plugin context.
			 * @returns a disposer removing the style tag.
			 */
			apply(ctx) {
				const style = document.createElement('style');
				style.dataset.plugin = '@local/dsh-live-code';
				style.textContent = CSS;
				document.head.appendChild(style);
				ctx.effect(() => ctx.sidebarRightTabs.register({
					id: KIND,
					kind: KIND,
					// Claims `dsh-resource://live-code/<file>`: one tab per file, for good.
					patterns: [`${ADDRESS_PREFIX}**`],
					title: (address) => basename(
						typeof address === 'string' && address.startsWith(ADDRESS_PREFIX)
							? decodeURIComponent(address.slice(ADDRESS_PREFIX.length))
							: '实时代码',
					),
				}), 'live-code: tab type');
				ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
					name: 'sidebar.right.pane.tab',
					key: KIND,
				}, (props) => h(LiveCodeTab, {
					...props,
					close: (tabId) => {
						try {
							ctx.sidebarRight.close(tabId);
						} catch { /* the sidebar is unavailable: leave the tab alone */ }
					},
				}))), 'live-code: tab body');
				ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
					name: 'sidebar.right.pane.tab.title',
					key: KIND,
				}, LiveCodeTitle)), 'live-code: tab title');
				ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
					name: 'conversation.composer.dock',
					id: 'live-code',
					order: 5,
				}, (props) => h(LiveCodeWatcher, {
					...props,
					open: (path) => {
						try {
							// No placement or size options: the tab lands in the active pane
							// and the sidebar keeps whatever width the user set.
							ctx.sidebarRight.openResource(addressFor(path), { params: { path } });
						} catch { /* the sidebar is unavailable: never break the composer */ }
					},
					// The strip, so a tab whose file has nothing left to show can close
					// itself even while it is not the active tab.
					listTabs: () => {
						try {
							return ctx.sidebarRight.openTabs?.getSnapshot?.() ?? [];
						} catch {
							return [];
						}
					},
					close: (tabId) => {
						try {
							ctx.sidebarRight.close(tabId);
						} catch { /* the sidebar is unavailable: leave the tab alone */ }
					},
				}))), 'live-code: watcher');
				return () => {
					style.remove();
				};
			},
		};
	},
});
