/**
 * The DSH side of the Firefox extension bridge.
 *
 * The extension dials *out* to this server, which is what removes the need for
 * `--remote-debugging-port` and a browser restart: once the user flips the
 * popup switch, the browser connects here and stays connected until they flip it
 * back.
 *
 * Two gates protect the upgrade handshake, because any web page can open a
 * WebSocket to loopback:
 *   - the `Origin` must be a `moz-extension://` origin, which page script cannot
 *     forge;
 *   - a shared token from the plugin config must match.
 *
 * @module @local/dsh-firefox-bidi/bridge
 */
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";

/** Constant-time compare that tolerates a length mismatch. */
function tokenMatches(expected, actual) {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Answer an upgrade we refuse, then drop the socket. */
function refuse(socket, status, reason) {
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  } catch {
    /* the peer may already be gone */
  }
  socket.destroy();
}

/** One bridge: the extension socket plus request/response framing. */
export class BridgeServer {
  #wss = null;
  #socket = null;
  #pending = new Map();
  #nextId = 0;
  #info = null;
  #attached = false;

  /**
   * @param options - route path and shared token.
   */
  constructor({ path, token }) {
    this.path = path;
    this.token = token;
    this.#wss = new WebSocketServer({ noServer: true });
  }

  /** @returns whether an extension is currently connected. */
  get connected() {
    return this.#socket !== null && this.#socket.readyState === 1;
  }

  /** @returns what the extension reported about itself, when known. */
  get info() {
    return this.#info;
  }

  /**
   * Claim the upgrade route and a status route on the host web server.
   *
   * @param webServer - the host `webServer` service.
   * @returns a disposer releasing both routes.
   */
  attach(webServer) {
    if (this.#attached) throw new Error("bridge already attached");
    this.#attached = true;

    const offUpgrade = webServer.registerUpgrade({
      path: this.path,
      handler: (req, socket, head) => this.#onUpgrade(req, socket, head),
    });
    const offStatus = webServer.register({
      kind: "exact",
      path: this.path,
      handler: (req, res) => {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(
          JSON.stringify({
            ok: true,
            connected: this.connected,
            info: this.#info,
          }),
        );
      },
    });

    this.#disposeRoutes = () => {
      offUpgrade();
      offStatus();
    };
    return () => this.close();
  }

  #disposeRoutes = () => undefined;

  #onUpgrade(req, socket, head) {
    const origin = String(req.headers.origin ?? "");
    if (!origin.startsWith("moz-extension://")) {
      refuse(socket, 403, "Forbidden");
      return;
    }

    let token = "";
    try {
      token = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("t") ?? "";
    } catch {
      refuse(socket, 400, "Bad Request");
      return;
    }
    if (!tokenMatches(this.token, token)) {
      refuse(socket, 403, "Forbidden");
      return;
    }

    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#adopt(ws));
  }

  #adopt(ws) {
    // Newest connection wins: a reloaded extension should not be blocked by a
    // socket the browser failed to close cleanly.
    const previous = this.#socket;
    this.#socket = ws;
    this.#info = { since: new Date().toISOString() };
    this.#failPending(new Error("a newer extension connection replaced this one"));
    if (previous && previous !== ws) {
      try {
        previous.close();
      } catch {
        /* ignore */
      }
    }

    ws.on("message", (data) => this.#onMessage(data));
    ws.on("close", () => {
      if (this.#socket === ws) {
        this.#socket = null;
        this.#info = null;
        this.#failPending(new Error("the extension disconnected"));
      }
    });
    ws.on("error", () => {
      /* a transport error is followed by close, which clears state */
    });
  }

  #onMessage(data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }

    // id 0 is the extension's unsolicited hello.
    if (message.id === 0) {
      this.#info = { ...(this.#info ?? {}), ...(message.result ?? message.params ?? {}) };
      return;
    }

    const entry = this.#pending.get(message.id);
    if (!entry) return;
    this.#pending.delete(message.id);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error ?? "extension command failed"));
  }

  #failPending(error) {
    for (const [, entry] of this.#pending) entry.reject(error);
    this.#pending.clear();
  }

  /**
   * Send one command to the extension.
   *
   * @param method - the extension method name.
   * @param params - method parameters.
   * @param options - timeout and cancellation.
   * @returns the extension's result.
   */
  request(method, params = {}, { timeoutMs = 20000, signal } = {}) {
    const ws = this.#socket;
    if (!ws || ws.readyState !== 1) {
      return Promise.reject(
        new Error(
          "the DSH Bridge extension is not connected — turn its switch on in the Firefox toolbar",
        ),
      );
    }
    if (signal?.aborted) return Promise.reject(new Error("aborted"));

    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onAbort = () => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new Error("aborted"));
      };
      signal?.addEventListener?.("abort", onAbort, { once: true });

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

      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`failed to send ${method}: ${error?.message ?? error}`));
      }
    });
  }

  /** Release routes and drop the extension connection. */
  async close() {
    this.#disposeRoutes();
    this.#failPending(new Error("the bridge is closing"));
    const ws = this.#socket;
    this.#socket = null;
    this.#info = null;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => this.#wss.close(() => resolve()));
  }
}
