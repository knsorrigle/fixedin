import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bareSpecifierToPackage,
  cleanQuery,
  extractErrorCodes,
  parseError,
  viteDepToPackage,
} from '../src/parse/index.js';

const stack = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures/stacks', `${name}.txt`), 'utf8');
const names = (name: string) => parseError(stack(name)).packages.map((p) => p.name);

describe('parseError on real-world traces', () => {
  it('axios: headers TypeError', () => {
    const p = parseError(stack('axios-headers'));
    expect(p.query).toBe("TypeError: Cannot read properties of undefined (reading 'headers')");
    expect(p.packages).toEqual([expect.objectContaining({ name: 'axios', hits: 3, source: 'stack-frame' })]);
    expect(p.errorCodes).toEqual([]);
  });

  it('axios: ECONNREFUSED with file:// frames and a nested dependency', () => {
    const p = parseError(stack('axios-econnrefused'));
    expect(p.query).toBe('AxiosError: connect ECONNREFUSED');
    expect(p.errorCodes).toEqual(['ECONNREFUSED']);
    expect(names('axios-econnrefused')).toEqual(['axios', 'follow-redirects']);
  });

  it('react: webpack-internal:// frames, hashed bundle names stripped', () => {
    const p = parseError(stack('react-invalid-hook'));
    expect(p.query).toBe("TypeError: Cannot read properties of null (reading 'useState')");
    expect(names('react-invalid-hook')).toEqual(['react-dom']);
  });

  it('react under vite: maps .vite/deps files back to packages and skips chunks', () => {
    expect(names('react-vite-deps')).toEqual(['react-dom', '@tanstack/react-query']);
    expect(parseError(stack('react-vite-deps')).packages[0]!.source).toBe('vite-deps');
  });

  it('next: server error with a [cause] and a decorated first line', () => {
    const p = parseError(stack('next-server'));
    expect(p.query).toBe('TypeError: fetch failed');
    expect(p.errorCodes).toEqual(['ENOTFOUND']);
    expect(names('next-server')).toEqual(['next']);
  });

  it('next: module-not-found build error skips "Failed to compile." and code excerpts', () => {
    const p = parseError(stack('next-module-not-found'));
    expect(p.query).toBe("Module not found: Can't resolve '@vercel/analytics/react'");
    expect(p.packages).toEqual([expect.objectContaining({ name: '@vercel/analytics', source: 'module-not-found' })]);
  });

  it('prisma: empty header line gets the real message appended; P-codes extracted', () => {
    const p = parseError(stack('prisma-p2002'));
    expect(p.query).toBe('PrismaClientKnownRequestError: Unique constraint failed on the fields: (`email`)');
    expect(p.errorCodes).toEqual(['P2002']);
    expect(names('prisma-p2002')).toEqual(['@prisma/client']);
  });

  it('webpack: windows paths, scoped packages, code: MODULE_NOT_FOUND', () => {
    const p = parseError(stack('webpack-loader'));
    expect(p.query).toBe("Error: Cannot find module '@babel/preset-env'");
    expect(p.errorCodes).toEqual(['MODULE_NOT_FOUND']);
    expect(names('webpack-loader')).toEqual(['babel-loader', '@babel/preset-env', '@babel/core']);
  });

  it('vite: ERR_REQUIRE_ESM keeps require() and drops paths', () => {
    const p = parseError(stack('vite-esm'));
    expect(p.query).toBe('Error [ERR_REQUIRE_ESM]: require() of ES Module not supported.');
    expect(p.errorCodes).toEqual(['ERR_REQUIRE_ESM']);
    expect(names('vite-esm')).toEqual(['@vitejs/plugin-react', 'vite']);
  });

  it('jest: skips runner decoration and ranks jest internals last', () => {
    const p = parseError(stack('jest-suite'));
    expect(p.query).toBe('SyntaxError: Cannot use import statement outside a module');
    expect(names('jest-suite')).toEqual(['nanoid', 'jest-runtime', '@jest/core']);
    expect(p.packages.filter((x) => x.lowSignal).map((x) => x.name)).toEqual(['jest-runtime', '@jest/core']);
  });

  it('pnpm: uses the innermost node_modules segment, not .pnpm store names', () => {
    const p = parseError(stack('pnpm-nested'));
    expect(p.errorCodes).toEqual(['ERR_INVALID_ARG_TYPE']);
    expect(names('pnpm-nested')).toEqual(['find-cache-dir', 'babel-loader']);
  });

  it('single-line input works', () => {
    const p = parseError("TypeError: Cannot read properties of undefined (reading 'headers')");
    expect(p.query).toBe("TypeError: Cannot read properties of undefined (reading 'headers')");
    expect(p.packages).toEqual([]);
  });

  it('strips ANSI colour codes', () => {
    expect(parseError('\u001b[31mTypeError: boom\u001b[39m').query).toBe('TypeError: boom');
  });
});

describe('cleanQuery', () => {
  it.each([
    ['Error: ENOENT: no such file, open /Users/me/app/.env', 'Error: ENOENT: no such file, open'],
    ["Error: Cannot find 'C:\\Users\\me\\app\\x.js'", 'Error: Cannot find'],
    ['Error loading file:///home/u/app/index.js:10:5 failed', 'Error loading failed'],
    ['Segfault at 0x7ffee4b8a0c0 in worker', 'Segfault at in worker'],
    ['Request 3f2504e0-4f89-11d3-9a0c-0305e82c3301 timed out', 'Request timed out'],
    ['Unexpected token (12:4)', 'Unexpected token'],
    ['Parse error on line 12, column 4: bad', 'Parse error on : bad'],
    ['connect ECONNREFUSED 127.0.0.1:5432', 'connect ECONNREFUSED'],
    ['chunk a1b2c3d4e5f6a7b8 failed', 'chunk failed'],
    ['require() of ES Module', 'require() of ES Module'],
    ['Error: connect ECONNREFUSED at /srv/app/node_modules/pg/lib/client.js:132:7', 'Error: connect ECONNREFUSED'],
    ['TypeError: x is not a function at Object.run (/srv/a.js:1:2)', 'TypeError: x is not a function'],
    ['Error: look at this', 'Error: look at this'],
  ])('%s', (input, expected) => {
    expect(cleanQuery(input)).toBe(expected);
  });
});

describe('extractErrorCodes', () => {
  it('ignores words that merely start with E', () => {
    expect(extractErrorCodes('ERROR: ESLint failed to load ESM config')).toEqual([]);
  });
  it('finds ERR_*, errno codes and code: fields once each', () => {
    expect(extractErrorCodes("ERR_OSSL_EVP_UNSUPPORTED EACCES EACCES code: 'UND_ERR_CONNECT_TIMEOUT'")).toEqual([
      'ERR_OSSL_EVP_UNSUPPORTED',
      'EACCES',
      'UND_ERR_CONNECT_TIMEOUT',
    ]);
  });
  it('only reads Prisma codes when Prisma is mentioned', () => {
    expect(extractErrorCodes('build P2002 failed')).toEqual([]);
  });
});

describe('specifier helpers', () => {
  it.each([
    ['lodash/fp', 'lodash'],
    ['@scope/pkg/sub/path', '@scope/pkg'],
    ['./local', undefined],
    ['node:fs', undefined],
    ['@/components/Button', undefined],
  ])('bareSpecifierToPackage(%s)', (spec, expected) => {
    expect(bareSpecifierToPackage(spec)).toBe(expected);
  });

  it.each([
    ['react-dom_client', 'react-dom'],
    ['@tanstack_react-query', '@tanstack/react-query'],
    ['chunk-RLJ2RCJQ', undefined],
    ['lodash-es', 'lodash-es'],
  ])('viteDepToPackage(%s)', (file, expected) => {
    expect(viteDepToPackage(file)).toBe(expected);
  });
});
