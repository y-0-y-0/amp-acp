import { RequestError, type ContentBlock } from '@agentclientprotocol/sdk';

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/** Input content supported by Amp's documented CLI streaming JSON format. */
export type AmpPromptPart =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source_path?: string;
      source: { type: 'base64'; media_type: ImageMediaType; data: string };
    };

export function toAmpPrompt(prompt: readonly ContentBlock[]): AmpPromptPart[] {
  const parts: AmpPromptPart[] = [];
  for (const chunk of prompt) {
    switch (chunk.type) {
      case 'text':
        parts.push({ type: 'text', text: chunk.text.trim() === '/init' ? initPrompt : chunk.text });
        break;
      case 'resource_link':
        parts.push({ type: 'text', text: `\n${chunk.uri}\n` });
        break;
      case 'resource':
        if ('text' in chunk.resource) {
          parts.push({ type: 'text', text: `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>\n` });
        }
        break;
      case 'image': {
        const mime = chunk.mimeType === 'image/jpg' ? 'image/jpeg' : chunk.mimeType;
        if (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/gif' && mime !== 'image/webp') {
          throw RequestError.invalidParams(undefined, `Unsupported image MIME type: ${chunk.mimeType}`);
        }
        // Buffer.from is permissive: validate alphabet, padding and canonical
        // decoded bytes as well, rather than silently repairing corrupt input.
        const bytes = Buffer.from(chunk.data, 'base64');
        if (!chunk.data || !/^[A-Za-z0-9+/]+={0,2}$/.test(chunk.data)
          || chunk.data.length % 4 === 1
          || (chunk.data.includes('=') && chunk.data.length % 4 !== 0)
          || bytes.toString('base64').replace(/=+$/, '') !== chunk.data.replace(/=+$/, '')) {
          throw RequestError.invalidParams(undefined, 'Invalid image base64 data');
        }
        if (imageMediaType(bytes) !== mime) {
          throw RequestError.invalidParams(undefined, `Image magic bytes do not match MIME type ${mime}`);
        }
        let sourcePath: string | undefined;
        if (chunk.uri && /^file:\/\//i.test(chunk.uri)) {
          try {
            if (new URL(chunk.uri).protocol === 'file:') sourcePath = chunk.uri;
          } catch {
            throw RequestError.invalidParams(undefined, 'Invalid image file URI');
          }
        }
        parts.push({
          type: 'image',
          ...(sourcePath ? { source_path: sourcePath } : {}),
          source: { type: 'base64', media_type: mime, data: chunk.data },
        });
        break;
      }
    }
  }
  return parts;
}

function imageMediaType(bytes: Buffer): ImageMediaType | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  const header = bytes.subarray(0, 6);
  if (header.equals(Buffer.from('GIF87a')) || header.equals(Buffer.from('GIF89a'))) return 'image/gif';
  if (bytes.subarray(0, 4).equals(Buffer.from('RIFF'))
    && bytes.subarray(8, 12).equals(Buffer.from('WEBP'))) return 'image/webp';
  return undefined;
}

const initPrompt = `Please analyze this codebase and create an AGENTS.md file containing:
1. Build/lint/test commands - especially for running a single test
2. Architecture and codebase structure information, including important subprojects, internal APIs, databases, etc.
3. Code style guidelines, including imports, conventions, formatting, types, naming conventions, error handling, etc.

The file you create will be given to agentic coding tools (such as yourself) that operate in this repository. Make it about 20 lines long.

If there are Cursor rules (in .cursor/rules/ or .cursorrules), Claude rules (CLAUDE.md), Windsurf rules (.windsurfrules), Cline rules (.clinerules), Goose rules (.goosehints), or Copilot rules (in .github/copilot-instructions.md), make sure to include them. Also, first check if there is an existing AGENTS.md or AGENT.md file, and if so, update it instead of overwriting it.`;
