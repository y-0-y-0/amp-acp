import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileThreadMappingStore } from './thread-mapping-store.js';

const sessionId = 'S-mabc123-abcdef';
const threadId = 'T-01a03c00-e608-7007-8181-5c1cc56757be';

describe('FileThreadMappingStore', () => {
  let stateDir: string;

  beforeEach(async () => {
    setSystemTime(new Date('2026-04-12T13:14:15.000Z'));
    stateDir = await mkdtemp(path.join(os.tmpdir(), 'amp-acp-state-'));
  });

  afterEach(async () => {
    setSystemTime();
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
    await store.save({ sessionId, threadId, updatedAt: '2020-01-01T00:00:00.000Z' });
    const mapping = await store.load(sessionId);
    expect(mapping?.updatedAt).toBe('2026-04-12T13:14:15.000Z');
    setSystemTime(new Date('2026-04-13T13:14:15.000Z'));
    await store.save({ sessionId, threadId });
    expect((await store.load(sessionId))?.updatedAt).toBe('2026-04-13T13:14:15.000Z');
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

  it('rejects impossible calendar dates instead of normalizing them into another day', async () => {
    await mkdir(path.join(stateDir, 'sessions'));
    const store = new FileThreadMappingStore(stateDir);
    for (const updatedAt of ['2026-02-30T01:02:03Z', '2025-02-29T01:02:03+02:00', '2026-04-31T01:02:03Z']) {
      await writeFile(path.join(stateDir, 'sessions', `${sessionId}.json`), JSON.stringify({ sessionId, threadId, updatedAt }));
      await expect(store.load(sessionId)).rejects.toThrow('Invalid persisted mapping');
      expect(await store.list()).toEqual([]);
    }
    await writeFile(path.join(stateDir, 'sessions', `${sessionId}.json`), JSON.stringify({
      sessionId, threadId, updatedAt: '2024-02-29T01:02:03+02:00',
    }));
    expect((await store.load(sessionId))?.updatedAt).toBe('2024-02-28T23:02:03.000Z');
  });

  it('propagates a global directory failure and ignores temporary or corrupt individual files', async () => {
    const store = new FileThreadMappingStore(stateDir);
    await writeFile(path.join(stateDir, 'sessions'), 'not a directory');
    await expect(store.list()).rejects.toThrow();
    await rm(path.join(stateDir, 'sessions'));
    await store.save({ sessionId, threadId });
    await writeFile(path.join(stateDir, 'sessions', `${sessionId}.json.123.tmp`), 'unfinished');
    await writeFile(path.join(stateDir, 'sessions', 'S-corrupt-abcdef.json'), '{');
    await writeFile(path.join(stateDir, 'sessions', 'invalid-id.json'), '{}');
    expect((await store.list()).map((mapping) => mapping.sessionId)).toEqual([sessionId]);
  });

  it('propagates filesystem read failures after successful directory enumeration', async () => {
    await new FileThreadMappingStore(stateDir).save({ sessionId, threadId });
    for (const code of ['EACCES', 'EIO', 'EMFILE']) {
      class UnreadableStore extends FileThreadMappingStore {
        override async load(): Promise<never> {
          throw Object.assign(new Error(`fixture read failure: ${code}`), { code });
        }
      }
      await expect(new UnreadableStore(stateDir).list()).rejects.toThrow(`fixture read failure: ${code}`);
    }
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
