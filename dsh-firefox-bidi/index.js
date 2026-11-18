/**
 * Firefox browser control for DSH.
 *
 * Two transports, one tool surface:
 *   - **extension** — the DSH Bridge add-on dials out to this process, so the
 *     user only flips a switch in the toolbar. No launch flag, no restart.
 *   - **bidi** — a direct WebDriver BiDi connection, which needs Firefox started
 *     with `--remote-debugging-port`. Kept as the fallback because it can
 *     evaluate arbitrary expressions, which a strict page CSP denies to any
 *     in-page script.
 *
 * The extension wins when connected. See `transport.js` for the interface both
 * implement, and `bridge.js` for the socket and its handshake gates.
 *
 * @module @local/dsh-firefox-bidi
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { BidiClient } from "./bidi.js";
import { BridgeServer } from "./bridge.js";
import { bidiTransport, extensionTransport, resolveTab } from "./transport.js";

/** Plugin identity used by the Loader row. */
export const name = "firefox-bidi";

/** The registries this plugin consumes. */
export const inject = ["tools"];

/** Deployment configuration for both transports. */
export const Config = z.object({
  port: z.number().default(9222).description("WebDriver BiDi port on 127.0.0.1."),
  firefoxPath: z
    .string()
    .default("")
    .description("Firefox executable for BiDi launches; empty means detect it automatically."),
  profileDir: z
    .string()
    .default("")
    .description("Profile directory for BiDi launches; empty means a dedicated agent profile."),
  screenshotDir: z
    .string()
    .default("")
    .description("Where screenshots are written; empty means a temp directory."),
  headless: z
    .boolean()
    .default(false)
    .description("Launch BiDi Firefox without a visible window."),
  bridgePath: z
    .string()
    .default("/firefox-bridge")
    .description("WebSocket path the DSH Bridge extension connects to."),
  bridgeToken: z
    .string()
    .default("dsh-local-bridge")
    .description("Shared token the extension must present; must match the popup's setting."),
});

/** Candidate install locations, checked only when `firefoxPath` is empty. */
const FIREFOX_CANDIDATES = [
  "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
  "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
];

/** Resolve the Firefox executable from config, a running process, or disk. */
function resolveFirefoxPath(config) {
  if (config.firefoxPath) return config.firefoxPath;
  for (const candidate of FIREFOX_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

/** The dedicated profile this plugin owns when the user sets none. */
function resolveProfileDir(config) {
  if (config.profileDir) return config.profileDir;
  const base = process.env.LOCALAPPDATA || tmpdir();
  return join(base, "dsh-firefox-bidi", "profile");
}

/** The directory screenshots land in. */
function resolveScreenshotDir(config) {
  if (config.screenshotDir) return config.screenshotDir;
  return join(tmpdir(), "dsh-firefox-bidi");
}

/** Build the shared plumbing once per activation. */
function createRuntime(config) {
  const bridge = new BridgeServer({ path: config.bridgePath, token: config.bridgeToken });
  const bidi = new BidiClient(`ws://127.0.0.1:${config.port}/session`);

  return {
    config,
    bridge,
    bidi,
    bidiPort: config.port,

    /**
     * Pick the live transport, preferring the connected extension.
     *
     * @param signal - the tool call's cancellation signal.
     * @returns `{ kind, transport }`.
     */
    async pick(signal) {
      if (bridge.connected) return { kind: "extension", transport: extensionTransport(bridge) };
      try {
        await bidi.connect();
        return { kind: "bidi", transport: bidiTransport(bidi) };
      } catch (error) {
        throw new Error(
          `No Firefox is reachable. Turn on the switch in the DSH Bridge extension, ` +
            `or start Firefox with --remote-debugging-port ${config.port}. (${error?.message ?? error})`,
        );
      }
    },

    async dispose() {
      await bidi.close().catch(() => undefined);
      await bridge.close().catch(() => undefined);
    },
  };
}

/** `firefox_status` — which transport is live, and what is open. */
function statusTool(runtime) {
  return defineTool({
    name: "firefox_status",
    description:
      "Report how DSH can currently reach Firefox and which tabs are open. Prefers the DSH Bridge " +
      "extension when its switch is on; otherwise falls back to a WebDriver BiDi connection. Use " +
      "it first when unsure whether browser control is available.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          reachable: { type: "boolean", required: true },
          mode: { type: "string", required: true },
          port: { type: "integer", required: true },
          browserVersion: { type: "string" },
          bridgeInfo: { type: "string" },
          tabs: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                context: { type: "string", required: true },
                url: { type: "string" },
                title: { type: "string" },
                controlled: { type: "boolean" },
                active: { type: "boolean" },
              },
            },
          },
          detail: { type: "string" },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.reachable
            ? `Firefox reachable via ${value.mode}` +
              `${value.browserVersion ? ` (v${value.browserVersion})` : ""} — ${value.tabs.length} tab(s).`
            : `Firefox is not reachable. ${value.detail ?? ""}`.trim(),
        },
      ],
    },
    async execute() {
      if (runtime.bridge.connected) {
        try {
          const tabs = await extensionTransport(runtime.bridge).listTabs();
          return {
            reachable: true,
            mode: "extension",
            port: runtime.bidiPort,
            browserVersion: "",
            bridgeInfo: JSON.stringify(runtime.bridge.info ?? {}),
            tabs,
            detail: "",
          };
        } catch (error) {
          return {
            reachable: false,
            mode: "extension",
            port: runtime.bidiPort,
            tabs: [],
            detail: `the extension is connected but did not answer: ${error?.message ?? error}`,
          };
        }
      }

      try {
        const client = await runtime.bidi.connect(8000);
        const transport = bidiTransport(client);
        return {
          reachable: true,
          mode: "bidi",
          port: runtime.bidiPort,
          browserVersion: client.browserVersion ?? "",
          bridgeInfo: "",
          tabs: await transport.listTabs({ titles: true }),
          detail: "",
        };
      } catch (error) {
        await runtime.bidi.close().catch(() => undefined);
        return {
          reachable: false,
          mode: "none",
          port: runtime.bidiPort,
          tabs: [],
          detail:
            `${error?.message ?? error} Turn on the DSH Bridge extension's switch, or start ` +
            `Firefox with --remote-debugging-port ${runtime.bidiPort}.`,
        };
      }
    },
  });
}

/** `firefox_launch` — start Firefox with the BiDi remote agent enabled. */
function launchTool(runtime) {
  return defineTool({
    name: "firefox_launch",
    description:
      "Start a separate Firefox with the WebDriver BiDi remote agent enabled, then wait until it " +
      "accepts commands. Only needed for the fallback transport — with the DSH Bridge extension " +
      "installed and switched on, no launch step exists. Uses a dedicated agent profile by default, " +
      "so the user's own browser is untouched.",
    parameters: {
      url: { type: "string", description: "Optional page to open in the first tab." },
      waitMs: {
        type: "integer",
        description: "How long to wait for the endpoint to answer before giving up. Default 20000.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          started: { type: "boolean", required: true },
          port: { type: "integer", required: true },
          profileDir: { type: "string", required: true },
          detail: { type: "string" },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.started
            ? `BiDi Firefox is listening on port ${value.port} (profile: ${value.profileDir}).`
            : `Firefox did not come up: ${value.detail ?? "unknown error"}`,
        },
      ],
    },
    async execute(args, exec) {
      const firefoxPath = resolveFirefoxPath(runtime.config);
      const profileDir = resolveProfileDir(runtime.config);
      if (!firefoxPath) {
        throw new Error(
          "No Firefox executable found. Set the plugin's firefoxPath config to firefox.exe.",
        );
      }
      mkdirSync(profileDir, { recursive: true });

      if (await runtime.bidi.connect(1500).then(() => true).catch(() => false)) {
        return {
          started: true,
          port: runtime.bidiPort,
          profileDir,
          detail: "Already reachable; reused the running instance.",
        };
      }

      const flags = [
        ...(runtime.config.headless ? ["--headless"] : []),
        "--remote-debugging-port",
        String(runtime.bidiPort),
        "--new-instance",
        "--no-remote",
        "--profile",
        profileDir,
      ];
      if (args.url) flags.push(String(args.url));

      const child = spawn(firefoxPath, flags, { detached: true, stdio: "ignore" });
      child.unref();

      const deadline = Date.now() + Math.max(2000, Number(args.waitMs ?? 20000));
      while (Date.now() < deadline) {
        if (exec.signal?.aborted) throw new Error("launch aborted");
        if (await runtime.bidi.connect(1200).then(() => true).catch(() => false)) {
          return { started: true, port: runtime.bidiPort, profileDir, detail: "" };
        }
        await delay(400);
      }
      return {
        started: false,
        port: runtime.bidiPort,
        profileDir,
        detail:
          "The remote agent never answered. Another Firefox may already own the port, or the " +
          "profile is locked by a running instance.",
      };
    },
  });
}

/** `firefox_tabs` — enumerate open tabs. */
function tabsTool(runtime) {
  return defineTool({
    name: "firefox_tabs",
    description:
      "List the tabs open in Firefox with their ids, URLs and titles. Every other firefox_* tool " +
      "accepts one of those ids (or a URL substring, or an index) as its tab. Tabs marked " +
      "controlled are the ones DSH is driving.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "string", required: true },
          tabs: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                context: { type: "string", required: true },
                url: { type: "string" },
                title: { type: "string" },
                controlled: { type: "boolean" },
                active: { type: "boolean" },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.tabs.length
            ? value.tabs
                .map(
                  (tab) =>
                    `${tab.controlled ? "●" : " "} ${tab.context}  ${tab.title || "(untitled)"}  ${tab.url}`,
                )
                .join("\n")
            : "No open tabs.",
        },
      ],
    },
    async execute(_args, exec) {
      const { kind, transport } = await runtime.pick(exec.signal);
      return { mode: kind, tabs: await transport.listTabs({ titles: true }) };
    },
  });
}

/** `firefox_open` — create a tab DSH owns, visible in the user's tab bar. */
function openTool(runtime) {
  return defineTool({
    name: "firefox_open",
    description:
      "Open a new tab in the user's Firefox that DSH owns. The tab appears in their tab bar, is " +
      "outlined in red while DSH controls it, and is marked in its title, so they can watch what is " +
      "happening and take over at any moment.",
    parameters: {
      url: { type: "string", description: "URL to open. Defaults to a blank tab." },
      active: {
        type: "boolean",
        description: "Whether to focus the new tab. Defaults to true.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "string", required: true },
          context: { type: "string", required: true },
          url: { type: "string" },
          detail: { type: "string" },
        },
      },
      render: (_args, value) => [
        { type: "text", text: `Opened ${value.url || "about:blank"} as tab ${value.context}` },
      ],
    },
    async execute(args, exec) {
      const { kind, transport } = await runtime.pick(exec.signal);
      if (kind !== "extension") {
        throw new Error(
          "firefox_open needs the DSH Bridge extension: the BiDi transport cannot mark a tab as " +
            "DSH-owned. Turn the extension's switch on, or use firefox_navigate on an existing tab.",
        );
      }
      const result = await runtime.bridge.request("tabs.create", {
        url: args.url ? String(args.url) : "about:blank",
        active: args.active !== false,
      });
      return { mode: kind, context: result.context, url: result.url ?? "", detail: "" };
    },
  });
}

/** `firefox_eval` — read page state precisely. */
function evalTool(runtime) {
  return defineTool({
    name: "firefox_eval",
    description:
      "Read state out of a Firefox tab. Prefer this over screenshots: it returns the page's real " +
      "data instead of a picture of it. With the DSH Bridge extension the argument must be a " +
      "property path such as S.age, S.log[0].t, or a JSON array of paths, because a strict page " +
      "CSP blocks evaluating arbitrary source in the page. The WebDriver BiDi transport accepts " +
      "any JavaScript expression, including await.",
    parameters: {
      expression: {
        type: "string",
        required: true,
        description:
          "A property path (extension transport), a JSON array of paths, or a JavaScript expression (BiDi transport).",
      },
      tab: {
        type: "string",
        description: "Tab id, URL substring, or index. Defaults to the first tab.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "string", required: true },
          context: { type: "string", required: true },
          url: { type: "string", required: true },
          text: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args, exec) {
      const { kind, transport } = await runtime.pick(exec.signal);
      const tab = await resolveTab(transport, args.tab);
      const text = await transport.evalText(tab.context, String(args.expression));
      return { mode: kind, context: tab.context, url: tab.url ?? "", text };
    },
  });
}

/** `firefox_navigate` — load a URL in a tab. */
function navigateTool(runtime) {
  return defineTool({
    name: "firefox_navigate",
    description:
      "Navigate a Firefox tab to a URL and wait for the load to finish. Returns the resulting URL " +
      "and title.",
    parameters: {
      url: { type: "string", required: true, description: "Absolute http(s) URL to open." },
      tab: {
        type: "string",
        description: "Tab id, URL substring, or index. Defaults to the first tab.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "string", required: true },
          context: { type: "string", required: true },
          url: { type: "string", required: true },
          title: { type: "string" },
        },
      },
      render: (_args, value) => [
        { type: "text", text: `Loaded ${value.url}${value.title ? ` — ${value.title}` : ""}` },
      ],
    },
    async execute(args, exec) {
      const { kind, transport } = await runtime.pick(exec.signal);
      const tab = await resolveTab(transport, args.tab);
      const result = await transport.navigate(tab.context, String(args.url));
      return { mode: kind, context: tab.context, url: result.url, title: result.title };
    },
  });
}

/** `firefox_input` — synthesize a click, typing, a named key, or a hover. */
function inputTool(runtime) {
  return defineTool({
    name: "firefox_input",
    description:
      "Interact with a Firefox tab. `click` clicks a selector (or a page coordinate), `type` " +
      "focuses a selector and enters text, `key` presses named keys such as Enter or Tab, and " +
      "`hover` moves the pointer to a selector or coordinate. Prefer a selector: a synthesized " +
      "click on the element survives scrolling and layout, where a raw coordinate does not.",
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ["click", "type", "key", "hover"],
        description: "Which interaction to perform.",
      },
      tab: {
        type: "string",
        description: "Tab id, URL substring, or index. Defaults to the first tab.",
      },
      selector: {
        type: "string",
        description: "CSS selector for the target element. Required for type and for a selector click.",
      },
      text: { type: "string", description: "Text to enter for `type`." },
      keys: {
        type: "array",
        description: 'Named keys for `key`, for example ["Enter"] or ["Control","a"].',
        items: { type: "string" },
      },
      x: { type: "number", description: "Viewport x coordinate, for a coordinate click or hover." },
      y: { type: "number", description: "Viewport y coordinate, for a coordinate click or hover." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "string", required: true },
          context: { type: "string", required: true },
          performed: { type: "string", required: true },
          detail: { type: "string" },
        },
      },
      render: (_args, value) => [
        { type: "text", text: `${value.performed}${value.detail ? ` — ${value.detail}` : ""}` },
      ],
    },
    async execute(args, exec) {
      const { kind, transport } = await runtime.pick(exec.signal);
      const tab = await resolveTab(transport, args.tab);
      const action = String(args.action);
      const result = await transport.input(tab.context, {
        action,
        selector: args.selector ? String(args.selector) : "",
        text: args.text,
        keys: args.keys,
        x: args.x,
        y: args.y,
      });
      const target = args.selector ? ` ${args.selector}` : "";
      return {
        mode: kind,
        context: tab.context,
        performed: `${action}${target}`,
        detail: result.detail ?? "",
      };
    },
  });
}

/** `firefox_choices` — read a decision card as structure, and optionally pick. */
function choicesTool(runtime) {
  return defineTool({
    name: "firefox_choices",
    description:
      "Read the open decision card in a Firefox tab as structure: the heading, the body, and every " +
      "choice with its own number, label, sub-label and key. Use this instead of guessing options " +
      "from the page's whole text — prose cannot tell a choice apart from the headings around it, " +
      "and guessing clicks the wrong button. Pass `choose` to click one choice by its number in the " +
      "same call.",
    parameters: {
      tab: {
        type: "string",
        description: "Tab id, URL substring, or index. Defaults to the first tab.",
      },
      choose: {
        type: "integer",
        description: "1-based choice number to click after reading the card.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "string", required: true },
          context: { type: "string", required: true },
          present: { type: "boolean", required: true },
          title: { type: "string" },
          body: { type: "string" },
          fact: { type: "string" },
          needsNote: { type: "boolean" },
          needsName: { type: "boolean" },
          choices: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                index: { type: "integer", required: true },
                key: { type: "string" },
                label: { type: "string" },
                sub: { type: "string" },
                group: { type: "string" },
              },
            },
          },
          chosen: { type: "string" },
        },
      },
      render: (_args, value) => {
        if (!value.present) return [{ type: "text", text: "No decision card is open." }];
        const lines = value.choices.map(
          (choice) => `${choice.index}. ${choice.label}${choice.sub ? ` — ${choice.sub}` : ""}`,
        );
        const head = value.title ? `${value.title}\n` : "";
        const chosen = value.chosen ? `\n\nChose: ${value.chosen}` : "";
        return [{ type: "text", text: `${head}${lines.join("\n")}${chosen}` }];
      },
    },
    async execute(args, exec) {
      const { kind, transport } = await runtime.pick(exec.signal);
      const tab = await resolveTab(transport, args.tab);
      const card = await transport.choices(tab.context, args.choose);
      return {
        mode: kind,
        context: tab.context,
        present: !!card.present,
        title: card.title ?? "",
        body: card.body ?? "",
        fact: card.fact ?? "",
        needsNote: !!card.needsNote,
        needsName: !!card.needsName,
        choices: card.choices ?? [],
        chosen: card.chosen ? `${card.chosen.index} (${card.chosen.key})` : "",
      };
    },
  });
}

/** `firefox_elements` — list the clickable things, with exact selectors. */
function elementsTool(runtime) {
  return defineTool({
    name: "firefox_elements",
    description:
      "List the interactive elements currently visible in a Firefox tab, each with its text and the " +
      "exact CSS selector that will hit it. Use this before clicking a control whose identity was " +
      "never read: a guessed selector clicks whatever happens to match first, which may be the wrong " +
      "button entirely.",
    parameters: {
      tab: {
        type: "string",
        description: "Tab id, URL substring, or index. Defaults to the first tab.",
      },
      selector: {
        type: "string",
        description:
          "CSS selector describing what to list. Defaults to buttons, role=button, links and inputs.",
      },
      limit: { type: "integer", description: "Maximum elements to return. Default 60, max 200." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "string", required: true },
          context: { type: "string", required: true },
          total: { type: "integer", required: true },
          shown: { type: "integer", required: true },
          elements: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                index: { type: "integer", required: true },
                tag: { type: "string" },
                id: { type: "string" },
                text: { type: "string" },
                type: { type: "string" },
                selector: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.elements.length
            ? value.elements
                .map((el) => `${el.index}. [${el.tag}${el.id ? `#${el.id}` : ""}] ${el.text}  ← ${el.selector}`)
                .join("\n")
            : "No interactive elements matched.",
        },
      ],
    },
    async execute(args, exec) {
      const { kind, transport } = await runtime.pick(exec.signal);
      const tab = await resolveTab(transport, args.tab);
      const listing = await transport.describe(tab.context, {
        selector: args.selector,
        limit: args.limit ?? 60,
      });
      return {
        mode: kind,
        context: tab.context,
        total: listing.total ?? 0,
        shown: listing.shown ?? 0,
        elements: listing.elements ?? [],
      };
    },
  });
}

/** `firefox_screenshot` — capture the tab to a PNG the agent can look at. */
function screenshotTool(runtime) {
  return defineTool({
    name: "firefox_screenshot",
    description:
      "Capture a Firefox tab as a PNG and return its file path, for looking at pages whose state " +
      "cannot be read from the DOM. In extension mode this captures in the background without " +
      "stealing the user's focus. Prefer firefox_eval when the page exposes the data.",
    parameters: {
      tab: {
        type: "string",
        description: "Tab id, URL substring, or index. Defaults to the first tab.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "string", required: true },
          path: { type: "string", required: true },
          bytes: { type: "integer", required: true },
          url: { type: "string" },
        },
      },
      render: (_args, value) => [
        { type: "text", text: `Saved a ${value.bytes}-byte screenshot to ${value.path}` },
      ],
    },
    async execute(args, exec) {
      const { kind, transport } = await runtime.pick(exec.signal);
      const tab = await resolveTab(transport, args.tab);
      const base64 = await transport.screenshot(tab.context);
      const buffer = Buffer.from(base64, "base64");
      const dir = resolveScreenshotDir(runtime.config);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `shot-${Date.now()}.png`);
      writeFileSync(file, buffer);
      return { mode: kind, path: file, bytes: buffer.length, url: tab.url ?? "" };
    },
  });
}

/**
 * Register the Firefox tools and the extension bridge.
 *
 * @param ctx - the registrant context.
 * @param config - the resolved deployment configuration.
 */
export function apply(ctx, config) {
  const runtime = createRuntime(config);
  const factories = [
    statusTool,
    launchTool,
    tabsTool,
    openTool,
    evalTool,
    choicesTool,
    elementsTool,
    navigateTool,
    inputTool,
    screenshotTool,
  ];

  ctx.effect(() => {
    const disposers = factories.map((factory) => ctx.tools.register(factory(runtime)));
    return async () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          /* an already-disposed registration is fine */
        }
      }
      await runtime.dispose();
    };
  });

  // The bridge rides on the host web server. `inject` defers this until that
  // service exists: probing once with ctx.get() silently skipped registration
  // whenever the plugin activated before the web server finished booting, which
  // left the upgrade route unregistered and every extension handshake a 404.
  ctx.inject(["webServer"], (scope) => {
    scope.effect(() => runtime.bridge.attach(scope.webServer));
  });

  // browser-use is an optional shared slot; a taken slot must not break the tools.
  ctx.effect(() => {
    const browserUse = ctx.get?.("browserUse");
    if (!browserUse) return () => undefined;
    try {
      const release = browserUse.register("firefox-bidi");
      return () => {
        void release?.();
      };
    } catch {
      return () => undefined;
    }
  });
}
