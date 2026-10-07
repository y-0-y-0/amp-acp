import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { RequestError, type AgentSideConnection } from '@agentclientprotocol/sdk';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AmpAcpAgent } from './server.js';
import { FileThreadMappingStore, type AmpThreadMapping } from './thread-mapping-store.js';
import type { AmpExecutionRequest, AmpStreamMessage, AmpTransport } from './amp-transport.js';

const threadId = 'T-01234567-89ab-cdef-0123-456789abcdef';
const client = { sessionUpdate: async () => {} } as unknown as AgentSideConnection;

describe('durable session listing', () => {
  let stateDir: string;
  let cwd: string;
  let requests: AmpExecutionRequest[];
  let failTurn: boolean;

  beforeEach(async () => {
    setSystemTime(new Date('2026-04-12T13:14:15.000Z'));
    stateDir = await mkdtemp(path.join(os.tmpdir(), 'amp-acp-list-'));
    cwd = path.join(stateDir, 'project');
    requests = [];
    failTurn = false;
    await mkdir(path.join(stateDir, 'sessions'));
  });
  afterEach(async () => {
    setSystemTime();
    await rm(stateDir, { recursive: true, force: true });
  });

  function agent(messages?: AmpStreamMessage[]) {
    const transport: AmpTransport = {
      name: 'cli',
      async *execute(request) {
        requests.push(request);
        if (messages) {
          yield* messages;
          return;
        }
        yield { type: 'system', session_id: threadId };
        yield { type: 'result', subtype: failTurn ? 'error_during_execution' : 'success', is_error: failTurn, error: failTurn ? 'fixture error' : undefined };
      },
    };
    return new AmpAcpAgent(client, transport, {
      threadStore: new FileThreadMappingStore(stateDir),
      discoverPluginModes: () => [], exportThread: async () => [],
      replayRetry: { attempts: 1, delayMs: 0 },
    });
  }

  async function record(sessionId: string, fields: Record<string, unknown>) {
    await writeFile(path.join(stateDir, 'sessions', `${sessionId}.json`), JSON.stringify({ sessionId, threadId, ...fields }));
  }

  it('advertises listing and reloads a listed session on the exact mapped thread after restart', async () => {
    const first = agent();
    const session = await first.newSession({ cwd, mcpServers: [] });
    await first.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'private prompt must not become a title' }] });
    const second = agent();
    const init = await second.initialize({ protocolVersion: 1 });
    expect(init.agentCapabilities?.sessionCapabilities).toEqual({ resume: {}, list: {} });
    const list = await second.listSessions({ cwd });
    expect(list.sessions).toEqual([{ sessionId: session.sessionId, cwd, updatedAt: expect.any(String) }]);
    expect(list.sessions[0]).not.toHaveProperty('title');
    await second.loadSession({ sessionId: list.sessions[0].sessionId, cwd, mcpServers: [] });
    await second.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'continue' }] });
    expect(requests.map((request) => request.options.continue)).toEqual([undefined, threadId]);
  });

  it('filters normalized cwd exactly and sorts activity descending, ignoring corrupt and cwd-less mappings', async () => {
    await record('S-earlier-000001', { cwd, updatedAt: '2026-01-01T00:00:00.000Z' });
    await record('S-latest-000002', { cwd: path.join(cwd, 'nested', '..'), updatedAt: '2026-03-01T00:00:00.000Z' });
    await record('S-other-000003', { cwd: `${cwd}-other`, updatedAt: '2026-05-01T00:00:00.000Z' });
    await record('S-nocwd-000004', { updatedAt: '2026-06-01T00:00:00.000Z' });
    await record('S-invalid-000005', { cwd, threadId: 'T-not-valid' });
    await record('S-baddate-000006', { cwd, updatedAt: 'not a date' });
    await writeFile(path.join(stateDir, 'sessions', 'S-corrupt-000007.json'), '{');
    const list = await agent().listSessions({ cwd: `${cwd}${path.sep}.` });
    expect(list.sessions).toEqual([
      { sessionId: 'S-latest-000002', cwd, updatedAt: '2026-03-01T00:00:00.000Z' },
      { sessionId: 'S-earlier-000001', cwd, updatedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    expect((await agent().listSessions({})).sessions).toHaveLength(3);
    expect((await agent().listSessions({ cwd: path.join(cwd, 'nested') })).sessions).toEqual([]);
  });

  it('uses legacy file mtime without changing the durable mapping', async () => {
    const sessionId = 'S-legacy-000001';
    await record(sessionId, { cwd });
    const date = new Date('2024-02-03T04:05:06.000Z');
    await utimes(path.join(stateDir, 'sessions', `${sessionId}.json`), date, date);
    const store = new FileThreadMappingStore(stateDir);
    expect(await store.load(sessionId)).toEqual({ sessionId, threadId, cwd });
    expect(await store.list()).toEqual([{ sessionId, threadId, cwd, updatedAt: '2024-02-03T04:05:06.000Z' }]);
  });

  it('paginates 50 at a time with deterministic ties and rejects invalid cursors', async () => {
    for (let index = 0; index < 53; index++) {
      await record(`S-page-${String(index).padStart(6, '0')}`, { cwd, updatedAt: '2026-04-01T00:00:00.000Z' });
    }
    const adapter = agent();
    const first = await adapter.listSessions({ cwd });
    expect(first.sessions).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await adapter.listSessions({ cwd, cursor: first.nextCursor });
    expect(second.sessions.map((session) => session.sessionId)).toEqual(['S-page-000050', 'S-page-000051', 'S-page-000052']);
    expect(second.nextCursor).toBeUndefined();
    expect(new Set([...first.sessions, ...second.sessions].map((session) => session.sessionId)).size).toBe(53);
    const invalid = await adapter.listSessions({ cursor: 'garbage!' }).catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(RequestError);
    expect(invalid).toMatchObject({ code: -32602 });
    await expect(adapter.listSessions({ cwd: `${cwd}-other`, cursor: first.nextCursor })).rejects.toThrow('Invalid params');
  });

  for (const count of [49, 50, 51, 101]) {
    it(`paginates ${count} stable sessions without duplicates, omissions or an unnecessary cursor`, async () => {
      const expected = Array.from({ length: count }, (_, index) => `S-boundary-${String(index).padStart(6, '0')}`);
      for (const sessionId of [...expected].reverse()) {
        await record(sessionId, { cwd, updatedAt: '2026-04-01T00:00:00.000Z' });
      }
      const adapter = agent();
      const received: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await adapter.listSessions({ cwd, cursor });
        expect(page.sessions).toHaveLength(Math.min(50, count - received.length));
        received.push(...page.sessions.map((session) => session.sessionId));
        expect(Boolean(page.nextCursor)).toBe(received.length < count);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(received).toEqual(expected);
    });
  }

  it('refreshes updatedAt at successful turn end but not for a failed turn', async () => {
    const sessionId = 'S-activity-000001';
    await record(sessionId, { cwd, updatedAt: '2020-01-01T00:00:00.000Z' });
    const adapter = agent();
    await adapter.resumeSession({ sessionId, cwd, mcpServers: [] });
    await adapter.prompt({ sessionId, prompt: [{ type: 'text', text: 'successful follow-up' }] });
    const store = new FileThreadMappingStore(stateDir);
    const updated = await store.load(sessionId);
    expect(updated?.updatedAt).toBe('2026-04-12T13:14:15.000Z');
    setSystemTime(new Date('2026-04-13T13:14:15.000Z'));
    failTurn = true;
    await adapter.prompt({ sessionId, prompt: [{ type: 'text', text: 'failed follow-up' }] });
    expect((await store.load(sessionId))?.updatedAt).toBe(updated!.updatedAt);
  });

  it('does not treat iterator exhaustion or malformed result flags as a successful turn', async () => {
    const sessionId = 'S-success-000001';
    const updatedAt = '2020-01-01T00:00:00.000Z';
    const cases: AmpStreamMessage[][] = [
      [],
      [{ type: 'assistant', message: { content: [{ type: 'text', text: 'partial response' }] } }],
      [{ type: 'result', is_error: false }],
      [{ type: 'result', subtype: 'success' }],
      [{ type: 'result', subtype: 'error_during_execution', is_error: false }],
    ];
    for (const messages of cases) {
      await record(sessionId, { cwd, updatedAt });
      const adapter = agent(messages);
      await adapter.resumeSession({ sessionId, cwd, mcpServers: [] });
      expect(await adapter.prompt({ sessionId, prompt: [{ type: 'text', text: 'not a successful result' }] })).toEqual({ stopReason: 'end_turn' });
      expect((await new FileThreadMappingStore(stateDir).load(sessionId))?.updatedAt).toBe(updatedAt);
    }
  });

  it('does not refresh activity after cancellation even if the transport yields success', async () => {
    const sessionId = 'S-cancelled-000001';
    const updatedAt = '2020-01-01T00:00:00.000Z';
    await record(sessionId, { cwd, updatedAt });
    const adapter = new AmpAcpAgent(client, {
      name: 'cli',
      async *execute(request) {
        expect(request.options.continue).toBe(threadId);
        await adapter.cancel({ sessionId });
        expect(request.signal.aborted).toBe(true);
        yield { type: 'result', subtype: 'success', is_error: false };
      },
    }, { threadStore: new FileThreadMappingStore(stateDir), discoverPluginModes: () => [] });
    await adapter.resumeSession({ sessionId, cwd, mcpServers: [] });
    expect(await adapter.prompt({ sessionId, prompt: [{ type: 'text', text: 'cancel this turn' }] })).toEqual({ stopReason: 'cancelled' });
    expect((await new FileThreadMappingStore(stateDir).load(sessionId))?.updatedAt).toBe(updatedAt);
  });

  it('does not accept execution cancellation while only the final activity write is pending', async () => {
    const sessionId = 'S-savepending-000001';
    await record(sessionId, { cwd, updatedAt: '2020-01-01T00:00:00.000Z' });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    class GatedStore extends FileThreadMappingStore {
      override async save(mapping: AmpThreadMapping): Promise<void> {
        started.resolve();
        await release.promise;
        await super.save(mapping);
      }
    }
    const adapter = new AmpAcpAgent(client, {
      name: 'cli',
      async *execute() { yield { type: 'result', subtype: 'success', is_error: false }; },
    }, { threadStore: new GatedStore(stateDir), discoverPluginModes: () => [] });
    await adapter.resumeSession({ sessionId, cwd, mcpServers: [] });
    const turn = adapter.prompt({ sessionId, prompt: [{ type: 'text', text: 'already completed' }] });
    await started.promise;
    await adapter.cancel({ sessionId });
    release.resolve();
    expect(await turn).toEqual({ stopReason: 'end_turn' });
    expect((await new FileThreadMappingStore(stateDir).load(sessionId))?.updatedAt).toBe('2026-04-12T13:14:15.000Z');
  });

  it('ignores relative and unusable stored cwd values rather than guessing their base directory', async () => {
    await record('S-relative-000001', { cwd: 'relative-project' });
    await record('S-unusable-000002', { cwd: `${cwd}\0invalid` });
    await record('S-valid-000003', { cwd });
    expect((await agent().listSessions({ cwd: null })).sessions.map((session) => session.sessionId)).toEqual(['S-valid-000003']);
  });

  it('rejects explicitly empty cwd and cursor instead of returning all sessions', async () => {
    await expect(agent().listSessions({ cwd: '' })).rejects.toThrow('Invalid params');
    await expect(agent().listSessions({ cursor: '' })).rejects.toThrow('Invalid params');
    await expect(agent().listSessions({ cwd: 'relative' })).rejects.toThrow('Invalid params');
    await expect(agent().listSessions({ cwd: `${cwd}\0invalid` })).rejects.toThrow('Invalid params');
    expect((await agent().listSessions({ cwd: null, cursor: null })).sessions).toEqual([]);
  });

  it('returns completed work and usage if activity persistence fails, but requires initial mapping persistence', async () => {
    const sessionId = 'S-savefails-000001';
    let executions = 0;
    const transport: AmpTransport = { name: 'cli', async *execute() {
      executions++;
      yield { type: 'system', session_id: threadId };
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 2, output_tokens: 3 } };
    } };
    const adapter = new AmpAcpAgent(client, transport, {
      discoverPluginModes: () => [],
      threadStore: {
        load: async () => ({ sessionId, threadId, cwd }),
        list: async () => [],
        save: async () => { throw new Error('fixture storage unavailable'); },
      },
    });
    await adapter.resumeSession({ sessionId, cwd, mcpServers: [] });
    expect(await adapter.prompt({ sessionId, prompt: [{ type: 'text', text: 'completed work' }] })).toEqual({
      stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    });
    const fresh = await adapter.newSession({ cwd, mcpServers: [] });
    await expect(adapter.prompt({ sessionId: fresh.sessionId, prompt: [{ type: 'text', text: 'initial mapping must persist' }] })).rejects.toThrow('fixture storage unavailable');
    await expect(adapter.prompt({ sessionId: fresh.sessionId, prompt: [{ type: 'text', text: 'retry must not bypass ownership persistence' }] })).rejects.toThrow('fixture storage unavailable');
    expect(executions).toBe(2);
  });
});
