/**
 * Minimal WebDriver BiDi client over Node's built-in WebSocket.
 *
 * Firefox dropped CDP, so Playwright/Puppeteer cannot attach to it. Firefox
 * exposes WebDriver BiDi directly at `ws://127.0.0.1:<port>/session` when
 * started with `--remote-debugging-port`, which means a working client needs no
 * dependency at all: Node 22+ ships a global `WebSocket`.
 *
 * @module @local/dsh-firefox-bidi/bidi
 */

/** A protocol-level failure: transport, timeout, or a BiDi error response. */
export class BidiError extends Error {
  /**
   * @param message - human-readable failure text.
   * @param details - optional protocol detail (`error`, `stacktrace`).
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "BidiError";
    this.details = details;
  }
}

const OPEN = 1;

/** One lazily opened connection to one Firefox remote agent. */
export class BidiClient {
  #ws = null;
  #opening = null;
  #nextId = 0;
  #pending = new Map();
  #browserVersion = null;

  /**
   * @param url - the BiDi WebSocket endpoint.
   */
  constructor(url) {
    this.url = url;
  }

  /** @returns whether the socket is currently open. */
  get connected() {
    return this.#ws !== null && this.#ws.readyState === OPEN;
  }

  /** @returns the Firefox version reported by `session.new`, when known. */
  get browserVersion() {
    return this.#browserVersion;
  }

  /**
   * Open the socket and start a session, reusing an existing one when the remote
   * agent reports that a session is already running.
   *
   * @param timeoutMs - how long to wait for the socket to open.
   * @returns this client, connected.
   */
  async connect(timeoutMs = 10000) {
    if (this.connected) return this;
    if (this.#opening) return this.#opening;
    this.#opening = this.#open(timeoutMs).finally(() => {
      this.#opening = null;
    });
    return this.#opening;
  }

  async #open(timeoutMs) {
    const ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new BidiError(`timed out after ${timeoutMs}ms connecting to ${this.url}`));
      }, timeoutMs);
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(
          new BidiError(
            `cannot connect to ${this.url} — is Firefox running with --remote-debugging-port?`,
          ),
        );
      };
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
    });

    this.#ws = ws;
    ws.addEventListener("message", (event) => this.#onMessage(event));
    ws.addEventListener("close", () => this.#failAll(new BidiError("connection closed")));
    ws.addEventListener("error", () => this.#failAll(new BidiError("connection error")));

    try {
      const session = await this.command("session.new", { capabilities: {} });
      this.#browserVersion = session?.capabilities?.browserVersion ?? null;
    } catch (error) {
      const message = String(error?.message ?? "");
      if (/session (already|not created)|already exists/i.test(message)) {
        // Firefox serves one BiDi session per browser. A second socket cannot
        // borrow it, and every command on a sessionless socket fails, so fail
        // loudly here instead of returning a client that cannot work.
        this.#ws = null;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        throw new BidiError(
          "Firefox already has an active WebDriver BiDi session held by another client. " +
            "Close that client (or restart Firefox) and try again.",
          { error: "session-held" },
        );
      }
      throw error;
    }
    return this;
  }

  #failAll(error) {
    this.#ws = null;
    for (const [, entry] of this.#pending) entry.reject(error);
    this.#pending.clear();
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    if (message.id === undefined || message.id === null) return; // an event, not a reply
    const entry = this.#pending.get(message.id);
    if (!entry) return;
    this.#pending.delete(message.id);
    if (message.type === "error") {
      entry.reject(
        new BidiError(`${message.error}: ${message.message}`, {
          error: message.error,
          stacktrace: message.stacktrace,
        }),
      );
      return;
    }
    entry.resolve(message.result);
  }

  /**
   * Send one command and resolve with its `result`.
   *
   * @param method - the BiDi command, for example `browsingContext.getTree`.
   * @param params - command parameters.
   * @param options - timeout and cancellation.
   * @returns the command result.
   */
  command(method, params = {}, { timeoutMs = 30000, signal } = {}) {
    const ws = this.#ws;
    if (!ws || ws.readyState !== OPEN) {
      return Promise.reject(new BidiError("not connected to Firefox"));
    }
    if (signal?.aborted) return Promise.reject(new BidiError("aborted"));

    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BidiError(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onAbort = () => {
        const entry = this.#pending.get(id);
        if (!entry) return;
        this.#pending.delete(id);
        clearTimeout(timer);
        entry.reject(new BidiError("aborted"));
      };

      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          signal?.removeEventListener?.("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener?.("abort", onAbort);
          reject(error);
        },
      });
      signal?.addEventListener?.("abort", onAbort, { once: true });

      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new BidiError(`failed to send ${method}: ${error?.message ?? error}`));
      }
    });
  }

  /** End the session and close the socket, ignoring a peer already gone. */
  async close() {
    if (!this.#ws) return;
    if (this.connected) {
      // Best effort: a short grace period beats a hung dispose on shutdown.
      try {
        await Promise.race([
          this.command("session.end", {}, { timeoutMs: 1000 }).catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 1200)),
        ]);
      } catch {
        /* ignore */
      }
    }
    const ws = this.#ws;
    this.#ws = null;
    this.#pending.clear();
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  }
}
