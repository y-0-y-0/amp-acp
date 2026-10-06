import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getTerminalAuthCommand, isAuthError } from './server.js';

describe('isAuthError', () => {
  it('detects missing API key login flow errors', () => {
    expect(isAuthError('No API key found. Starting login flow...')).toBe(true);
    expect(isAuthError('Failed to parse JSON response, raw line: No API key found. Starting login flow...')).toBe(true);
  });

  it('does not misclassify unrelated parse errors', () => {
    expect(isAuthError('Failed to parse JSON response, raw line: Unexpected token')).toBe(false);
  });
});

describe('getTerminalAuthCommand', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'amp-acp-auth-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uses execPath when argv1 is bunfs virtual path', () => {
    expect(getTerminalAuthCommand('/$bunfs/root/amp-acp', process.execPath)).toEqual({
      command: process.execPath, args: ['--setup'],
    });
  });

  it('launches existing JS, MJS and CJS scripts through their interpreter', async () => {
    for (const extension of ['js', 'mjs', 'cjs']) {
      const script = path.join(dir, `agent.${extension}`);
      await writeFile(script, '');
      const invocation = getTerminalAuthCommand(script, process.execPath);
      expect(invocation).toEqual({ command: process.execPath, args: [script, '--setup'] });
      expect(existsSync(invocation!.command)).toBe(true);
      expect(getTerminalAuthCommand(script, path.join(dir, 'missing-runtime'))).toBeUndefined();
    }
  });

  it('resolves an extensionless npx symlink to the actual script', async () => {
    const script = path.join(dir, 'index.js');
    const shim = path.join(dir, 'amp-acp');
    await writeFile(script, '');
    await symlink(script, shim);
    expect(getTerminalAuthCommand(shim, process.execPath)).toEqual({ command: process.execPath, args: [script, '--setup'] });
  });

  it('handles absent argv1 and a compiled executable', () => {
    expect(getTerminalAuthCommand(undefined, process.execPath)).toEqual({ command: process.execPath, args: ['--setup'] });
    const binary = process.execPath;
    expect(getTerminalAuthCommand(binary, process.execPath)).toEqual({ command: binary, args: ['--setup'] });
  });

  it('rejects virtual Windows Bun argv paths before resolving them on the host', () => {
    for (const argv1 of ['B:\\~BUN\\root\\amp-acp.exe', 'B:/~BUN/root/amp-acp.exe', 'B:/%7EBUN/root/amp-acp.exe', 'B:%5C%7EBUN%5Croot%5Camp-acp.exe']) {
      expect(getTerminalAuthCommand(argv1, process.execPath)).toEqual({ command: process.execPath, args: ['--setup'] });
    }
  });

  it('omits an unresolved invocation rather than advertising a broken button', () => {
    const missing = path.join(process.cwd(), 'nonexistent-auth-binary');
    expect(getTerminalAuthCommand(missing, process.execPath)).toBeUndefined();
    expect(getTerminalAuthCommand('/$bunfs/root/amp-acp', missing)).toBeUndefined();
    expect(getTerminalAuthCommand('/$bunfs/root/amp-acp', 'B:/%7EBUN/root/amp-acp.exe')).toBeUndefined();
  });
});
