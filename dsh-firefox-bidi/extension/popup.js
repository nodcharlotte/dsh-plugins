/** Popup for DSH Bridge: the switch, live status, and connection settings. */
const $ = (id) => document.getElementById(id);

const els = {
  toggle: $("toggle"),
  state: $("state"),
  host: $("host"),
  count: $("count"),
  hint: $("hint"),
  release: $("release"),
  advancedToggle: $("toggle-advanced"),
  advanced: $("advanced"),
  hostInput: $("host-input"),
  portInput: $("port-input"),
  tokenInput: $("token-input"),
  save: $("save"),
};

/** Ask the background page for its current state. */
const ask = (message) => browser.runtime.sendMessage(message);

/** Paint one status snapshot. */
function paint(status) {
  els.toggle.checked = !!status.enabled;
  els.host.textContent = status.hostInfo || "—";
  els.count.textContent = String(status.controlled ?? 0);

  if (!status.enabled) {
    els.state.className = "state state--off";
    els.state.textContent = "未允许 · DSH 无法操作";
    els.hint.hidden = true;
  } else if (status.connected) {
    els.state.className = "state state--on";
    els.state.textContent = "已连接 · DSH 可以操作";
    els.hint.hidden = true;
  } else {
    els.state.className = "state state--warn";
    els.state.textContent = "已允许，但尚未连上宿主";
    els.hint.hidden = false;
    els.hint.textContent =
      (status.lastError || "正在重试…") +
      "　请确认 DSH 正在运行，且下面「连接设置」里的端口与令牌一致。";
  }
}

/** Refresh from the background page. */
async function refresh() {
  try {
    paint(await ask({ type: "dsh:getStatus" }));
  } catch {
    els.state.className = "state state--warn";
    els.state.textContent = "后台未响应";
  }
}

els.toggle.addEventListener("change", async () => {
  els.toggle.disabled = true;
  try {
    paint(await ask({ type: "dsh:setEnabled", enabled: els.toggle.checked }));
  } finally {
    els.toggle.disabled = false;
  }
});

els.release.addEventListener("click", async () => {
  paint(await ask({ type: "dsh:releaseAll" }));
});

els.advancedToggle.addEventListener("click", async () => {
  const open = els.advanced.hidden;
  els.advanced.hidden = !open;
  if (!open) return;
  const config = await browser.storage.local.get(["host", "port", "token"]);
  els.hostInput.value = config.host ?? "127.0.0.1";
  els.portInput.value = String(config.port ?? 3080);
  els.tokenInput.value = config.token ?? "dsh-local-bridge";
});

els.save.addEventListener("click", async () => {
  els.save.disabled = true;
  try {
    paint(
      await ask({
        type: "dsh:setConfig",
        host: els.hostInput.value,
        port: Number(els.portInput.value),
        token: els.tokenInput.value,
      }),
    );
  } finally {
    els.save.disabled = false;
  }
});

void refresh();
// Keep the popup honest while it is open.
setInterval(() => void refresh(), 1000);
