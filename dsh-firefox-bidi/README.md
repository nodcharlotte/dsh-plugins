# Firefox control for DSH

Two transports behind one set of tools. The switch in the toolbar is the whole
permission model.

Tested on DSH `0.2.1-rc.2` and `0.2.2-rc.5`.

For anyone auditing this before installing it, see
[What this add-on does, and does not do](#what-this-add-on-does-and-does-not-do):
it collects nothing, never contacts the internet, and holds no connection at all
while its switch is off.

| | DSH Bridge extension (primary) | WebDriver BiDi (fallback) |
| --- | --- | --- |
| Enabled by | a switch in the extension popup | starting Firefox with `--remote-debugging-port` |
| Survives a restart | yes, the switch is remembered | needs the flag every launch |
| Arbitrary JS in the page | no (property paths only) | yes |
| Tab ownership marks | red outline, green tab title, badge | none |
| Screenshot without focus steal | yes | yes |

## The extension

**Signed and installable for good.** Version 1.0.1 passed AMO automatic validation
and is approved: <https://addons.mozilla.org/developers/addon/3121623/versions>.

Direct download (signed, same file):

- [dsh-bridge-1.0.1-signed.xpi](https://github.com/nodcharlotte/dsh-plugins/releases/download/firefox-bidi-v1.0.1/dsh-bridge-1.0.1-signed.xpi)

Drag the `.xpi` into a Firefox window, or use `about:addons` → gear icon →
*Install Add-on From File…*. The add-on id `dsh-bridge@local` is what ties future
versions to it; the signature is what makes it installable permanently.

For development, load `extension/` directly in `about:debugging` → **Load Temporary
Add-on** → pick `extension/manifest.json`. A temporary add-on disappears when
Firefox restarts, and two of them at once fight over the same socket, so remove the
temporary one once the signed build is installed.

`strict_min_version` is 142 because `data_collection_permissions` (required by
Mozilla since mid-2025, declaring `none` here — this extension collects nothing)
does not exist before Firefox 142.

What it does:

- **The switch.** Off means the extension holds no connection at all, so the host
  has nothing to talk to. On means it dials `ws://127.0.0.1:3080/firefox-bridge`.
  There is no separate "quit" step and no launch flag.
- **Red outline.** A controlled tab gets a fixed, click-through red border drawn
  inside the page. Tab chrome itself cannot be restyled by an extension, so the
  frame goes in the content.
- **Green tab marker.** The tab title is prefixed with 🟢, restored when control
  ends, and re-applied if the page rewrites its own title.
- **Badge.** A per-tab green dot on the toolbar icon while that tab is controlled.

## Why property paths instead of `eval`

`1in8b.life` serves `Content-Security-Policy: script-src 'self'` — no
`unsafe-eval`. Both `eval()` and injected `<script>` tags are blocked there, in
any world. So the extension reads page state by walking properties through
Firefox's `window.wrappedJSObject` waiver, which needs no evaluation:

```
firefox_eval  expression: "S.age"
firefox_eval  expression: "S.log[0].t"
firefox_eval  expression: '["S.age", "S.born"]'   # several paths, one trip
```

Arbitrary expressions need the BiDi transport.

## Host side

| file | role |
| --- | --- |
| `bridge.js` | WebSocket server on the host web server, plus the request/response framing |
| `transport.js` | `bidiTransport` / `extensionTransport` behind one interface, and tab resolution |
| `index.js` | the tools and the transport picker |
| `bidi.js` | the WebDriver BiDi client (fallback) |

## Handshake gates

Any page can dial loopback, so the upgrade is refused unless both hold:

1. `Origin` starts with `moz-extension://` — page script cannot forge it.
2. The `?t=` token matches the plugin's `bridgeToken` config.

Both were exercised in `_bridgetest.mjs`, which runs offline against a mock
extension:

```
node _bridgetest.mjs
```

It covers origin refusal, token refusal, request/response, timeouts, the path-only
eval contract, and disconnect handling.

## Config

| key | default | meaning |
| --- | --- | --- |
| `bridgePath` | `/firefox-bridge` | path the extension dials |
| `bridgeToken` | `dsh-local-bridge` | shared token; must match the popup |
| `port` | `9222` | BiDi port for the fallback |
| `firefoxPath` | auto-detect | `firefox.exe` for BiDi launches |
| `profileDir` | dedicated agent profile | profile used for BiDi launches |
| `screenshotDir` | temp directory | where screenshots are written |
| `headless` | `false` | launch BiDi Firefox without a window |

## Tools

| tool | purpose |
| --- | --- |
| `firefox_status` | which transport is live, and the open tabs |
| `firefox_open` | open a tab DSH owns (extension only) |
| `firefox_tabs` | list tabs, marking controlled ones |
| `firefox_eval` | read page state |
| `firefox_navigate` | load a URL |
| `firefox_input` | click / type / key / hover |
| `firefox_screenshot` | capture a tab to PNG |
| `firefox_launch` | start a BiDi Firefox (fallback only) |

## Roadmap

Desktop-wide control — UI Automation for any application plus synthesized input —
is planned as a second provider inside this same plugin.

## Signing

For permanent installation, package `extension/` as a ZIP and submit it to
<https://addons.mozilla.org/developers/> as an **unlisted** (self-distributed)
add-on. AMO returns a signed `.xpi`; dragging that into Firefox installs it for
good, and the switch keeps working across restarts. The add-on id
`dsh-bridge@local` in `manifest.json` is what ties future updates to it.

Submit the ZIP with `manifest.json` at its root, not inside a folder. Since
mid-2025 AMO rejects a manifest without
`browser_specific_settings.gecko.data_collection_permissions`; this add-on
declares `["none"]`, and `strict_min_version` must be 142+ because that key does
not exist before Firefox 142.

## Install on another computer

The signed `.xpi` is portable — one file, no build step, nothing to compile.

1. Download the signed file from this repository's release
   (`firefox-bidi-v1.0.1`), or from the AMO developer page for
   `dsh-bridge@local` (version 1.0.1), or copy `dsh-bridge@local.xpi` from the
   first machine's profile:
   `%APPDATA%\Mozilla\Firefox\Profiles\<profile>\extensions\dsh-bridge@local.xpi`
2. On the other machine, open Firefox and **drag the `.xpi` into a browser
   window**, then accept the install prompt. `about:addons` → gear icon →
   *Install Add-on From File…* also works.
3. Start DSH on **that same machine**, then turn the toolbar switch on.

The extension talks to `ws://127.0.0.1:<port>`, so it only reaches a DSH running
on the same computer. Pointing it at another machine means changing the host in
the popup's connection settings *and* rebinding DSH's web server off loopback —
that exposes the control channel to the network, which is why loopback is the
default and the token exists.

Because the add-on is unlisted, AMO does not auto-update it. To ship a change,
bump `version` in `manifest.json`, submit again, and install the new `.xpi` on
each machine.

## What this add-on does, and does not do

If you hand this to someone else, they should be able to verify these claims
without reading the source:

- **It collects nothing.** No telemetry, no analytics, no remote logging. The
  manifest declares `data_collection_permissions: ["none"]`.
- **It never talks to the internet.** Its only network destination is
  `127.0.0.1`, the loopback address — traffic that cannot leave the machine and
  never touches a network interface. There is no external endpoint in the code.
- **No periodic traffic.** Opening the switch dials one WebSocket; after that,
  traffic exists only when the host issues a command or the connection breaks
  and reconnects. There is no heartbeat, poll, or scheduled request.
- **Permissions are minimal and visible**: `<all_urls>` (to draw the frame and
  read the DOM on whatever page the user is looking at), `tabs`, `storage`. No
  `webRequest`, no `cookies`, no `history`, no downloads.
- **The source is the artifact.** The ZIP contains readable, unminified,
  un-transpiled JS — eight files, no bundler, no build step.
- **The switch is the whole permission model.** Off means the extension holds no
  connection at all, so nothing on the machine can reach a browser through it.

The one deliberate design choice worth knowing: page state is read through
`window.wrappedJSObject`, Firefox's documented Xray waiver, because a strict page
CSP blocks `eval`. It reads values; it never injects remote code.

