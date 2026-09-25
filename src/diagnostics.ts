/**
 * Every failure is reported, never swallowed: stages push a Diagnostic that
 * says what was attempted and why it failed. The CLI prints them all.
 */
export type Stage = 'input' | 'parse' | 'lockfile' | 'resolve' | 'search' | 'trace' | 'release' | 'auth' | 'net';

export interface Diagnostic {
  level: 'info' | 'warn' | 'error';
  stage: Stage;
  message: string;
  /** Paths / URLs / strategies that were tried. */
  tried?: string[];
}

export class Diagnostics {
  readonly items: Diagnostic[] = [];
  info(stage: Stage, message: string, tried?: string[]) {
    this.items.push({ level: 'info', stage, message, ...(tried?.length ? { tried } : {}) });
  }
  warn(stage: Stage, message: string, tried?: string[]) {
    this.items.push({ level: 'warn', stage, message, ...(tried?.length ? { tried } : {}) });
  }
  error(stage: Stage, message: string, tried?: string[]) {
    this.items.push({ level: 'error', stage, message, ...(tried?.length ? { tried } : {}) });
  }
}
