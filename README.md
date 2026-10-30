# dsh-llm-agy

English | [中文](README.zh.md)

Use your local logged-in **Google Antigravity CLI (`agy`)** models directly inside **DeepSeek Harness (`dsh`)** — no API key or `baseURL` required.

## Features

- **Zero API Key / BaseURL:** Reuses your existing local `agy` CLI authentication session.
- **Full Model Selector Integration:** Automatically registers the `agy` provider and all 13 Antigravity models (`gemini-4-argon-high`, `claude-opus-5-5-high`, `claude-sonnet-5-5-high`, `gemini-3.8-flash-high`, `gpt-oss-120b-medium`, etc.) in the DeepSeek Harness Web UI and CLI.
- **Real-time Streaming & Tool Calling:** Bridges `agy --output-format stream-json` NDJSON streaming and `<dsh_tool_call>` multi-turn tool invocations into native `dsh` `StreamChunk` events.
- **Hot-Plug Bundle:** Standard DSH Plugin Bundle (`dsh.bundle.patch`), installable directly from the DSH Web UI (**Plugins → Add plugin**) or CLI (`dsh plugin add`).

## Prerequisites

1. [Google Antigravity CLI (`agy`)](https://antigravity.google) installed and logged in on the host machine:
   - Windows default path: `%LOCALAPPDATA%\agy\bin\agy.exe`
   - macOS / Linux: `agy` available in `PATH` (or specify `AGY_BIN=/path/to/agy`)
2. Verify `agy` works by running:
   ```sh
   agy models
   ```

## Installation in DSH Web UI

1. Open **DeepSeek Harness Web**.
2. Click **Plugins (插件)** in the left sidebar.
3. Click **Add plugin (添加插件)** in the top-right corner.
4. Enter one of the following install specs in the input box and click **Install (安装)**:
   - **From GitHub:**
     ```text
     https://github.com/TeaGo-lab/dsh-llm-agy
     ```
     *(or `github:TeaGo-lab/dsh-llm-agy`)*
   - **From a local clone (absolute path):**
     ```text
     E:\GitProject\dsh-llm-agy
     ```
5. Once installed, click **Enable now (立即启用)**.
6. Open the model selector in the chat composer and pick any **agy** model (defaults to `Gemini 4 Argon (High)`).

## Installation via CLI

```sh
# Install into the web profile from GitHub
dsh plugin --profile web add https://github.com/TeaGo-lab/dsh-llm-agy

# Or install from a local directory
dsh plugin --profile web add E:\GitProject\dsh-llm-agy
```

## Supported Models

| Model ID | Display Name |
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

## License

MIT
