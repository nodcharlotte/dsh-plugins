# dsh-plugins

给 **DSH（DeepSeek Harness）** 用的几个第三方插件，按现状发布（as-is）。

> 适配 **DSH 0.2.1-rc.2**。插件接口还是预览版，升级 DSH 后可能失效。
> 本仓库不保证跟进更新——能用的版本就是现在这个。
> 非官方项目，与 DeepSeek 无关。

## 插件

| 目录 | 作用 | 备注 |
| --- | --- | --- |
| [dsh-live-code](dsh-live-code/) | 右侧栏实时代码视图：模型读/写/编辑文件时打开对应文件，高亮变更行并跳转 | 无依赖，装上就能用 |
| [dsh-spend-pin](dsh-spend-pin/) | OpenRouter 固定上游 endpoint，并按实际供应商计价（CNY / USD） | 需要 OpenRouter API Key |
| [dsh-firefox-bidi](dsh-firefox-bidi/) | 从 DSH 控制 Firefox：扩展授权开关 + WebDriver BiDi 回退 | 扩展需自行签名安装 |

## 安装

DSH 的插件通过 profile 注册，装哪个就把哪个目录链进去：

```bat
dsh plugin --profile web add "<本仓库路径>\dsh-live-code"
```

- 注册后需要**重启 `dsh web`**；
- profile 里记的是软链，移动插件目录后要重新 `add` 一次；
- 每个插件目录下都有自己的 README，配置项和已知限制写在那里。

## English

A small collection of third-party plugins for **DSH (DeepSeek Harness)**:
a live code viewer, an OpenRouter endpoint pinner with per-session spend, and
Firefox control via WebDriver BiDi.

Pinned to DSH `0.2.1-rc.2`, published **as-is** with no update guarantee.
Unofficial, not affiliated with DeepSeek.

## 许可

[MIT](LICENSE)
