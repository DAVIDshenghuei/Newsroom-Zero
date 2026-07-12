import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ANTHROPIC_ANALYSIS_SYSTEM_PROMPT, LlmAnalysisSchema, buildAnalysisPrompt, type AnalysisGenerator, type AnalysisInput, type LlmAnalysis } from './analysis.js';

export const DEFAULT_CODEX_ANALYSIS_MODEL = 'gpt-5.6-sol';

type CodexRunner = (prompt: string) => Promise<string>;

export interface CodexAnalysisGeneratorOptions {
  model?: string;
  entrypoint?: string;
  cwd?: string;
  timeoutMs?: number;
  run?: CodexRunner;
}

const stripFence = (value: string): string => {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (match?.[1] ?? trimmed).trim();
};

function defaultEntrypoint(): string {
  if (process.env.CODEX_CLI_ENTRYPOINT) return process.env.CODEX_CLI_ENTRYPOINT;
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  }
  return '/usr/local/lib/node_modules/@openai/codex/bin/codex.js';
}

function runCodex(options: Required<Pick<CodexAnalysisGeneratorOptions, 'model' | 'entrypoint' | 'cwd' | 'timeoutMs'>>, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      options.entrypoint, 'exec', '--json', '--ephemeral', '--sandbox', 'read-only',
      '--skip-git-repo-check', '--ignore-rules', '--model', options.model, '--cd', options.cwd, '-',
    ], { cwd: options.cwd, env: process.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Codex analysis timed out')); }, options.timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Codex analysis process failed')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Codex analysis process failed with exit code ${code}`));
      let finalMessage = '';
      for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
        try {
          const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
          if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) finalMessage = event.item.text;
        } catch { /* ignore non-JSON diagnostics */ }
      }
      if (!finalMessage) return reject(new Error('Codex analysis returned no final message'));
      resolve(finalMessage);
    });
    child.stdin.end(prompt);
  });
}

export class CodexAnalysisGenerator implements AnalysisGenerator {
  private readonly run: CodexRunner;

  constructor(options: CodexAnalysisGeneratorOptions = {}) {
    const resolved = {
      model: options.model ?? DEFAULT_CODEX_ANALYSIS_MODEL,
      entrypoint: options.entrypoint ?? defaultEntrypoint(),
      cwd: options.cwd ?? process.cwd(),
      timeoutMs: options.timeoutMs ?? 300_000,
    };
    this.run = options.run ?? ((prompt) => runCodex(resolved, prompt));
  }

  async generate(input: AnalysisInput): Promise<LlmAnalysis> {
    const prompt = `${ANTHROPIC_ANALYSIS_SYSTEM_PROMPT}\n\n${buildAnalysisPrompt(input)}`;
    const response = await this.run(prompt);
    try {
      return LlmAnalysisSchema.parse(JSON.parse(stripFence(response)));
    } catch {
      throw new Error('Invalid Codex analysis response');
    }
  }
}
