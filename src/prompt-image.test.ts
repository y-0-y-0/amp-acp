import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { RequestError, type AgentSideConnection, type ContentBlock } from '@agentclientprotocol/sdk';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AmpAcpAgent } from './server.js';
import { createCliTransport, type AmpTransport } from './amp-transport.js';
import { FileThreadMappingStore } from './thread-mapping-store.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=';
const image: ContentBlock = { type: 'image', mimeType: 'image/png', data: png };
const threadId = 'T-01234567-89ab-cdef-0123-456789abcdef';
const client = { sessionUpdate: async () => {} } as unknown as AgentSideConnection;

describe('prompt image delivery', () => {
  let dir: string;
  let log: string;
  let cli: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'amp-acp-images-'));
    log = path.join(dir, 'stdin.json');
    cli = path.join(dir, 'amp.mjs');
    await writeFile(cli, `
import { writeFileSync } from 'node:fs';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
writeFileSync(${JSON.stringify(log)}, JSON.stringify({ stdin, args: process.argv.slice(2) }));
console.log(JSON.stringify({ type: 'system', session_id: '${threadId}' }));
console.log(JSON.stringify({ type: 'result', is_error: false }));
`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function agent(transport = createCliTransport(process.execPath, [cli])) {
    return new AmpAcpAgent(client, transport, {
      threadStore: new FileThreadMappingStore(path.join(dir, 'state')),
      orbTransport: transport,
      discoverPluginModes: () => [],
    });
  }

  it('delivers one JSONL message with ordered images when continuing an exact thread', async () => {
    const adapter = agent();
    const { sessionId } = await adapter.newSession({ cwd: dir, mcpServers: [] });
    await adapter.prompt({ sessionId, prompt: [{ type: 'text', text: 'first' }] });
    await adapter.prompt({ sessionId, prompt: [
      { type: 'text', text: 'before' }, image, { type: 'text', text: 'after' },
    ] });
    const recorded = JSON.parse(await readFile(log, 'utf8'));
    expect(recorded.args.slice(0, 3)).toEqual(['threads', 'continue', threadId]);
    expect(recorded.args).toContain('--execute');
    expect(recorded.args).toContain('--stream-json');
    expect(recorded.args).toContain('--stream-json-input');
    expect(recorded.stdin.split('\n')).toHaveLength(2);
    expect(JSON.parse(recorded.stdin)).toEqual({ type: 'user', message: { role: 'user', content: [
      { type: 'text', text: 'before' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
      { type: 'text', text: 'after' },
    ] } });
  });

  it('rejects an invalid image before spawning or sending any text', async () => {
    const adapter = agent();
    const { sessionId } = await adapter.newSession({ cwd: dir, mcpServers: [] });
    const error = await adapter.prompt({ sessionId, prompt: [
      { type: 'text', text: 'must not be sent' }, image,
      { type: 'image', mimeType: 'image/png', data: 'invalid!' },
    ] }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ code: -32602, message: expect.stringContaining('base64') });
    expect(await readFile(log, 'utf8').catch(() => null)).toBeNull();
    expect(adapter.sessions.get(sessionId)?.active).toBe(false);
  });

  for (const executor of ['local', 'orb'] as const) {
    it(`rejects images explicitly before ${executor} SDK execution`, async () => {
      let executions = 0;
      const sdk: AmpTransport = { name: 'sdk', async *execute() { executions++; } };
      const adapter = agent(sdk);
      const { sessionId } = await adapter.newSession({ cwd: dir, mcpServers: [] });
      await adapter.setSessionConfigOption({ sessionId, configId: 'execution-environment', value: executor });
      const error = await adapter.prompt({ sessionId, prompt: [image] }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(RequestError);
      expect(error).toMatchObject({ code: -32602, message: expect.stringContaining('Orb/SDK') });
      expect(executions).toBe(0);
      expect(adapter.sessions.get(sessionId)?.threadId).toBeNull();
    });
  }

  it('rejects a corrupt GIF signature without spawning the CLI or delivering the text prefix', async () => {
    const adapter = agent();
    const { sessionId } = await adapter.newSession({ cwd: dir, mcpServers: [] });
    const error = await adapter.prompt({ sessionId, prompt: [
      { type: 'text', text: 'must not be sent' },
      { type: 'image', mimeType: 'image/gif', data: 'x0lGODlhAA==' },
    ] }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: -32602, message: expect.stringContaining('magic bytes') });
    expect(await readFile(log, 'utf8').catch(() => null)).toBeNull();
  });

  it('keeps text-only stdin and resource expansion unchanged', async () => {
    const adapter = agent();
    const { sessionId } = await adapter.newSession({ cwd: dir, mcpServers: [] });
    await adapter.prompt({ sessionId, prompt: [
      { type: 'text', text: 'hello' },
      { type: 'resource_link', uri: 'file:///example', name: 'example' },
      { type: 'resource', resource: { uri: 'file:///context', text: 'contents' } },
      { type: 'text', text: 'tail' },
    ] });
    const recorded = JSON.parse(await readFile(log, 'utf8'));
    expect(recorded.stdin).toBe('hello\nfile:///example\n\n<context ref="file:///context">\ncontents\n</context>\ntail');
    expect(recorded.args).not.toContain('--stream-json-input');
  });
});
