# dsh-llm-agy

[English](README.md) | 中文

在 **DeepSeek Harness (`dsh`)** 中直接使用本机已登录的 **Google Antigravity CLI (`agy`)** 模型——**无需任何 API Key 或 `baseURL`**。

## 功能特性

- **零密钥 / 免配地址**：直接复用本机已登录的 `agy` CLI 会话态。
- **自动接入模型选择器**：自动向 `dsh` 注册 `agy` 提供方及全部 13 个模型（`gemini-4-argon-high`、`claude-opus-5-5-high`、`claude-sonnet-5-5-high`、`gemini-3.8-flash-high`、`gpt-oss-120b-medium` 等），并自动通过首次启动引导。
- **实时流式输出与工具调用**：将 `agy --output-format stream-json` 的 NDJSON 事件流与 `<dsh_tool_call>` 多轮协议桥接为 `dsh` 原生 `StreamChunk` 分片。
- **标准 DSH 插件组合包（Bundle）**：支持在 DSH Web 界面（**插件 → 添加插件**）或命令行（`dsh plugin add`）一键安装、启停和卸载。

## 前置要求

1. 本机已安装并登录 **Google Antigravity CLI (`agy`)**：
   - Windows 默认路径：`%LOCALAPPDATA%\agy\bin\agy.exe`
   - macOS / Linux：`agy` 在系统 `PATH` 中（或通过环境变量 `AGY_BIN` 指定可执行文件路径）
2. 可在终端验证：
   ```sh
   agy models
   ```

## 在 DSH Web 界面中操作添加

1. 打开 **DeepSeek Harness Web** 界面。
2. 点击左侧导航栏的 **「插件 (Plugins)」**。
3. 点击右上角的 **「添加插件 (Add plugin)」** 按钮。
4. 在弹窗输入框中填入以下任一地址，点击 **「安装 (Install)」**：
   - **通过 GitHub 仓库安装**：
     ```text
     https://github.com/TeaGo-lab/dsh-llm-agy
     ```
     *（或输入简写 `github:TeaGo-lab/dsh-llm-agy`）*
   - **通过本地目录安装（填写绝对路径）**：
     ```text
     E:\GitProject\dsh-llm-agy
     ```
5. 安装完成后点击 **「立即启用 (Enable now)」**（支持 HMR 热加载，无需重启）。
6. 回到聊天页，在输入框左下角的**模型选择器**中即可选择任意 `agy` 模型（默认已设为 `Gemini 4 Argon (High)`）。

## 通过 CLI 命令安装

```sh
# 从 GitHub 安装到 web profile
dsh plugin --profile web add https://github.com/TeaGo-lab/dsh-llm-agy

# 或从本地目录安装
dsh plugin --profile web add E:\GitProject\dsh-llm-agy
```

## 支持的模型列表

| 模型 ID | 显示名称 |
|---|---|
| `gemini-4-argon-high` | Gemini 4 Argon (High) |
| `gemini-4-argon-medium` | Gemini 4 Argon (Medium) |
| `gemini-4-argon-low` | Gemini 4 Argon (Low) |
| `gemini-3.8-flash-high` | Gemini 3.8 Flash (High) |
| `gemini-3.8-flash-medium` | Gemini 3.8 Flash (Medium) |
| `gemini-3.8-flash-low` | Gemini 3.8 Flash (Low) |
| `claude-opus-5-5-high` | Claude Opus 5.5 (High) |
| `claude-opus-5-5-medium` | Claude Opus 5.5 (Medium) |
| `claude-opus-5-5-low` | Claude Opus 5.5 (Low) |
| `claude-sonnet-5-5-high` | Claude Sonnet 5.5 (High) |
| `claude-sonnet-5-5-medium` | Claude Sonnet 5.5 (Medium) |
| `claude-sonnet-5-5-low` | Claude Sonnet 5.5 (Low) |
| `gpt-oss-120b-medium` | GPT-OSS 120B (Medium) |

## 开源协议

MIT
