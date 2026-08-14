/**
 * dsh-ocr-review: 本地 OpenCodeReview (ocr) 门禁插件。
 *
 * 工具：
 *  - ocr_review   对指定仓库的改动跑 AI 代码审查（--format json），返回结构化
 *                 findings；gate=true 时 findings>0 抛错（门禁模式，对齐
 *                 agent-core scripts/ocr-review.sh 的 OCR_GATE 语义）。
 *  - ocr_llm_test 验证 ocr 的 LLM 连通性（ocr llm test）。
 *
 * 实现：直接 execFile 托管 node + ocr.js（免 npx 联网、路径绝对化防 MSYS 坑）。
 * 路径可经环境变量覆盖：OCR_NODE_BIN / OCR_OCR_BIN / OCR_DEFAULT_EXCLUDE。
 * 默认走 ~/.opencodereview/config.json 的 provider（opencode-zen）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

export const name = 'dsh-ocr-review';
export const inject = ['tools'];

const execFileAsync = promisify(execFile);

const HOME = os.homedir();
const DEFAULTS = {
  nodeBin: path.join(HOME, '.workbuddy', 'binaries', 'node', 'versions', '22.22.2', 'node.exe'),
  ocrBin: path.join(HOME, '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', '@alibaba-group', 'open-code-review', 'bin', 'ocr.js'),
  exclude: '.github/**,.githooks/**,scripts/ocr-review.sh,**/__pycache__/**,**/*.bak,**/*.exe,**/*.csv,**/target/**',
};

function resolveBin() {
  return {
    nodeBin: process.env.OCR_NODE_BIN || DEFAULTS.nodeBin,
    ocrBin: process.env.OCR_OCR_BIN || DEFAULTS.ocrBin,
  };
}

/** execFile node ocr.js <args>，cwd=repo。返回 { stdout, stderr }。 */
async function runOcr(args, cwd, timeoutMs = 600_000) {
  const { nodeBin, ocrBin } = resolveBin();
  try {
    const { stdout, stderr } = await execFileAsync(nodeBin, [ocrBin, ...args], {
      cwd,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err) {
    return {
      stdout: err?.stdout ?? '',
      stderr: err?.stderr ?? '',
      error: err?.message ?? String(err),
    };
  }
}

export function apply(ctx) {
  const tool = (name, description, parameters, exec) => ctx.effect(() => ctx.tools.register(defineTool({
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    execute: exec,
  })), `dsh-ocr-review.${name}`);

  tool('ocr_review', '本地 AI 代码审查（OpenCodeReview，--format json）：对仓库工作区改动或 from/to（merge-base）范围或单 commit 跑审查，返回结构化 findings（path/line/message）与 token 统计；gate=true 时 findings>0 直接报错（门禁模式）。LLM 走 opencode-zen（~/.opencodereview/config.json）。', {
    repo: { type: 'string', description: '仓库工作目录（绝对路径）。默认当前工作目录' },
    from: { type: 'string', description: '基准 ref（merge-base 模式），如 origin/master；缺省=工作区未提交改动' },
    to: { type: 'string', description: '目标 ref，默认 HEAD（与 from 搭配）' },
    commit: { type: 'string', description: '审查单个 commit（与 from/to 互斥）' },
    exclude: { type: 'string', description: '排除 glob（逗号分隔）；缺省标准排除集（.github/.githooks/target 等）' },
    gate: { type: 'boolean', description: 'true=门禁模式：findings>0 抛错（对齐 OCR_GATE=1）' },
    provider: { type: 'string', description: '可选覆盖 provider（缺省用 config.json）' },
    model: { type: 'string', description: '可选覆盖 model' },
  }, async (args) => {
    const a = { ...args };
    const cwd = a.repo || process.cwd();
    const argv = ['review', '--format', 'json'];
    if (a.commit) {
      argv.push('--commit', String(a.commit));
    } else if (a.from) {
      argv.push('--from', String(a.from), '--to', String(a.to || 'HEAD'));
    }
    argv.push('--exclude', String(a.exclude || process.env.OCR_DEFAULT_EXCLUDE || DEFAULTS.exclude));
    if (a.provider) argv.push('--provider', String(a.provider));
    if (a.model) argv.push('--model', String(a.model));

    const { stdout, stderr, error } = await runOcr(argv, cwd);
    if (error && !stdout) {
      throw new Error(`ocr_review 运行失败: ${error}${stderr ? `\nstderr: ${stderr.slice(0, 500)}` : ''}`);
    }
    let parsed = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // 非 JSON（可能 --format json 未生效或进程被杀）→ 回退原文
    }
    if (!parsed) {
      throw new Error(`ocr_review 输出非 JSON（ocr 异常）: ${(stderr || stdout).slice(0, 800)}`);
    }
    const comments = Array.isArray(parsed.comments) ? parsed.comments : [];
    const summary = parsed.summary || {};
    const report = {
      status: parsed.status || 'unknown',
      message: parsed.message || null,
      session_id: parsed.session_id || null,
      summary,
      findings: comments.map((c) => ({
        path: c.path ?? c.filePath ?? null,
        line: c.line ?? c.start_line ?? null,
        severity: c.severity ?? c.level ?? null,
        category: c.category ?? null,
        message: String(c.content ?? c.message ?? c.body ?? '').slice(0, 2000),
      })),
    };
    if (a.gate && comments.length > 0) {
      throw new Error(`[ocr-gate] 发现 ${comments.length} 条评论，门禁拦截（OCR_GATE 语义）:\n${JSON.stringify(report.findings, null, 2).slice(0, 6000)}`);
    }
    return JSON.stringify(report, null, 2);
  });

  tool('ocr_llm_test', '验证本地 OpenCodeReview 的 LLM 连通性（ocr llm test），用于排查 provider/key 配置问题。', {
    repo: { type: 'string', description: '工作目录（默认当前目录）' },
  }, async (args) => {
    const a = { ...args };
    const cwd = a.repo || process.cwd();
    const { stdout, stderr, error } = await runOcr(['llm', 'test'], cwd, 120_000);
    if (error) return `ocr llm test 失败: ${error}\n${(stderr || '').slice(0, 500)}`;
    return (stdout || '(ok)').slice(0, 4000);
  });
}
