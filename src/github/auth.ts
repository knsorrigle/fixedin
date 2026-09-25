/**
 * GitHub token discovery: GITHUB_TOKEN (or GH_TOKEN) → `gh auth token` → none.
 */
import { execFile } from 'node:child_process';

export type TokenSource = 'GITHUB_TOKEN' | 'GH_TOKEN' | 'gh auth token' | 'none';

export interface AuthResult {
  token?: string;
  source: TokenSource;
  /** Why each earlier option was skipped. */
  tried: string[];
}

export type RunGh = () => Promise<string>;

const defaultRunGh: RunGh = () =>
  new Promise((resolve, reject) => {
    execFile('gh', ['auth', 'token'], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });

export async function resolveToken(env: NodeJS.ProcessEnv = process.env, runGh: RunGh = defaultRunGh): Promise<AuthResult> {
  const tried: string[] = [];
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN'] as const) {
    const v = env[name]?.trim();
    if (v) return { token: v, source: name, tried };
    tried.push(`${name}: not set`);
  }
  try {
    const token = await runGh();
    if (token) return { token, source: 'gh auth token', tried };
    tried.push('gh auth token: printed nothing (not logged in?)');
  } catch (err) {
    const msg = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gh CLI not installed' : (err as Error).message;
    tried.push(`gh auth token: ${msg}`);
  }
  return { source: 'none', tried };
}
