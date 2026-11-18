/**
 * Live code (host half).
 *
 * Folds the session's own tool traffic into one value the browser can draw: the
 * last file operation (`read` / `write` / `edit`), the file's current text with
 * line numbers, and the exact line range that operation changed.
 *
 * The file is read from disk here rather than in the browser: the host already
 * sees the operation, it can read any path the agent can reach, and it can find
 * where `new_string` landed — so the client never has to guess a line number.
 *
 * @module @local/dsh-live-code
 */
import { readFileSync, statSync } from 'node:fs';

/** Tools whose call targets exactly one file. */
const FILE_TOOLS = new Set(['read', 'write', 'edit']);
/** How many recent operations stay in the projection state. */
const MAX_OPS = 20;
/** How many changed-text notes the plugin keeps beside the state. */
const MAX_NOTES = 40;
/** A file is re-read at most this often while it stays the newest operation. */
const CACHE_TTL_MS = 3000;
/** Text files larger than this are not shipped to the browser. */
const MAX_BYTES = 2 * 1024 * 1024;
/** Rendered lines are capped, keeping a window around the change. */
const MAX_LINES = 2000;
/** How many recent operations ship with their file text (one per open tab). */
const VISIBLE_OPS = 3;
/** Lines shipped per operation once several are visible at once. */
const MAX_LINES_PER_OP = 800;
/** Lines kept before the change when a file is windowed. */
const WINDOW_BEFORE = 40;
/** Extensions that are never worth showing as text. */
const BINARY_EXTENSIONS = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svgz', '.tif', '.tiff',
	'.woff', '.woff2', '.ttf', '.otf', '.eot',
	'.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.zst',
	'.exe', '.dll', '.so', '.dylib', '.node', '.wasm', '.class', '.jar',
	'.pdf', '.docx', '.xlsx', '.pptx', '.mp3', '.mp4', '.mov', '.avi', '.webm', '.sqlite', '.db',
]);

/**
 * Parse a tool call's `arguments`, which the harness records as a JSON string.
 * @param value - the recorded arguments.
 * @returns the parsed object, or undefined when it is not an object.
 */
function parseArguments(value) {
	if (typeof value !== 'string') return value !== null && typeof value === 'object' ? value : undefined;
	try {
		const parsed = JSON.parse(value);
		return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether the file's first bytes look like text.
 * @param path - file path.
 * @returns whether it is probably text.
 */
function looksBinary(path) {
	const dot = path.lastIndexOf('.');
	if (dot !== -1 && BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase())) return true;
	return false;
}

/**
 * Read a file with a short-lived cache, so one panel refresh cannot hammer the disk.
 * @param path - file path.
 * @param cache - path -> entry map owned by the plugin.
 * @returns the cache entry for this path.
 */
function readCached(path, cache) {
	const now = Date.now();
	const hit = cache.get(path);
	if (hit !== undefined && now - hit.at < CACHE_TTL_MS) return hit;
	let entry;
	if (looksBinary(path)) {
		entry = { at: now, error: 'binary' };
	} else {
		try {
			const stat = statSync(path);
			if (!stat.isFile()) entry = { at: now, error: 'not-a-file' };
			else if (stat.size > MAX_BYTES) entry = { at: now, error: 'too-large', bytes: stat.size };
			else {
				const text = readFileSync(path, 'utf8');
				entry = text.includes('\u0000')
					? { at: now, error: 'binary' }
					: { at: now, text, lines: text.split('\n'), bytes: stat.size };
			}
		} catch (error) {
			entry = { at: now, error: typeof error?.code === 'string' ? error.code : 'unreadable' };
		}
	}
	// A missing file is the normal state just before a `write` runs; caching that
	// would pin the panel on "not created yet" for the rest of the cache window.
	if (entry.error !== 'ENOENT') cache.set(path, entry);
	return entry;
}

/**
 * Drop the cached read of the file an operation just touched.
 *
 * A `tool/call` is committed before the tool runs, so the read taken then is
 * pre-change: an edit has not landed yet and a write has not created the file.
 * The result event is the moment that read became wrong.
 *
 * @param cache - the plugin's file cache.
 * @param ops - the operations folded so far.
 * @param event - the committed session event.
 * @returns whether a cache entry was dropped.
 */
function forgetOnResult(cache, ops, event) {
	if (event?.type !== 'tool/result') return false;
	const callId = event.data?.toolCallId ?? event.data?.message?.toolCallId ?? event.data?.message?.source?.callId;
	if (typeof callId !== 'string') return false;
	const op = ops.find((row) => row.callId === callId);
	if (op === undefined) return false;
	return cache.delete(op.path);
}

/**
 * Find the line range a fragment landed on, comparing whole lines.
 * @param lines - the file's lines.
 * @param fragment - the changed text.
 * @returns `{from, to}` as 1-based inclusive line numbers, or undefined.
 */
function locateFragment(lines, fragment) {
	if (typeof fragment !== 'string' || fragment === '') return undefined;
	const wanted = fragment.split('\n');
	// A patch replaces a block; ignore the trailing empty line JSON usually adds.
	while (wanted.length > 1 && wanted[wanted.length - 1] === '') wanted.pop();
	const first = wanted[0];
	if (first === undefined) return undefined;
	for (let start = 0; start + wanted.length <= lines.length; start += 1) {
		if (lines[start] !== first) continue;
		let matched = true;
		for (let offset = 1; offset < wanted.length; offset += 1) {
			if (lines[start + offset] !== wanted[offset]) {
				matched = false;
				break;
			}
		}
		if (matched) return { from: start + 1, to: start + wanted.length };
	}
	return undefined;
}

/**
 * Fold one event into the operation list.
 *
 * The changed text itself is deliberately kept out of the state (state is
 * persisted to checkpoints, and a `write` payload can be a whole file); it goes
 * to a plugin-side map that the view reads instead.
 *
 * @param state - previous state.
 * @param event - committed session event.
 * @param notes - callId -> changed text, bounded, owned by the plugin.
 * @returns next state.
 */
function fold(state, event, notes) {
	if (typeof event?.seq === 'number' && event.seq < state.inheritedEventCount) return state;
	if (event?.type === 'tool/call') {
		const tool = event.data?.name;
		if (typeof tool !== 'string' || !FILE_TOOLS.has(tool)) return state;
		const args = parseArguments(event.data?.arguments);
		const path = typeof args?.file_path === 'string' ? args.file_path : undefined;
		if (path === undefined) return state;
		const callId = typeof event.data?.callId === 'string' ? event.data.callId : undefined;
		const changed = tool === 'edit' ? args?.new_string : tool === 'write' ? args?.content : undefined;
		if (callId !== undefined) {
			notes.set(callId, typeof changed === 'string' ? changed : '');
			while (notes.size > MAX_NOTES) {
				const oldest = notes.keys().next();
				if (oldest.done === true) break;
				notes.delete(oldest.value);
			}
		}
		const op = {
			callId,
			tool,
			path,
			turn: typeof event.data?.turn === 'number' ? event.data.turn : undefined,
			step: typeof event.data?.step === 'number' ? event.data.step : undefined,
			at: typeof event.time === 'number' ? event.time : state.lastTimeMs,
			status: 'running',
		};
		return { ...state, lastTimeMs: op.at, ops: [...state.ops, op].slice(-MAX_OPS) };
	}
	if (event?.type === 'tool/result') {
		const callId = event.data?.toolCallId ?? event.data?.message?.toolCallId ?? event.data?.message?.source?.callId;
		if (typeof callId !== 'string') return state;
		const at = state.ops.findIndex((op) => op.callId === callId);
		if (at === -1) return state;
		const ops = state.ops.slice();
		ops[at] = { ...ops[at], status: 'done' };
		return { ...state, ops };
	}
	return state;
}

/** Shape gate: a stale checkpoint is discarded rather than forward-applied. */
const stateSchema = {
	/**
	 * @param value - persisted state candidate.
	 * @returns the state.
	 */
	parse(value) {
		if (value === null || typeof value !== 'object') throw new Error('live-code: state must be an object');
		if (!Array.isArray(value.ops)) throw new Error('live-code: state has no ops');
		if (typeof value.inheritedEventCount !== 'number') throw new Error('live-code: state has no inheritedEventCount');
		if (typeof value.lastTimeMs !== 'number') throw new Error('live-code: state has no lastTimeMs');
		return value;
	},
};

/**
 * Describe one operation: what it was, plus the file text it touched.
 *
 * @param op - the folded operation.
 * @param cache - the plugin's file cache.
 * @param notes - callId -> changed text.
 * @param lineCap - how many lines this entry may ship.
 * @returns one wire entry.
 */
function describeOp(op, cache, notes, lineCap) {
	const head = { callId: op.callId, tool: op.tool, path: op.path, status: op.status, at: op.at };
	const entry = readCached(op.path, cache);
	if (entry.text === undefined) {
		return { op: head, file: { error: entry.error ?? 'unreadable', bytes: entry.bytes ?? null } };
	}
	const changedText = op.callId === undefined ? '' : notes.get(op.callId) ?? '';
	const changed = changedText === '' ? undefined : locateFragment(entry.lines, changedText);
	const total = entry.lines.length;
	let from = 1;
	let to = total;
	let truncated = false;
	const cap = Math.min(lineCap, MAX_LINES);
	if (total > cap) {
		const anchor = changed === undefined ? total : changed.from;
		from = Math.max(1, anchor - WINDOW_BEFORE);
		to = Math.min(total, from + cap - 1);
		truncated = true;
	}
	const lines = [];
	for (let number = from; number <= to; number += 1) {
		lines.push([number, entry.lines[number - 1] ?? '']);
	}
	/** A write shows its whole payload as the change when the file itself hides it. */
	const written = op.tool === 'write' ? changedText.split('\n').length : 0;
	return {
		op: head,
		file: {
			bytes: entry.bytes ?? null,
			total,
			from,
			to,
			truncated,
			changed: changed ?? (written > 0 ? { from, to: Math.min(to, from + written - 1) } : null),
			target: changed?.from ?? (written > 0 ? from : null),
			lines,
		},
	};
}

/**
 * Project the folded state onto the client payload: the newest operation first,
 * each with its file text, so every open tab can find its own entry.
 *
 * @param state - folded state.
 * @param cache - the plugin's file cache.
 * @param notes - callId -> changed text.
 * @returns the client-visible value.
 */
function view(state, cache, notes) {
	const recent = state.ops.slice(-VISIBLE_OPS).reverse();
	const cap = recent.length > 1 ? MAX_LINES_PER_OP : MAX_LINES;
	return {
		latest: recent[0]?.callId ?? null,
		ops: recent.map((op) => describeOp(op, cache, notes, cap)),
	};
}

/**
 * Build the projection unit around one plugin's caches.
 * @param cache - path -> last read.
 * @param notes - callId -> changed text.
 * @returns the projection definition.
 */
export function liveCodeDefinition(cache, notes) {
	return {
		key: 'liveCode',
		stateVersion: 1,
		stateSchema,
		init: (header, inheritedEventCount) => ({
			ops: [],
			lastTimeMs: Date.now(),
			inheritedEventCount: typeof inheritedEventCount === 'number' ? inheritedEventCount : 0,
		}),
		apply: (state, event) => {
			// The tool has run by now: whatever the file read before it, it is stale.
			forgetOnResult(cache, state.ops, event);
			return fold(state, event, notes);
		},
		wire: {
			viewSchema: {
				/**
				 * @param value - the wire payload.
				 * @returns the payload.
				 */
				parse: (value) => value,
			},
			view: (state) => view(state, cache, notes),
		},
	};
}

/**
 * Host plugin body: register the live-code projection unit.
 * @param ctx - the host plugin context.
 */
export function apply(ctx) {
	const cache = new Map();
	const notes = new Map();
	const definition = liveCodeDefinition(cache, notes);
	ctx.effect(() => ctx.sessionProjections.register(definition), 'live-code: projection');
	ctx.effect(() => () => {
		cache.clear();
		notes.clear();
	}, 'live-code: caches');
}

export const inject = ['sessionProjections'];
