import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const DEFAULT_AGY_MODELS = [
  { id: 'gemini-4-argon-high', displayName: 'Gemini 4 Argon (High)' },
  { id: 'gemini-4-argon-medium', displayName: 'Gemini 4 Argon (Medium)' },
  { id: 'gemini-4-argon-low', displayName: 'Gemini 4 Argon (Low)' },
  { id: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)' },
  { id: 'gemini-3.8-flash-medium', displayName: 'Gemini 3.8 Flash (Medium)' },
  { id: 'gemini-3.8-flash-low', displayName: 'Gemini 3.8 Flash (Low)' },
  { id: 'claude-opus-5-5-high', displayName: 'Claude Opus 5.5 (High)' },
  { id: 'claude-opus-5-5-medium', displayName: 'Claude Opus 5.5 (Medium)' },
  { id: 'claude-opus-5-5-low', displayName: 'Claude Opus 5.5 (Low)' },
  { id: 'claude-sonnet-5-5-high', displayName: 'Claude Sonnet 5.5 (High)' },
  { id: 'claude-sonnet-5-5-medium', displayName: 'Claude Sonnet 5.5 (Medium)' },
  { id: 'claude-sonnet-5-5-low', displayName: 'Claude Sonnet 5.5 (Low)' },
  { id: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)' },
]

function resolveDefaultAgyBin() {
  if (process.env.AGY_BIN) return process.env.AGY_BIN
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const winCandidate = join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')
    if (existsSync(winCandidate)) return winCandidate
  }
  return 'agy'
}

const EMPTY_CWD = join(tmpdir(), 'dsh-agy-llm-empty')

function formatContent(content) {
  if (typeof content === 'string') return content
  const parts = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text)
    } else if (block.type === 'thinking') {
      parts.push(`<thinking>\n${block.thinking}\n</thinking>`)
    } else if (block.type === 'tool-call') {
      parts.push(`<dsh_tool_call>{"name":${JSON.stringify(block.name)},"arguments":${block.arguments}}</dsh_tool_call>`)
    }
  }
  return parts.join('\n')
}

function buildPrompt(options) {
  const sections = []

  sections.push(
    '# DeepSeek Harness LLM Bridge Instructions',
    'You are acting as the underlying LLM engine for DeepSeek Harness (dsh).',
    'IMPORTANT: Do NOT invoke your own built-in Antigravity CLI tools (such as run_command, read_file, write_file, edit_file, etc.).',
    'Instead, respond directly to the conversation below. When you need to call one of the provided dsh tools, output one or more XML blocks in the exact format:',
    '<dsh_tool_call>{"name": "tool_name", "arguments": {...}}</dsh_tool_call>',
    'When you emit a <dsh_tool_call> block, stop immediately after emitting the tool call(s) so dsh can execute them and return the <dsh_tool_result> in the next turn.',
  )

  if (options.systemPrompt) {
    const sys = typeof options.systemPrompt === 'string'
      ? options.systemPrompt
      : options.systemPrompt.join('\n\n')
    if (sys.trim()) {
      sections.push(`# System Prompt\n${sys}`)
    }
  }

  if (options.tools && options.tools.length > 0 && options.toolChoice !== 'none') {
    const toolDefs = options.tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))
    sections.push(`# Available dsh Tools (JSON Schema)\n\`\`\`json\n${JSON.stringify(toolDefs, null, 2)}\n\`\`\``)
  }

  const transcript = []
  for (const msg of options.messages) {
    if (msg.role === 'system') {
      transcript.push(`[SYSTEM]\n${formatContent(msg.content)}`)
    } else if (msg.role === 'user') {
      transcript.push(`[USER]\n${formatContent(msg.content)}`)
    } else if (msg.role === 'assistant') {
      transcript.push(`[ASSISTANT]\n${formatContent(msg.content)}`)
    } else if (msg.role === 'tool') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.map(p => (p.type === 'text' ? p.text : '[image]')).join('\n')
      transcript.push(
        `[TOOL RESULT (toolCallId=${msg.toolCallId}${msg.isError ? ', error=true' : ''})]\n<dsh_tool_result>\n${text}\n</dsh_tool_result>`,
      )
    }
  }

  sections.push(`# Conversation History\n${transcript.join('\n\n')}\n\n[ASSISTANT]`)
  return sections.join('\n\n')
}

function extractToolCalls(rawText) {
  const toolCalls = []
  const regex = /<dsh_tool_call>\s*([\s\S]*?)\s*<\/dsh_tool_call>/g
  let cleanText = ''
  let lastIndex = 0
  let match

  while ((match = regex.exec(rawText)) !== null) {
    cleanText += rawText.slice(lastIndex, match.index)
    lastIndex = regex.lastIndex
    const payload = (match[1] ?? '').trim()
    try {
      const parsed = JSON.parse(payload)
      if (typeof parsed.name === 'string' && parsed.name.length > 0) {
        const argsStr = typeof parsed.arguments === 'string'
          ? parsed.arguments
          : JSON.stringify(parsed.arguments ?? {})
        toolCalls.push({ name: parsed.name, arguments: argsStr })
      }
    } catch {
      cleanText += match[0]
    }
  }
  cleanText += rawText.slice(lastIndex)
  return { cleanText: cleanText.trim(), toolCalls }
}

class AgyLlmAdapter {
  constructor(agyBin, provider) {
    this.agyBin = agyBin
    this.provider = provider
    this.cachedModels = null
  }

  async discoverModels(signal) {
    if (this.cachedModels) return this.cachedModels
    return await new Promise((resolve) => {
      const child = spawn(this.agyBin, ['models'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        signal,
      })
      let out = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { out += chunk })
      child.on('error', () => resolve(DEFAULT_AGY_MODELS))
      child.on('close', (code) => {
        if (code !== 0 || !out.trim()) {
          resolve(DEFAULT_AGY_MODELS)
          return
        }
        const parsed = []
        for (const line of out.split(/\r?\n/)) {
          const trimmed = line.trim()
          if (!trimmed) continue
          const [id, displayName] = trimmed.split('\t')
          if (id) parsed.push({ id: id.trim(), displayName: (displayName ?? id).trim() })
        }
        if (parsed.length > 0) {
          this.cachedModels = parsed
          resolve(parsed)
        } else {
          resolve(DEFAULT_AGY_MODELS)
        }
      })
    })
  }

  async listModels(signal) {
    const models = await this.discoverModels(signal)
    return models.map(m => ({
      provider: this.provider,
      id: m.id,
      displayName: m.displayName,
      context: { maxInputTokens: 200_000, maxOutputTokens: 32_768 },
    }))
  }

  async resolveModel(provider, model, signal) {
    const models = await this.discoverModels(signal)
    const found = models.find(m => m.id === model)
    return {
      provider,
      id: model,
      displayName: found?.displayName ?? model,
      context: { maxInputTokens: 200_000, maxOutputTokens: 32_768 },
    }
  }

  async generate(options) {
    const content = []
    let usage = { inputTokens: 0, outputTokens: 0 }
    let stopReason = { kind: 'stop' }
    for await (const chunk of this.stream(options)) {
      if (chunk.type === 'block-end') content.push(chunk.block)
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') stopReason = chunk.reason
    }
    return { content, usage, stopReason }
  }

  async *stream(options) {
    mkdirSync(EMPTY_CWD, { recursive: true })
    const prompt = buildPrompt(options)
    const args = [
      '--output-format',
      'stream-json',
      '--disable-slash-commands',
      '--model',
      options.model,
    ]

    const child = spawn(this.agyBin, args, {
      cwd: EMPTY_CWD,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const onAbort = () => {
      child.kill()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdin.write(prompt, 'utf8')
    child.stdin.end()

    let stderrText = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderrText += chunk
    })

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })

    let fullResponse = ''
    let streamedText = ''
    let textBlockStarted = false
    let inputTokens = 0
    let outputTokens = 0

    try {
      for await (const line of rl) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) continue
        let parsed
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          continue
        }

        if (parsed.event === 'step_update' && parsed.step_update) {
          const step = parsed.step_update
          if (step.usage) {
            if (typeof step.usage.input_tokens === 'number') inputTokens = step.usage.input_tokens
            if (typeof step.usage.output_tokens === 'number') outputTokens = step.usage.output_tokens
          }
          if (step.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta.length > 0) {
            fullResponse += step.text_delta
            if (!fullResponse.includes('<dsh_tool_call')) {
              if (!textBlockStarted) {
                textBlockStarted = true
                yield { type: 'block-start', index: 0, blockType: 'text' }
              }
              streamedText += step.text_delta
              yield { type: 'text-delta', index: 0, text: step.text_delta }
            }
          }
        } else if (parsed.event === 'result' && parsed.result) {
          const res = parsed.result
          if (typeof res.response === 'string' && res.response.length > 0 && fullResponse.length === 0) {
            fullResponse = res.response
          }
          if (res.usage) {
            if (typeof res.usage.input_tokens === 'number') inputTokens = res.usage.input_tokens
            if (typeof res.usage.output_tokens === 'number') outputTokens = res.usage.output_tokens
          }
        }
      }

      const exitCode = await new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve(child.exitCode)
          return
        }
        child.once('close', code => resolve(code ?? 1))
        child.once('error', () => resolve(1))
      })

      if (exitCode !== 0 && fullResponse.length === 0) {
        const err = new Error(`agy CLI exited with code ${exitCode}: ${stderrText.trim() || 'no output'}`)
        err.code = 'AGY_CLI_ERROR'
        throw err
      }

      const { cleanText, toolCalls } = extractToolCalls(fullResponse)
      let nextIndex = 0

      if (textBlockStarted) {
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'text', text: cleanText || streamedText },
        }
        nextIndex = 1
      } else if (cleanText.length > 0) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: cleanText }
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'text', text: cleanText },
        }
        nextIndex = 1
      }

      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]
        const idx = nextIndex + i
        const callId = `agy-call-${Date.now()}-${i}`
        yield { type: 'block-start', index: idx, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index: idx,
          id: callId,
          name: tc.name,
          argumentsDelta: tc.arguments,
        }
        yield {
          type: 'block-end',
          index: idx,
          block: {
            type: 'tool-call',
            id: callId,
            name: tc.name,
            arguments: tc.arguments,
          },
        }
      }

      yield {
        type: 'usage',
        usage: { inputTokens, outputTokens },
      }

      yield {
        type: 'finish',
        reason: toolCalls.length > 0 ? { kind: 'tool-calls' } : { kind: 'stop' },
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      rl.close()
    }
  }
}

export const name = 'llm-agy'
export const inject = ['llm']

export function apply(ctx, config = {}) {
  const agyBin = config.agyBin || resolveDefaultAgyBin()
  const provider = config.provider || 'agy'
  const adapter = new AgyLlmAdapter(agyBin, provider)
  ctx.llm.registerAdapter([provider], adapter)
  for (const m of DEFAULT_AGY_MODELS) {
    ctx.llm.registerModel({
      provider,
      id: m.id,
      displayName: m.displayName,
      context: { maxInputTokens: 200_000, maxOutputTokens: 32_768 },
    })
  }
}
