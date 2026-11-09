import { abortError, runClaude } from './claude-runner.ts';
import type { Config } from './config.ts';

/**
 * Runs classification against a local model through an OpenAI-compatible endpoint
 * (Ollama, LM Studio, llama.cpp server, vLLM…), so work logs never leave the machine/network.
 */

export const DEFAULT_LOCAL_ENDPOINT = 'http://localhost:11434/v1';
export const DEFAULT_LOCAL_MODEL = 'qwen3:8b';

const SYSTEM_PROMPT = "You classify a person's work log. Follow the instructions in the message exactly and reply with JSON only.";

/** Loopback or private-network host: the endpoint keeps data in-house. */
export function isPrivateHost(endpoint: string): boolean {
  let host: string;
  try {
    host = new URL(endpoint).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')) return true;
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  const m = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

export interface LocalRunOptions {
  endpoint: string;
  model: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
}

export async function runLocal(prompt: string, opts: LocalRunOptions): Promise<string> {
  if (opts.signal?.aborted) throw abortError();
  const url = `${opts.endpoint.replace(/\/+$/, '')}/chat/completions`;
  const timeout = AbortSignal.timeout(opts.timeoutSeconds * 1000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        stream: false,
      }),
      signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw abortError();
    if (timeout.aborted) throw new Error(`local model timed out after ${opts.timeoutSeconds}s`);
    throw new Error(`could not reach local model at ${url}: ${(e as Error).message} (is Ollama running? \`ollama serve\`)`);
  }
  const body = await res.text();
  if (!res.ok) {
    const hint = res.status === 404 && /model/i.test(body) ? ` (pull it first: \`ollama pull ${opts.model}\`)` : '';
    throw new Error(`local model returned HTTP ${res.status}: ${body.slice(0, 300)}${hint}`);
  }
  let content: unknown;
  try {
    content = JSON.parse(body)?.choices?.[0]?.message?.content;
  } catch {
    throw new Error(`unexpected reply from ${url}: ${body.slice(0, 200)}`);
  }
  if (typeof content !== 'string' || !content.trim()) throw new Error('local model returned an empty answer');
  // Reasoning models (qwen3, deepseek-r1) may prepend a <think> block
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** One classifier call with whichever provider the config selects. */
export function runClassifier(prompt: string, c: Config['classifier'], opts: { cwd: string; timeoutSeconds?: number; signal?: AbortSignal }): Promise<string> {
  const timeoutSeconds = opts.timeoutSeconds ?? c.timeoutSeconds;
  if (c.provider === 'local') return runLocal(prompt, { endpoint: c.endpoint || DEFAULT_LOCAL_ENDPOINT, model: c.model, timeoutSeconds, signal: opts.signal });
  return runClaude(prompt, { command: c.command, model: c.model, cwd: opts.cwd, timeoutSeconds, signal: opts.signal });
}
