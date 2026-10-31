import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const DEFAULT_AGY_MODELS = [
  { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
  { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
  { id: 'gemini-4-argon-low', name: 'Gemini 4 Argon (Low)' },
  { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
  { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
  { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
  { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
  { id: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 (Medium)' },
  { id: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
  { id: 'claude-sonnet-5-5-high', name: 'Claude Sonnet 5.5 (High)' },
  { id: 'claude-sonnet-5-5-medium', name: 'Claude Sonnet 5.5 (Medium)' },
  { id: 'claude-sonnet-5-5-low', name: 'Claude Sonnet 5.5 (Low)' },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
]

function resolveDefaultAgyBin() {
  if (process.env.AGY_BIN) return process.env.AGY_BIN
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const winCandidate = join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')
    if (existsSync(winCandidate)) return winCandidate
  }
  return 'agy'
}

let cachedWinProxy = null
let cachedWinProxyAt = 0

/**
 * Detect Windows system proxy from HKCU Internet Settings when HTTP_PROXY / HTTPS_PROXY
 * are not explicitly set in process.env, ensuring the Go-based `agy` binary can reach
 * Google OAuth (`googleapis.com/oauth2/v2/userinfo`) and model endpoints reliably.
 */
function detectWindowsSystemProxy() {
  if (process.platform !== 'win32') return undefined
  const now = Date.now()
  if (now - cachedWinProxyAt < 30_000) {
    return cachedWinProxy || undefined
  }
  cachedWinProxyAt = now
  try {
    const out = execFileSync(
      'reg.exe',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', windowsHide: true, timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const enableMatch = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i.exec(out)
    const serverMatch = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(out)
    const enabled = enableMatch ? Number.parseInt(enableMatch[1], 16) !== 0 : false
    const rawServer = serverMatch ? serverMatch[1].trim() : ''
    if (enabled && rawServer) {
      let proxyUrl = rawServer
      if (proxyUrl.includes('=')) {
        const httpsPart = proxyUrl.split(';').find(p => p.startsWith('https=')) || proxyUrl.split(';')[0]
        proxyUrl = httpsPart.split('=')[1] || rawServer
      }
      if (!/^https?:\/\//i.test(proxyUrl) && !/^socks/i.test(proxyUrl)) {
        proxyUrl = `http://${proxyUrl}`
      }
      cachedWinProxy = proxyUrl
      return proxyUrl
    }
  } catch {
    // Ignore registry query errors.
  }
  cachedWinProxy = ''
  return undefined
}

function buildAgySpawnEnv(configuredProxy) {
  const env = { ...process.env }
  const existingProxy =
    configuredProxy ||
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    env.ALL_PROXY ||
    env.all_proxy
  const proxyUrl = existingProxy || detectWindowsSystemProxy()
  if (proxyUrl) {
    env.HTTP_PROXY = env.HTTP_PROXY || proxyUrl
    env.HTTPS_PROXY = env.HTTPS_PROXY || proxyUrl
    env.http_proxy = env.http_proxy || proxyUrl
    env.https_proxy = env.https_proxy || proxyUrl
    env.NO_PROXY = env.NO_PROXY || '127.0.0.1,localhost'
  }
  return env
}

const EMPTY_CWD = join(tmpdir(), 'dsh-agy-llm-empty')

function sanitizeAgyLeakage(rawText) {
  if (typeof rawText !== 'string' || !rawText) return ''
  let s = rawText
  // If agy leaked internal CDATA thought delimiters (`]]>`), strip everything up to the last `]]>`
  if (s.includes(']]>')) {
    const lastCdataClose = s.lastIndexOf(']]>')
    s = s.slice(lastCdataClose + 3)
  }
  // Strip self-talk lines referencing <dsh_tool_call> tags in prose
  s = s.replace(/^[^\n]*<dsh_tool_call>[^\n{]*$/gm, '')
  // Strip stray partial `<dsh` or `<dsh_` artifacts from earlier turns
  s = s.replace(/^\s*<dsh_[a-z_]*\s*$/gm, '').replace(/^\s*<dsh\s*$/gm, '')
  return s.trim()
}

async function formatContent(content, stageImageFn, role = 'user') {
  if (typeof content === 'string') {
    return role === 'assistant' ? sanitizeAgyLeakage(content) : content
  }
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = role === 'assistant'
        ? extractToolCalls(block.text).cleanText
        : block.text
      if (text.trim()) {
        parts.push(text)
      }
    } else if (block.type === 'image' && block.attachment && typeof stageImageFn === 'function') {
      const stagedPath = await stageImageFn(block.attachment)
      if (stagedPath) {
        parts.push(
          `[ATTACHED_IMAGE: ${stagedPath} — Call your built-in read_file tool with {"Path": ${JSON.stringify(stagedPath)}} to view this image visually before responding]`,
        )
      }
    } else if (block.type === 'tool-call') {
      parts.push(`<dsh_tool_call>{"name":${JSON.stringify(block.name)},"arguments":${block.arguments}}</dsh_tool_call>`)
    }
  }
  return parts.join('\n')
}

async function buildPrompt(options, stageImageFn) {
  const sections = []

  sections.push(
    '# DeepSeek Harness LLM Bridge Instructions',
    'You are acting as the underlying LLM engine for DeepSeek Harness (dsh).',
    'IMPORTANT: Do NOT invoke your own built-in Antigravity CLI tools (such as run_command, write_file, edit_file, etc.) for workspace operations, EXCEPT that when a message contains `[ATTACHED_IMAGE: <path>]`, you MUST call your built-in `read_file` tool on that exact `<path>` to inspect the image visually before responding.',
    'For all other dsh workspace operations, output ONLY one or more XML blocks in the exact format (with no commentary before or after):',
    '<dsh_tool_call>{"name": "tool_name", "arguments": {...}}</dsh_tool_call>',
    'When you emit a <dsh_tool_call> block, output nothing else in that turn so dsh can execute the tool and return <dsh_tool_result>.',
  )

  const rawSystem = options.system ?? options.systemPrompt
  if (rawSystem) {
    const sys = typeof rawSystem === 'string'
      ? rawSystem
      : Array.isArray(rawSystem) ? rawSystem.join('\n\n') : ''
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
  for (const msg of options.messages || []) {
    if (msg.role === 'system') {
      transcript.push(`[SYSTEM]\n${await formatContent(msg.content, stageImageFn, 'system')}`)
    } else if (msg.role === 'developer') {
      const devText = await formatContent(msg.content, stageImageFn, 'developer')
      if (devText.trim()) transcript.push(`[DEVELOPER]\n${devText}`)
    } else if (msg.role === 'user') {
      transcript.push(`[USER]\n${await formatContent(msg.content, stageImageFn, 'user')}`)
    } else if (msg.role === 'assistant') {
      const asstText = await formatContent(msg.content, stageImageFn, 'assistant')
      if (asstText.trim()) transcript.push(`[ASSISTANT]\n${asstText}`)
    } else if (msg.role === 'tool') {
      const text = await formatContent(msg.content, stageImageFn, 'tool')
      transcript.push(
        `[TOOL RESULT (toolCallId=${msg.toolCallId}${msg.isError ? ', error=true' : ''})]\n<dsh_tool_result>\n${text}\n</dsh_tool_result>`,
      )
    }
  }

  sections.push(`# Conversation History\n${transcript.join('\n\n')}`)
  return sections.join('\n\n')
}

function extractToolCalls(rawText) {
  const toolCalls = []
  // Match <dsh_tool_call>{...}</dsh_tool_call> where the body starts with `{` and doesn't cross another <dsh_tool_call>
  const regex = /<dsh_tool_call>\s*(\{(?:(?!<dsh_tool_call>)[\s\S])*?\})\s*<\/dsh_tool_call>/g
  let stripped = ''
  let lastIndex = 0
  let match

  while ((match = regex.exec(rawText)) !== null) {
    stripped += rawText.slice(lastIndex, match.index)
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
      // Ignore malformed tool call JSON rather than dumping raw XML into user-visible text
    }
  }
  stripped += rawText.slice(lastIndex)
  let cleanText = sanitizeAgyLeakage(stripped)
  // If this turn is invoking tools and the remaining text had leaked CDATA `]]>` or `<dsh_tool_call`, suppress the leaked pre-tool monologue
  if (toolCalls.length > 0 && (rawText.includes(']]>') || stripped.includes('<dsh_tool_call'))) {
    cleanText = ''
  }
  return { cleanText, toolCalls }
}

function computeSafeStreamablePrefix(fullResponse) {
  if (!fullResponse) return ''
  // Never stream if CDATA thought leakage `]]>` or `<dsh_tool_call` is present
  if (fullResponse.includes(']]>') || fullResponse.includes('<dsh_tool_call')) {
    const idx = fullResponse.indexOf('<dsh_tool_call')
    const before = idx >= 0 ? fullResponse.slice(0, idx) : ''
    return sanitizeAgyLeakage(before)
  }
  const trimmedStart = fullResponse.trimStart()
  // If response starts with `<`, hold back until we know it's not `<dsh_tool_call>`
  if (trimmedStart.startsWith('<')) {
    if ('<dsh_tool_call>'.startsWith(trimmedStart) || trimmedStart.startsWith('<dsh')) {
      return ''
    }
  }
  // Hold back any trailing `<` suffix at the end of fullResponse that could be the start of `<dsh_tool_call>`
  const lastLt = fullResponse.lastIndexOf('<')
  if (lastLt >= 0 && fullResponse.length - lastLt <= 16) {
    const tail = fullResponse.slice(lastLt)
    if ('<dsh_tool_call>'.startsWith(tail)) {
      return fullResponse.slice(0, lastLt)
    }
  }
  // Also hold back the very first 48 ASCII chars if they look like an English thought header before `]]>`
  if (fullResponse.length < 64 && /^[A-Za-z0-9_\s,\].:-]+$/.test(fullResponse)) {
    return ''
  }
  return fullResponse
}

function isRetryableAgyError(stderrText) {
  const t = (stderrText || '').toLowerCase()
  return (
    t.includes('eof') ||
    t.includes('eligibility check failed') ||
    t.includes('googleapis.com') ||
    t.includes('timeout') ||
    t.includes('connection reset') ||
    t.includes('forcibly closed') ||
    t.includes('tls handshake') ||
    t.includes('unavailable') ||
    t.includes('rate limit') ||
    t.includes('429') ||
    t.includes('502') ||
    t.includes('503')
  )
}

function delayMs(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    }
  })
}

class AgyLlmAdapter {
  constructor(ctx, agyBin, provider, proxyUrl) {
    this.ctx = ctx
    this.agyBin = agyBin
    this.provider = provider
    this.proxyUrl = proxyUrl
    this.cachedModels = null
  }

  async stageImageAttachment(attachment, signal) {
    try {
      const attachmentsSvc = this.ctx?.get?.('attachments') ?? this.ctx?.attachments
      if (!attachmentsSvc || !attachment) return null
      const ext = attachment.mediaType === 'image/png' ? 'png'
        : attachment.mediaType === 'image/webp' ? 'webp'
        : attachment.mediaType === 'image/gif' ? 'gif'
        : 'jpg'
      const safeId = String(attachment.attachmentId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)
      const destPath = join(EMPTY_CWD, `img-${safeId}.${ext}`)
      if (existsSync(destPath)) return destPath

      if (typeof attachmentsSvc.imageHostPath === 'function') {
        const hostPath = attachmentsSvc.imageHostPath(attachment)
        if (hostPath && existsSync(hostPath)) {
          copyFileSync(hostPath, destPath)
          return destPath
        }
      }
      if (typeof attachmentsSvc.readImage === 'function') {
        const stored = await attachmentsSvc.readImage(attachment, signal)
        if (stored?.data) {
          writeFileSync(destPath, stored.data)
          return destPath
        }
      }
    } catch {
      // Fall through if image staging fails
    }
    return null
  }

  providerInfo(provider) {
    return {
      id: provider,
      name: 'Google Antigravity (agy)',
    }
  }

  providerRetryPolicy(_provider) {
    return undefined
  }

  imageRequestPricing(_provider, _model) {
    return undefined
  }

  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  async discoverModels(signal) {
    if (this.cachedModels) return this.cachedModels
    return await new Promise((resolve) => {
      const child = spawn(this.agyBin, ['models'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        env: buildAgySpawnEnv(this.proxyUrl),
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
          if (id) parsed.push({ id: id.trim(), name: (displayName ?? id).trim() })
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

  async listModels(provider) {
    const models = await this.discoverModels()
    return models.map(m => ({
      provider: provider || this.provider,
      id: m.id,
      name: m.name,
      inputModalities: ['text', 'image'],
    }))
  }

  async resolveModel(provider, model, signal) {
    const models = await this.discoverModels(signal)
    const found = models.find(m => m.id === model)
    return {
      provider: provider || this.provider,
      id: model,
      name: found?.name ?? model,
      inputModalities: ['text', 'image'],
      context: { contextWindow: 200_000 },
      defaultMaxTokens: 32_768,
    }
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  async *stream(options) {
    mkdirSync(EMPTY_CWD, { recursive: true })
    const prompt = await buildPrompt(options, att => this.stageImageAttachment(att, options.signal))
    const args = [
      '--output-format',
      'stream-json',
      '--disable-slash-commands',
      '--model',
      options.model,
    ]

    const maxAttempts = 3
    let lastError = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (options.signal?.aborted) {
        break
      }

      const child = spawn(this.agyBin, args, {
        cwd: EMPTY_CWD,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: buildAgySpawnEnv(this.proxyUrl),
      })

      const onAbort = () => {
        try { child.kill() } catch {}
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      child.stdin.on('error', () => {})
      try {
        child.stdin.write(prompt, 'utf8')
        child.stdin.end()
      } catch {
        // Ignore early stdin close if agy exits immediately.
      }

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
              const safePrefix = computeSafeStreamablePrefix(fullResponse)
              if (safePrefix.length > streamedText.length && safePrefix.startsWith(streamedText)) {
                const newDelta = safePrefix.slice(streamedText.length)
                if (newDelta.length > 0) {
                  if (!textBlockStarted) {
                    textBlockStarted = true
                    yield { type: 'block-start', index: 0, blockType: 'text' }
                  }
                  streamedText = safePrefix
                  yield { type: 'text-delta', index: 0, text: newDelta }
                }
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
          lastError = err
          if (!textBlockStarted && attempt < maxAttempts && isRetryableAgyError(stderrText) && !options.signal?.aborted) {
            await delayMs(attempt * 500, options.signal)
            continue
          }
          throw err
        }

        const { cleanText, toolCalls } = extractToolCalls(fullResponse)
        let nextIndex = 0

        if (textBlockStarted) {
          if (cleanText.length > streamedText.length && cleanText.startsWith(streamedText)) {
            const remainingDelta = cleanText.slice(streamedText.length)
            if (remainingDelta.length > 0) {
              yield { type: 'text-delta', index: 0, text: remainingDelta }
            }
          }
          yield {
            type: 'block-end',
            index: 0,
            block: { type: 'text', text: cleanText },
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
        return
      } finally {
        options.signal?.removeEventListener('abort', onAbort)
        rl.close()
      }
    }

    if (lastError) {
      throw lastError
    }
  }
}

export const name = 'llm-agy'
export const inject = ['llm']

export function apply(ctx, config = {}) {
  const agyBin = config.agyBin || resolveDefaultAgyBin()
  const provider = config.provider || 'agy'
  const proxyUrl = config.proxyUrl || config.proxy || undefined
  const adapter = new AgyLlmAdapter(ctx, agyBin, provider, proxyUrl)
  ctx.effect(() => ctx.llm.registerAdapter([provider], adapter))
}
