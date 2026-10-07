import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isAmpThreadId } from './amp-transport.js';

const ACP_SESSION_ID_PATTERN = /^S-[a-z0-9]+-[a-z0-9]{6}$/i;

export interface AmpThreadMapping {
  sessionId: string;
  threadId: string;
  /** Last selected ACP permission mode, if persisted. */
  mode?: string;
  /** Last selected Amp mode, if persisted. */
  model?: string;
  /** Last selected execution environment, if persisted. */
  executor?: string;
  /** Working directory the session ran in, if persisted. */
  cwd?: string;
  /** ISO 8601 last activity timestamp; older records use file mtime in list(). */
  updatedAt?: string;
}

export interface ThreadMappingStore {
  load(sessionId: string): Promise<AmpThreadMapping | null>;
  save(mapping: AmpThreadMapping): Promise<void>;
  list(): Promise<AmpThreadMapping[]>;
}

function assertAcpSessionId(sessionId: string): void {
  if (!ACP_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid ACP session ID: ${sessionId}`);
  }
}

function validateMapping(value: unknown, expectedSessionId: string): AmpThreadMapping {
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid persisted mapping for ACP session ${expectedSessionId}`);
  }
  const mapping = value as Record<string, unknown>;
  if (
    mapping.sessionId !== expectedSessionId
    || !isAmpThreadId(mapping.threadId)
  ) {
    throw new Error(`Invalid persisted mapping for ACP session ${expectedSessionId}`);
  }
  const result: AmpThreadMapping = {
    sessionId: expectedSessionId,
    threadId: mapping.threadId,
  };
  for (const field of ['mode', 'model', 'executor', 'cwd'] as const) {
    const fieldValue = mapping[field];
    if (fieldValue === undefined) continue;
    if (typeof fieldValue !== 'string') {
      throw new Error(`Invalid persisted mapping for ACP session ${expectedSessionId}`);
    }
    result[field] = fieldValue;
  }
  if (mapping.updatedAt !== undefined) {
    if (typeof mapping.updatedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(mapping.updatedAt)
      || !Number.isFinite(Date.parse(mapping.updatedAt))
      || new Date(`${mapping.updatedAt.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== mapping.updatedAt.slice(0, 10)) {
      throw new Error(`Invalid persisted mapping for ACP session ${expectedSessionId}`);
    }
    result.updatedAt = new Date(mapping.updatedAt).toISOString();
  }
  return result;
}

export function defaultAmpAcpStateDir(): string {
  if (process.env.AMP_ACP_STATE_DIR) return process.env.AMP_ACP_STATE_DIR;
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local', 'state');
  return path.join(stateHome, 'amp-acp');
}

export class FileThreadMappingStore implements ThreadMappingStore {
  private sessionsDir: string;

  constructor(stateDir = defaultAmpAcpStateDir()) {
    this.sessionsDir = path.join(stateDir, 'sessions');
  }

  async load(sessionId: string): Promise<AmpThreadMapping | null> {
    assertAcpSessionId(sessionId);
    try {
      const contents = await readFile(this.mappingPath(sessionId), 'utf8');
      return validateMapping(JSON.parse(contents), sessionId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(mapping: AmpThreadMapping): Promise<void> {
    assertAcpSessionId(mapping.sessionId);
    if (!isAmpThreadId(mapping.threadId)) {
      throw new Error(`Invalid Amp thread ID: ${mapping.threadId}`);
    }
    await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
    const destination = this.mappingPath(mapping.sessionId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ ...mapping, updatedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  }

  async list(): Promise<AmpThreadMapping[]> {
    let files: Dirent[];
    try {
      files = await readdir(this.sessionsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const mappings: AmpThreadMapping[] = [];
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const sessionId = file.name.slice(0, -5);
      if (!ACP_SESSION_ID_PATTERN.test(sessionId)) continue;
      try {
        const mapping = await this.load(sessionId);
        if (!mapping) continue;
        const updatedAt = mapping.updatedAt ?? (await stat(this.mappingPath(sessionId))).mtime.toISOString();
        mappings.push({ ...mapping, updatedAt });
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') {
          throw error;
        }
        // Corrupt or concurrently removed records must not hide valid sessions.
      }
    }
    return mappings;
  }

  private mappingPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }
}
