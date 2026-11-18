/**
 * Content script for DSH Bridge.
 *
 * Runs in the isolated world, which is enough for everything here: the DOM is
 * shared, and Firefox exposes the page's real globals through
 * `window.wrappedJSObject`. Reading state that way matters because a strict page
 * CSP (for example 1in8b.life's `script-src 'self'`) blocks both `eval` and
 * injected <script> tags, so an expression evaluator would simply not work
 * there.
 */
(() => {
  const FRAME_ID = "__dsh_control_frame";
  /**
   * A plain-text tab marker. Plain text has no colour, and the coloured glyphs
   * that do exist (🟢) render at full emoji size, which is too large for a tab
   * label — so the marker here is a small dot plus the words that say it.
   */
  const TITLE_PREFIX = "\u25CF \u63A7\u5236\u4E2D \u00B7 ";

  const state = {
    controlled: false,
    originalTitle: null,
    observer: null,
    frame: null,
  };

  /** A depth- and cycle-limited JSON rendering of a page value. */
  function toJson(value, depth = 0, seen = new Set()) {
    const MAX_DEPTH = 6;
    if (value === null || value === undefined) return value === undefined ? null : null;
    const type = typeof value;
    if (type === "string" || type === "number" || type === "boolean") return value;
    if (type === "function") return "[function]";
    if (type === "bigint") return String(value);
    if (type === "symbol") return "[symbol]";
    if (depth >= MAX_DEPTH) return "[depth]";
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.slice(0, 200).map((item) => toJson(item, depth + 1, seen));
      }
      const out = {};
      let count = 0;
      for (const key of Object.keys(value)) {
        if (count++ >= 200) {
          out["…"] = "[truncated]";
          break;
        }
        try {
          out[key] = toJson(value[key], depth + 1, seen);
        } catch {
          out[key] = "[unreadable]";
        }
      }
      return out;
    } catch {
      return "[unreadable]";
    } finally {
      seen.delete(value);
    }
  }

  /** Split a dotted path into segments, tolerating `[0]`, `?.` and a trailing `;`. */
  function parsePath(path) {
    const cleaned = String(path).trim().replace(/;$/, "");
    const segments = [];
    for (const part of cleaned.split(".")) {
      const match = part.match(/^([^[\]]*)((?:\[[0-9]+\])*)$/);
      if (!match) throw new Error(`unsupported path segment ${JSON.stringify(part)}`);
      const name = match[1];
      if (name) segments.push(name);
      for (const index of match[2].match(/\[([0-9]+)\]/g) ?? []) {
        segments.push(Number(index.slice(1, -1)));
      }
    }
    return segments;
  }

  /** Read one page value through the Firefox Xray waiver. */
  function readPath(path) {
    const page = window.wrappedJSObject ?? window;
    let value = page;
    for (const segment of parsePath(path)) {
      if (value === null || value === undefined) return undefined;
      value = value[segment];
    }
    return value;
  }

  /** Paint the red frame that marks a controlled tab. */
  function setFrame(on) {
    if (on) {
      if (state.frame?.isConnected) return;
      const frame = document.createElement("div");
      frame.id = FRAME_ID;
      frame.setAttribute("aria-hidden", "true");
      frame.style.cssText = [
        "position:fixed",
        "inset:0",
        "border:3px solid #e11d48",
        "border-radius:2px",
        "box-sizing:border-box",
        "pointer-events:none",
        "z-index:2147483647",
        "box-shadow:inset 0 0 0 1px rgba(225,29,72,.45)",
      ].join(";");
      (document.documentElement ?? document.body)?.appendChild(frame);
      state.frame = frame;
    } else if (state.frame) {
      state.frame.remove();
      state.frame = null;
    }
  }

  /** Keep the tab label marked even when the page rewrites its own title. */
  function applyTitle(on) {
    if (on) {
      if (state.originalTitle === null) state.originalTitle = document.title;
      const wanted = TITLE_PREFIX + state.originalTitle;
      if (document.title !== wanted) document.title = wanted;
    } else if (state.originalTitle !== null) {
      const restore = state.originalTitle;
      state.originalTitle = null;
      if (document.title !== restore) document.title = restore;
    }
  }

  function watchTitle() {
    if (state.observer) return;
    const head = document.querySelector("head");
    if (!head) return;
    state.observer = new MutationObserver(() => {
      if (!state.controlled || state.originalTitle === null) return;
      const wanted = TITLE_PREFIX + state.originalTitle;
      if (document.title !== wanted) document.title = wanted;
    });
    state.observer.observe(head, { childList: true, subtree: true, characterData: true });
  }

  function stopWatchingTitle() {
    state.observer?.disconnect();
    state.observer = null;
  }

  /** Apply the whole controlled appearance in one step. */
  function setControlled(on) {
    state.controlled = on;
    setFrame(on);
    applyTitle(on);
    if (on) watchTitle();
    else stopWatchingTitle();
    return { controlled: on };
  }

  /**
   * Read the decision card as structure, not as page prose.
   *
   * This is the whole reason the extension walks the DOM itself: a reader that
   * only sees `document.body.innerText` cannot tell a choice's number, label and
   * key apart from the headings around it, and guessing from prose picks the
   * wrong button.
   */
  function readChoices() {
    const modal = document.getElementById("modal");
    if (!modal || modal.hidden) return { present: false, choices: [] };

    const card = modal.querySelector(".dec") ?? modal;
    const text = (node, limit = 400) =>
      String(node?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, limit);

    const heading = card.querySelector("#decT") ?? card.querySelector("h2");
    const paragraphs = [...card.querySelectorAll(".bd > p")].map((node) => text(node));
    const fact = card.querySelector(".fact");
    const note = card.querySelector("#decNote");

    const choices = [...card.querySelectorAll("button[data-k]")].map((button, index) => ({
      index: index + 1,
      key: button.dataset.k ?? "",
      label: text(button.querySelector("b"), 300) || text(button, 300),
      sub: text(button.querySelector("small"), 300),
      group: text(button.closest(".chg")?.querySelector("b"), 120),
    }));

    return {
      present: true,
      title: text(heading, 300),
      body: paragraphs.join(" ").slice(0, 1200),
      fact: text(fact, 600),
      needsNote: note !== null && note.tagName !== "INPUT",
      needsName: note !== null && note.tagName === "INPUT",
      choices,
    };
  }

  /** Click one choice by its 1-based number, as read above. */
  function chooseByIndex(index) {
    const modal = document.getElementById("modal");
    const buttons = [...(modal?.querySelectorAll(".dec button[data-k]") ?? [])];
    const button = buttons[Number(index) - 1];
    if (!button) {
      throw new Error(`no choice number ${index} (the card has ${buttons.length})`);
    }
    button.click();
    return button.dataset.k ?? "";
  }

  /** Perform one interaction; DOM access needs no page script privileges. */
  function performInput(spec) {    const action = String(spec.action ?? "");
    const selector = spec.selector ? String(spec.selector) : "";
    const element = selector ? document.querySelector(selector) : null;
    if (selector && !element) {
      throw new Error(`no element matches ${JSON.stringify(selector)}`);
    }

    if (action === "click" && element) {
      element.scrollIntoView({ block: "center", inline: "center" });
      element.click();
      return `clicked ${element.tagName.toLowerCase()}`;
    }

    if (action === "type" && element) {
      element.focus();
      const text = String(spec.text ?? "");
      const proto =
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : element instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter && typeof element.value === "string") setter.call(element, text);
      else if ("value" in element) element.value = text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return `typed into ${element.tagName.toLowerCase()}`;
    }

    if (action === "key") {
      const keys = Array.isArray(spec.keys) ? spec.keys.map(String) : [];
      if (!keys.length) throw new Error("no keys given");
      const target = element ?? document.activeElement ?? document.body;
      for (const key of keys) {
        for (const type of ["keydown", "keypress", "keyup"]) {
          target.dispatchEvent(
            new KeyboardEvent(type, { key, bubbles: true, cancelable: true }),
          );
        }
      }
      return `pressed ${keys.join("+")}`;
    }

    if (action === "hover") {
      const target = element;
      const rect = target?.getBoundingClientRect?.();
      const x = typeof spec.x === "number" ? spec.x : (rect ? rect.left + rect.width / 2 : 0);
      const y = typeof spec.y === "number" ? spec.y : (rect ? rect.top + rect.height / 2 : 0);
      const hovered = document.elementFromPoint(x, y);
      hovered?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: x, clientY: y }));
      hovered?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
      return `hovered ${hovered ? hovered.tagName.toLowerCase() : "nothing"} at ${Math.round(x)},${Math.round(y)}`;
    }

    throw new Error(`unsupported action ${JSON.stringify(action)}`);
  }

  /**
   * Describe the interactive elements a caller may want to click.
   *
   * Guessing a selector for a button whose identity was never read is how the
   * wrong control gets clicked. This lists what is actually there, with the
   * exact selector that will hit it again.
   */
  function describeElements(spec) {
    const selector = String(spec.selector ?? "button, [role='button'], a[href], input");
    const limit = Math.max(1, Math.min(200, Number(spec.limit ?? 60)));
    let nodes;
    try {
      nodes = [...document.querySelectorAll(selector)];
    } catch (error) {
      throw new Error(`invalid selector ${JSON.stringify(selector)}: ${error?.message ?? error}`);
    }

    const label = (node) =>
      String(
        node.getAttribute?.("aria-label") ??
          node.innerText ??
          node.getAttribute?.("title") ??
          node.value ??
          "",
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);

    const visible = (node) => {
      if (!node.isConnected) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      const style = getComputedStyle(node);
      return style.visibility !== "hidden" && style.display !== "none";
    };

    // A stable selector: id when unique, else a structural path that still
    // resolves to this exact node.
    const pathOf = (node) => {
      if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
        return `#${CSS.escape(node.id)}`;
      }
      const parts = [];
      let current = node;
      while (current && current.nodeType === 1 && parts.length < 6) {
        if (current === document.body) {
          parts.unshift("body");
          break;
        }
        const tag = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (!parent) break;
        const sameTag = [...parent.children].filter((child) => child.tagName === current.tagName);
        parts.unshift(
          sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(current) + 1})` : tag,
        );
        current = parent;
      }
      return parts.join(" > ");
    };

    const elements = nodes
      .filter(visible)
      .slice(0, limit)
      .map((node, index) => ({
        index: index + 1,
        tag: node.tagName.toLowerCase(),
        id: node.id || "",
        text: label(node),
        type: node.getAttribute?.("type") ?? "",
        selector: pathOf(node),
      }));

    return { total: nodes.length, shown: elements.length, selector, elements };
  }

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return undefined;
    try {
      switch (message.type) {
        case "dsh:probe":
          return Promise.resolve({ controlled: state.controlled });
        case "dsh:setControl":
          return Promise.resolve(setControlled(!!message.controlled));
        case "dsh:read": {
          const values = {};
          for (const path of Array.isArray(message.paths) ? message.paths : []) {
            try {
              values[path] = toJson(readPath(path));
            } catch (error) {
              values[path] = `[error] ${error?.message ?? error}`;
            }
          }
          return Promise.resolve({ values });
        }
        case "dsh:input":
          return Promise.resolve({ detail: performInput(message.spec ?? {}) });
        case "dsh:choices": {
          const card = readChoices();
          if (message.choose !== undefined && message.choose !== null) {
            if (!card.present) throw new Error("there is no decision card open");
            const key = chooseByIndex(message.choose);
            return Promise.resolve({ ...card, chosen: { index: message.choose, key } });
          }
          return Promise.resolve(card);
        }
        case "dsh:describe":
          return Promise.resolve(describeElements(message));
        default:
          return undefined;
      }
    } catch (error) {
      return Promise.resolve({ error: String(error?.message ?? error) });
    }
  });

  // Re-apply on load so a navigation keeps the marks, then ask whether this tab
  // is supposed to look controlled.
  browser.runtime
    .sendMessage({ type: "dsh:amIControlled" })
    .then((reply) => {
      if (reply?.controlled) setControlled(true);
    })
    .catch(() => undefined);
})();
