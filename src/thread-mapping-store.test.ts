import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileThreadMappingStore } from './thread-mapping-store.js';

const sessionId = 'S-mabc123-abcdef';
const threadId = 'T-01a03c00-e608-7007-8181-5c1cc56757be';

describe('FileThreadMappingStore', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), 'amp-acp-state-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('retains the exact ACP-to-Amp mapping across store restarts', async () => {
    const firstProcess = new FileThreadMappingStore(stateDir);
    await firstProcess.save({ sessionId, threadId });

    const restartedProcess = new FileThreadMappingStore(stateDir);
    expect(await restartedProcess.load(sessionId)).toEqual({
      sessionId,
      threadId,
      updatedAt: expect.any(String),
    });
  });

  it('returns null for a legacy session with no persisted mapping', async () => {
    const store = new FileThreadMappingStore(stateDir);

    expect(await store.load('S-legacy-abcdef')).toBeNull();
  });

  it('round-trips persisted session settings alongside the thread mapping', async () => {
    const store = new FileThreadMappingStore(stateDir);
    await store.save({ sessionId, threadId, mode: 'bypass', model: 'high', executor: 'orb', cwd: '/tmp/project' });

    expect(await new FileThreadMappingStore(stateDir).load(sessionId)).toEqual({
      sessionId,
      threadId,
      mode: 'bypass',
      model: 'high',
      executor: 'orb',
      cwd: '/tmp/project',
      updatedAt: expect.any(String),
    });
  });

  it('loads mappings written before settings were persisted', async () => {
    await mkdir(path.join(stateDir, 'sessions'));
    await writeFile(path.join(stateDir, 'sessions', `${sessionId}.json`), JSON.stringify({ sessionId, threadId }));

    const loaded = await new FileThreadMappingStore(stateDir).load(sessionId);
    expect(loaded).toEqual({ sessionId, threadId });
    expect(loaded?.mode).toBeUndefined();
  });

  it('lists an empty state directory and stamps each atomic save with current activity', async () => {
    const store = new FileThreadMappingStore(stateDir);
    expect(await store.list()).toEqual([]);
    const before = Date.now();
    await store.save({ sessionId, threadId, updatedAt: '2020-01-01T00:00:00.000Z' });
    const mapping = await store.load(sessionId);
    expect(Date.parse(mapping!.updatedAt!)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(mapping!.updatedAt!)).toBeLessThanOrEqual(Date.now());
    if (process.platform !== 'win32') {
      expect((await stat(path.join(stateDir, 'sessions'))).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(stateDir, 'sessions', `${sessionId}.json`))).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects settings fields with the wrong type', async () => {
    const store = new FileThreadMappingStore(stateDir);
    await store.save({ sessionId, threadId });
    const mappingPath = path.join(stateDir, 'sessions', `${sessionId}.json`);
    await writeFile(mappingPath, JSON.stringify({ sessionId, threadId, mode: 42 }));

    await expect(store.load(sessionId)).rejects.toThrow('Invalid persisted mapping');
  });

  it('rejects invalid session and thread IDs instead of creating unsafe paths or mappings', async () => {
    const store = new FileThreadMappingStore(stateDir);

    await expect(store.save({
      sessionId: '../other-session',
      threadId,
    })).rejects.toThrow('Invalid ACP session ID');
    await expect(store.save({
      sessionId,
      threadId: 'T-not-a-thread',
    })).rejects.toThrow('Invalid Amp thread ID');
    await expect(store.load('../other-session')).rejects.toThrow('Invalid ACP session ID');
  });
});
