import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { RequestError, type AgentSideConnection, type ContentBlock } from '@agentclientprotocol/sdk';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AmpAcpAgent } from './server.js';
import { createAmpTransport, createCliTransport, type AmpTransport } from './amp-transport.js';
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
const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const bytes = Buffer.concat(chunks);
writeFileSync(${JSON.stringify(log)}, JSON.stringify({ stdin: bytes.toString('utf8'), stdinBase64: bytes.toString('base64'), args: process.argv.slice(2) }));
console.log(JSON.stringify({ type: 'system', session_id: '${threadId}' }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }));
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
    const expected = { type: 'user', message: { role: 'user', content: [
      { type: 'text', text: 'before' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
      { type: 'text', text: 'after' },
    ] } };
    expect(JSON.parse(recorded.stdin)).toEqual(expected);
    expect(recorded.stdinBase64).toBe(Buffer.from(`${JSON.stringify(expected)}\n`).toString('base64'));
  });

  it('rejects an invalid image before spawning or sending any text', async () => {
    const adapter = agent();
    const { sessionId } = await adapter.newSession({ cwd: dir, mcpServers: [] });
    const error = await adapter.prompt({ sessionId, prompt: [
      { type: 'text', text: 'must not be sent' }, image,
      { type: 'image', mimeType: 'image/png', data: 'invalid!' },
      { type: 'text', text: 'nor this suffix' },
    ] }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ code: -32602, message: expect.stringContaining('base64') });
    expect(await readFile(log, 'utf8').catch(() => null)).toBeNull();
    expect(adapter.sessions.get(sessionId)?.active).toBe(false);
    expect(await adapter.prompt({ sessionId, prompt: [{ type: 'text', text: 'retry with text' }] })).toEqual({ stopReason: 'end_turn' });
    expect(JSON.parse(await readFile(log, 'utf8')).stdin).toBe('retry with text');
  });

  for (const executor of ['local', 'orb'] as const) {
    it(`rejects images explicitly before ${executor} SDK execution`, async () => {
      let executions = 0;
      const sdk: AmpTransport = { name: 'sdk', async *execute() {
        executions++;
        yield { type: 'system', session_id: threadId };
        yield { type: 'result', subtype: 'success', is_error: false };
      } };
      const adapter = agent(sdk);
      const { sessionId } = await adapter.newSession({ cwd: dir, mcpServers: [] });
      await adapter.setSessionConfigOption({ sessionId, configId: 'execution-environment', value: executor });
      const error = await adapter.prompt({ sessionId, prompt: [image] }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(RequestError);
      expect(error).toMatchObject({ code: -32602, message: expect.stringContaining('Orb/SDK') });
      expect(executions).toBe(0);
      expect(adapter.sessions.get(sessionId)?.threadId).toBeNull();
      expect(await adapter.prompt({ sessionId, prompt: [{ type: 'text', text: 'retry without images' }] })).toEqual({ stopReason: 'end_turn' });
      expect(executions).toBe(1);
    });
  }

  it('rejects images in the SDK selected by AMP_ACP_TRANSPORT even for local execution', () => {
    const original = process.env.AMP_ACP_TRANSPORT;
    process.env.AMP_ACP_TRANSPORT = 'sdk';
    try {
      const transport = createAmpTransport();
      expect(transport.name).toBe('sdk');
      expect(() => transport.execute({
        prompt: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }],
        options: { cwd: dir, executor: 'local' }, signal: new AbortController().signal,
      })).toThrow('Images are not supported in Orb/SDK execution');
    } finally {
      if (original === undefined) delete process.env.AMP_ACP_TRANSPORT;
      else process.env.AMP_ACP_TRANSPORT = original;
    }
  });

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
    expect(recorded.args).toEqual(['--execute', '--stream-json', '--no-archive-after-execute', '--mode', 'medium']);
  });
});
