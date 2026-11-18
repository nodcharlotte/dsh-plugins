/**
 * Two interchangeable ways to drive Firefox, behind one small interface.
 *
 * `bidi` is the direct WebDriver BiDi connection that needs
 * `--remote-debugging-port`. `extension` goes through the DSH Bridge add-on,
 * which needs nothing but the popup switch. Tools call the interface and never
 * care which one is live.
 *
 * Both return tab lists shaped `{ context, url, title?, controlled? }`, so tab
 * selection stays identical across transports.
 *
 * @module @local/dsh-firefox-bidi/transport
 */
import { setTimeout as delay } from "node:timers/promises";

/** Per-command budget for a page that never settles. */
const COMMAND_TIMEOUT_MS = 20000;

/**
 * Wrap an expression so the page returns JSON text: an async IIFE means it may
 * await, and `JSON.stringify` avoids walking a remote-object reference.
 */
function wrapExpression(expression) {
  return `(async () => {
    const value = await (${expression});
    try {
      return typeof value === "string" ? value : JSON.stringify(value === undefined ? null : value);
    } catch {
      return String(value);
    }
  })()`;
}

/**
 * The DOM walker that reads a decision card. Both transports use it: the content
 * script runs it in the isolated world, and the BiDi transport evaluates the same
 * source in the page. Prose alone cannot separate a choice's number, label and
 * key from the surrounding headings, and guessing from prose picks the wrong
 * button.
 */
export const READ_CHOICES_SOURCE = `(() => {
  const modal = document.getElementById("modal");
  const text = (node, limit) => String((node && node.textContent) || "").replace(/\\s+/g, " ").trim().slice(0, limit || 400);
  if (!modal || modal.hidden) return { present: false, choices: [] };
  const card = modal.querySelector(".dec") || modal;
  const heading = card.querySelector("#decT") || card.querySelector("h2");
  const body = [...card.querySelectorAll(".bd > p")].map((n) => text(n)).join(" ").slice(0, 1200);
  const fact = card.querySelector(".fact");
  const note = card.querySelector("#decNote");
  const group = (button) => {
    const holder = button.closest(".chg");
    const label = holder && holder.querySelector("b");
    return label ? text(label, 120) : "";
  };
  const choices = [...card.querySelectorAll("button[data-k]")].map((button, index) => ({
    index: index + 1,
    key: button.dataset.k || "",
    label: text(button.querySelector("b"), 300) || text(button, 300),
    sub: text(button.querySelector("small"), 300),
    group: group(button),
  }));
  return {
    present: true,
    title: text(heading, 300),
    body: body,
    fact: text(fact, 600),
    needsNote: note !== null && note.tagName === "TEXTAREA",
    needsName: note !== null && note.tagName === "INPUT",
    choices: choices,
  };
})()`;

/**
 * A property path such as `S.age`, `S.log[0].t` or `S.pending?.id`.
 * This exists because a strict page CSP (`script-src 'self'`, no
 * `unsafe-eval`) blocks `eval` inside the page realm, so the extension reads
 * values by walking properties instead of evaluating source text.
 */
const PATH_PATTERN = /^[A-Za-z_$][\w$]*(?:\??\.[\w$]+|\[\d+\])*$/;

/** Strip wrappers that a caller may reasonably type around a path. */
function normalizePath(expression) {
  let text = String(expression).trim().replace(/;$/, "").trim();
  const wrapped = text.match(/^JSON\.stringify\(\s*([\s\S]*?)\s*\)$/);
  if (wrapped) text = wrapped[1].trim();
  return text;
}

/** @returns whether the text is a readable property path. */
function isPath(text) {
  return PATH_PATTERN.test(text);
}

/** The direct WebDriver BiDi transport. */
export function bidiTransport(client) {
  return {
    kind: "bidi",

    async listTabs({ titles = true } = {}) {
      const { contexts } = await client.command("browsingContext.getTree", { maxDepth: 1 });
      const tabs = [];
      for (const context of contexts.slice(0, 40)) {
        const tab = { context: context.context, url: context.url };
        if (titles) {
          try {
            tab.title = await this.evalText(context.context, "document.title");
          } catch {
            tab.title = "";
          }
        }
        tabs.push(tab);
      }
      return tabs;
    },

    async evalText(context, expression) {
      const outcome = await client.command(
        "script.evaluate",
        {
          expression: wrapExpression(expression),
          target: { context },
          awaitPromise: true,
          resultOwnership: "none",
        },
        { timeoutMs: COMMAND_TIMEOUT_MS },
      );
      if (outcome?.type === "exception") {
        const detail = outcome.exceptionDetails ?? {};
        throw new Error(`page threw: ${detail.text ?? "unknown error"}`);
      }
      return outcome?.result?.value ?? "";
    },

    async navigate(context, url) {
      const result = await client.command(
        "browsingContext.navigate",
        { context, url, wait: "complete" },
        { timeoutMs: COMMAND_TIMEOUT_MS },
      );
      let title = "";
      try {
        title = await this.evalText(context, "document.title");
      } catch {
        /* a still-loading document may not answer */
      }
      return { url: result?.url ?? url, title };
    },

    async input(context, spec) {
      const action = String(spec.action);
      const selector = spec.selector ? String(spec.selector) : "";
      const hasCoords = typeof spec.x === "number" && typeof spec.y === "number";

      if (action === "click" && selector) {
        const script = `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error("no element matches " + ${JSON.stringify(selector)});
          el.scrollIntoView({ block: "center", inline: "center" });
          el.click();
          return "clicked " + (el.tagName || "").toLowerCase();
        })()`;
        return { detail: await this.evalText(context, script) };
      }
      if (action === "type" && selector) {
        const script = `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error("no element matches " + ${JSON.stringify(selector)});
          el.focus();
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : el instanceof HTMLSelectElement
              ? HTMLSelectElement.prototype
              : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, ${JSON.stringify(String(spec.text ?? ""))});
          else el.value = ${JSON.stringify(String(spec.text ?? ""))};
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return "typed into " + (el.tagName || "").toLowerCase();
        })()`;
        return { detail: await this.evalText(context, script) };
      }
      if (action === "key" && Array.isArray(spec.keys) && spec.keys.length) {
        const codes = spec.keys.map((key) => keyToCodePoint(key));
        await client.command(
          "input.performActions",
          {
            context,
            actions: [
              {
                type: "key",
                id: "keyboard",
                actions: [
                  ...codes.map((value) => ({ type: "keyDown", value })),
                  ...codes
                    .slice()
                    .reverse()
                    .map((value) => ({ type: "keyUp", value })),
                ],
              },
            ],
          },
          { timeoutMs: COMMAND_TIMEOUT_MS },
        );
        return { detail: "" };
      }
      if ((action === "click" || action === "hover") && hasCoords) {
        await client.command(
          "input.performActions",
          {
            context,
            actions: [
              {
                type: "pointer",
                id: "mouse",
                parameters: { pointerType: "mouse" },
                actions: [
                  { type: "pointerMove", x: Math.round(spec.x), y: Math.round(spec.y) },
                  ...(action === "click"
                    ? [
                        { type: "pointerDown", button: 0 },
                        { type: "pointerUp", button: 0 },
                      ]
                    : []),
                ],
              },
            ],
          },
          { timeoutMs: COMMAND_TIMEOUT_MS },
        );
        return { detail: "" };
      }
      throw new Error(
        "Nothing to do: give a selector for click/type, keys for key, or x and y for a coordinate.",
      );
    },

    async screenshot(context) {
      const { data } = await client.command(
        "browsingContext.captureScreenshot",
        { context },
        { timeoutMs: COMMAND_TIMEOUT_MS },
      );
      return String(data ?? "");
    },

    async choices(context, choose) {
      const raw = await this.evalText(context, READ_CHOICES_SOURCE);
      const card = JSON.parse(raw);
      if (choose === undefined || choose === null) return card;
      if (!card.present) throw new Error("there is no decision card open");
      const wanted = card.choices.find((choice) => choice.index === Number(choose));
      if (!wanted) throw new Error(`no choice number ${choose} (the card has ${card.choices.length})`);
      await this.input(context, {
        action: "click",
        selector: `#modal .dec button[data-k="${wanted.key}"]`,
      });
      return { ...card, chosen: { index: wanted.index, key: wanted.key } };
    },

    async describe(context, spec) {
      const raw = await this.evalText(
        context,
        `(${buildDescribeSource(String(spec?.selector ?? ""), Number(spec?.limit ?? 60))})`,
      );
      return JSON.parse(raw);
    },
  };
}

/**
 * Build the element-listing walker for the BiDi transport. The content script
 * has its own copy because it cannot receive source text through a message.
 */
function buildDescribeSource(selector, limit) {
  return `(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector || "button, [role='button'], a[href], input")})];
    const labelOf = (node) => String(node.getAttribute("aria-label") ?? node.innerText ?? node.getAttribute("title") ?? node.value ?? "").replace(/\\s+/g, " ").trim().slice(0, 160);
    const visible = (node) => {
      if (!node.isConnected) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      const style = getComputedStyle(node);
      return style.visibility !== "hidden" && style.display !== "none";
    };
    const pathOf = (node) => {
      if (node.id && document.querySelectorAll("#" + CSS.escape(node.id)).length === 1) return "#" + CSS.escape(node.id);
      const parts = [];
      let current = node;
      while (current && current.nodeType === 1 && parts.length < 6) {
        if (current === document.body) { parts.unshift("body"); break; }
        const tag = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (!parent) break;
        const sameTag = [...parent.children].filter((child) => child.tagName === current.tagName);
        parts.unshift(sameTag.length > 1 ? tag + ":nth-of-type(" + (sameTag.indexOf(current) + 1) + ")" : tag);
        current = parent;
      }
      return parts.join(" > ");
    };
    const elements = nodes.filter(visible).slice(0, ${Math.max(1, Math.min(200, limit))}).map((node, index) => ({
      index: index + 1,
      tag: node.tagName.toLowerCase(),
      id: node.id || "",
      text: labelOf(node),
      type: node.getAttribute("type") || "",
      selector: pathOf(node),
    }));
    return { total: nodes.length, shown: elements.length, elements: elements };
  })()`;
}

/** The DSH Bridge extension transport. */
export function extensionTransport(bridge) {
  return {
    kind: "extension",

    async listTabs() {
      const { tabs } = await bridge.request("tabs.list", {});
      return tabs;
    },

    async evalText(context, expression) {
      const normalized = normalizePath(expression);

      // A JSON array probes several paths in one round trip.
      if (normalized.startsWith("[")) {
        let paths;
        try {
          paths = JSON.parse(normalized);
        } catch {
          paths = null;
        }
        if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string")) {
          throw new Error(
            "the extension transport needs property paths; a JSON array of paths is also accepted",
          );
        }
        for (const path of paths) {
          if (!isPath(normalizePath(path))) throw unsupportedExpression(path);
        }
        const { values } = await bridge.request("tab.read", {
          context,
          paths: paths.map((path) => normalizePath(path)),
        });
        return JSON.stringify(values);
      }

      if (!isPath(normalized)) throw unsupportedExpression(expression);
      const { values } = await bridge.request("tab.read", { context, paths: [normalized] });
      const value = values[normalized];
      if (typeof value === "string") return value;
      return JSON.stringify(value === undefined ? null : value);
    },

    async navigate(context, url) {
      const result = await bridge.request("tab.navigate", { context, url });
      return { url: result?.url ?? url, title: result?.title ?? "" };
    },

    async input(context, spec) {
      const result = await bridge.request("tab.input", { context, spec });
      return { detail: result?.detail ?? "" };
    },

    async screenshot(context) {
      const { base64 } = await bridge.request("tab.screenshot", { context }, { timeoutMs: 40000 });
      return String(base64 ?? "");
    },

    async choices(context, choose) {
      const card = await bridge.request("tab.choices", { context, choose });
      return card ?? { present: false, choices: [] };
    },

    async describe(context, spec) {
      return await bridge.request("tab.describe", {
        context,
        selector: spec?.selector,
        limit: spec?.limit,
      });
    },
  };
}

/** Explain the CSP limit instead of returning a puzzling syntax error. */
function unsupportedExpression(expression) {
  return new Error(
    `The extension transport can read property paths, not arbitrary expressions ` +
      `(got ${JSON.stringify(String(expression).slice(0, 80))}). ` +
      "Use a path such as S.age, S.log[0].t, or a JSON array of paths. " +
      "Arbitrary JavaScript needs the WebDriver BiDi transport.",
  );
}

/**
 * WebDriver encodes non-printable keys as single code points in the private use
 * area, so a key action accepts exactly one grapheme.
 */
const KEY_CODEPOINTS = {
  null: "\uE000",
  cancel: "\uE001",
  help: "\uE002",
  backspace: "\uE003",
  tab: "\uE004",
  clear: "\uE005",
  return: "\uE006",
  enter: "\uE007",
  shift: "\uE008",
  control: "\uE009",
  ctrl: "\uE009",
  alt: "\uE00A",
  option: "\uE00A",
  pause: "\uE00B",
  escape: "\uE00C",
  esc: "\uE00C",
  space: "\uE00D",
  pageup: "\uE00E",
  pagedown: "\uE00F",
  end: "\uE010",
  home: "\uE011",
  arrowleft: "\uE012",
  left: "\uE012",
  arrowup: "\uE013",
  up: "\uE013",
  arrowright: "\uE014",
  right: "\uE014",
  arrowdown: "\uE015",
  down: "\uE015",
  insert: "\uE016",
  delete: "\uE017",
  del: "\uE017",
  meta: "\uE03D",
  command: "\uE03D",
  cmd: "\uE03D",
  win: "\uE03D",
};

/** Translate one key name into the single code point a key action requires. */
export function keyToCodePoint(key) {
  const raw = String(key);
  if ([...raw].length === 1) return raw;
  const mapped = KEY_CODEPOINTS[raw.toLowerCase()];
  if (mapped) return mapped;
  throw new Error(
    `Unknown key ${JSON.stringify(raw)}. Use a single character or one of: ` +
      "Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp, ArrowDown, ArrowLeft, " +
      "ArrowRight, Home, End, PageUp, PageDown, Shift, Control, Alt, Meta.",
  );
}

/**
 * Resolve which tab a tool call means: an explicit context id, a URL substring,
 * a numeric index, or — with nothing given — the first tab.
 *
 * @param transport - the live transport.
 * @param selector - the caller's `tab` argument.
 * @returns the matching tab descriptor.
 */
export async function resolveTab(transport, selector) {
  const tabs = await transport.listTabs({ titles: true });
  if (!tabs.length) throw new Error("Firefox has no open tab to act on.");
  if (selector === undefined || selector === null || selector === "") return tabs[0];

  const wanted = String(selector);
  const byId = tabs.find((tab) => tab.context === wanted);
  if (byId) return byId;

  if (/^\d+$/.test(wanted)) {
    const indexed = tabs[Number(wanted)];
    if (indexed) return indexed;
  }

  const needle = wanted.toLowerCase();
  const byUrl = tabs.find((tab) => (tab.url ?? "").toLowerCase().includes(needle));
  if (byUrl) return byUrl;

  const byTitle = tabs.find((tab) => (tab.title ?? "").toLowerCase().includes(needle));
  if (byTitle) return byTitle;

  throw new Error(
    `No tab matches ${JSON.stringify(wanted)}. Call firefox_tabs to see the open tabs.`,
  );
}

export { delay };
