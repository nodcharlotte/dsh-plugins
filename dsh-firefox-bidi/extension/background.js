/**
 * Background page for DSH Bridge.
 *
 * Owns the single WebSocket to the DeepSeek Harness host and executes the
 * commands that arrive on it. The popup's switch is the only thing that decides
 * whether this socket exists at all: with the switch off, the extension holds no
 * connection, so the host has no way to reach the browser.
 *
 * The manifest requests a persistent background page on purpose. A non-persistent
 * event page is suspended when idle, which would silently drop the socket while
 * the user is simply reading a page.
 */

/** Defaults match the plugin's patch so a fresh install needs no configuration. */
const DEFAULTS = {
  enabled: false,
  host: "127.0.0.1",
  port: 3080,
  token: "dsh-local-bridge",
};

/** Tabs the host created, or that the user handed over, for this session. */
const controlled = new Set();

/** @type {WebSocket | null} */
let socket = null;
let connecting = false;
let retryDelay = 1000;
let retryTimer = null;
let lastError = "";
let hostInfo = "";
let currentEnabled = DEFAULTS.enabled;

const nowIso = () => new Date().toISOString();

/** Read the stored configuration merged over the defaults. */
async function readConfig() {
  const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

/** Report current state to the popup. */
function status() {
  const open = socket !== null && socket.readyState === WebSocket.OPEN;
  return {
    enabled: currentEnabled,
    connected: open,
    hostInfo,
    lastError,
    controlled: controlled.size,
  };
}

/** Swap the toolbar icon so the allowed state is visible at a glance. */
async function paintIcon() {
  const path = currentEnabled ? "icon-on.svg" : "icon.svg";
  try {
    await browser.browserAction.setIcon({ path });
  } catch {
    /* the icon is cosmetic */
  }
}

/** Mark or unmark one tab's label and badge. */
async function paintTab(tabId, on) {
  try {
    await browser.tabs.sendMessage(tabId, { type: "dsh:setControl", controlled: on });
  } catch {
    /* a tab without the content script (about:, reader mode) simply skips it */
  }
}

/** Send one reply frame. */
function reply(id, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ id, ...payload }));
}

/** Execute one host command. */
async function dispatch(method, params) {
  switch (method) {
    case "hello":
      return { firefox: navigator.userAgent, controlled: controlled.size };

    case "tabs.list": {
      const tabs = await browser.tabs.query({});
      return {
        tabs: tabs.map((tab) => ({
          context: String(tab.id),
          url: tab.url ?? tab.pendingUrl ?? "",
          title: tab.title ?? "",
          active: !!tab.active,
          controlled: controlled.has(tab.id),
        })),
      };
    }

    case "tabs.create": {
      const tab = await browser.tabs.create({
        url: params.url || "about:blank",
        active: params.active !== false,
      });
      controlled.add(tab.id);
      await paintTab(tab.id, true);
      return { context: String(tab.id), url: tab.url ?? params.url ?? "" };
    }

    case "tabs.close": {
      const tabId = Number(params.context);
      if (!controlled.has(tabId)) throw new Error("tab is not under DSH control");
      await browser.tabs.remove(tabId);
      controlled.delete(tabId);
      return { closed: true };
    }

    case "tab.release": {
      const tabId = Number(params.context);
      controlled.delete(tabId);
      await paintTab(tabId, false);
      return { released: true };
    }

    case "tab.read": {
      const tabId = Number(params.context);
      const replyValue = await browser.tabs.sendMessage(tabId, {
        type: "dsh:read",
        paths: params.paths ?? [],
      });
      if (replyValue?.error) throw new Error(replyValue.error);
      return { values: replyValue?.values ?? {} };
    }

    case "tab.navigate": {
      const tabId = Number(params.context);
      await browser.tabs.update(tabId, { url: params.url });
      // Give the load a moment so the caller sees the new title, not the old one.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const tab = await browser.tabs.get(tabId);
      return { context: String(tabId), url: tab.url ?? "", title: tab.title ?? "" };
    }

    case "tab.choices": {
      const tabId = Number(params.context);
      const card = await browser.tabs.sendMessage(tabId, {
        type: "dsh:choices",
        choose: params.choose,
      });
      if (card?.error) throw new Error(card.error);
      return card ?? { present: false, choices: [] };
    }

    case "tab.describe": {
      const tabId = Number(params.context);
      const listing = await browser.tabs.sendMessage(tabId, {
        type: "dsh:describe",
        selector: params.selector,
        limit: params.limit,
      });
      if (listing?.error) throw new Error(listing.error);
      return listing ?? { total: 0, shown: 0, elements: [] };
    }

    case "tab.input": {
      const tabId = Number(params.context);
      if (!controlled.has(tabId)) throw new Error("tab is not under DSH control");
      const result = await browser.tabs.sendMessage(tabId, {
        type: "dsh:input",
        spec: params.spec ?? {},
      });
      if (result?.error) throw new Error(result.error);
      return { detail: result?.detail ?? "" };
    }

    case "tab.screenshot": {
      const tabId = Number(params.context);
      // captureTab resolves to a data URL, not binary, and it works without
      // activating the tab — so a capture never steals the user's focus.
      const dataUrl = await browser.tabs.captureTab(tabId, { format: "png" });
      const base64 = String(dataUrl).replace(/^data:[^;]+;base64,/, "");
      if (!base64) throw new Error("captureTab returned no image data");
      return { base64 };
    }

    case "ping":
      return { pong: nowIso() };

    default:
      throw new Error(`unknown method ${JSON.stringify(method)}`);
  }
}

/** Handle one inbound frame. */
async function onFrame(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  const id = message?.id;
  if (id === undefined) return;
  try {
    const result = await dispatch(message.method, message.params ?? {});
    reply(id, { ok: true, result });
  } catch (error) {
    reply(id, { ok: false, error: String(error?.message ?? error) });
  }
}

/** Open the socket, if the switch is on and it is not already open. */
async function connect() {
  if (!currentEnabled || connecting) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  connecting = true;
  try {
    const config = await readConfig();
    hostInfo = `${config.host}:${config.port}`;
    const url = `ws://${config.host}:${config.port}/firefox-bridge?t=${encodeURIComponent(config.token)}`;
    const next = new WebSocket(url);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("connect timeout")), 6000);
      next.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      next.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("cannot reach the DSH host"));
      });
    });

    socket = next;
    lastError = "";
    retryDelay = 1000;

    next.addEventListener("message", (event) => {
      void onFrame(event);
    });
    next.addEventListener("close", () => {
      socket = null;
      void paintIcon();
      if (currentEnabled) scheduleRetry();
    });
    next.addEventListener("error", () => {
      lastError = "connection error";
    });

    // id 0 is the unsolicited hello; the host folds `params` into its bridge info.
    socket.send(
      JSON.stringify({
        id: 0,
        method: "hello",
        params: { firefox: navigator.userAgent, controlled: controlled.size },
      }),
    );
    void paintIcon();
  } catch (error) {
    lastError = String(error?.message ?? error);
    socket = null;
    void paintIcon();
    if (currentEnabled) scheduleRetry();
  } finally {
    connecting = false;
  }
}

/** Reconnect with backoff while the switch is on. */
function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(
    () => {
      void connect();
    },
    Math.min(retryDelay, 15000),
  );
  retryDelay = Math.min(retryDelay * 2, 15000);
}

/** Turn control on or off; returning the fresh status. */
async function setEnabled(enabled) {
  currentEnabled = !!enabled;
  await browser.storage.local.set({ enabled: currentEnabled });
  if (currentEnabled) {
    retryDelay = 1000;
    await connect();
  } else {
    clearTimeout(retryTimer);
    const closing = socket;
    socket = null;
    try {
      closing?.close();
    } catch {
      /* ignore */
    }
    for (const tabId of [...controlled]) {
      controlled.delete(tabId);
      await paintTab(tabId, false);
    }
  }
  await paintIcon();
  return status();
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message !== "object") return undefined;

  if (message.type === "dsh:amIControlled") {
    const tabId = sender?.tab?.id;
    return Promise.resolve({ controlled: tabId !== undefined && controlled.has(tabId) });
  }
  if (message.type === "dsh:getStatus") return Promise.resolve(status());
  if (message.type === "dsh:setEnabled") return setEnabled(message.enabled);
  if (message.type === "dsh:setConfig") {
    return (async () => {
      const patch = {};
      if (typeof message.host === "string" && message.host.trim()) patch.host = message.host.trim();
      if (Number.isFinite(Number(message.port))) patch.port = Number(message.port);
      if (typeof message.token === "string" && message.token.trim()) patch.token = message.token.trim();
      await browser.storage.local.set(patch);
      if (currentEnabled) {
        await setEnabled(false);
        await setEnabled(true);
      }
      return status();
    })();
  }
  if (message.type === "dsh:releaseAll") {
    return (async () => {
      for (const tabId of [...controlled]) {
        controlled.delete(tabId);
        await paintTab(tabId, false);
      }
      await paintIcon();
      return status();
    })();
  }
  return undefined;
});

// Keep the controlled marks correct when a controlled tab navigates away and
// its content script is replaced.
browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  if (!controlled.has(tabId)) return;
  await paintTab(tabId, true);
});

browser.tabs.onRemoved.addListener((tabId) => {
  controlled.delete(tabId);
});

void (async () => {
  const config = await readConfig();
  currentEnabled = !!config.enabled;
  await paintIcon();
  if (currentEnabled) await connect();
})();
