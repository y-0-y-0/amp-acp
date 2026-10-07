import { describe, expect, it } from 'bun:test';
import { RequestError, type ContentBlock } from '@agentclientprotocol/sdk';
import { toAmpPrompt } from './to-amp.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=';
const image: ContentBlock = { type: 'image', data: png, mimeType: 'image/png' };

describe('ACP to Amp prompt conversion', () => {
  it('converts a base64-only image without inventing a URL source', () => {
    expect(toAmpPrompt([image])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
    ]);
  });

  it('preserves text, multiple images and text in input order', () => {
    expect(toAmpPrompt([
      { type: 'text', text: 'left' }, image,
      { ...image, uri: 'file:///example.png' }, { type: 'text', text: 'right' },
    ])).toEqual([
      { type: 'text', text: 'left' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
      { type: 'image', source_path: 'file:///example.png', source: { type: 'base64', media_type: 'image/png', data: png } },
      { type: 'text', text: 'right' },
    ]);
  });

  it('does not forward HTTP image URIs or bare paths as source_path', () => {
    for (const uri of ['https://example.com/image.png', '/example.png']) {
      expect(toAmpPrompt([{ ...image, uri }])[0]).not.toHaveProperty('source_path');
    }
  });

  // Header fixtures isolate MIME sniffing; they are not complete image files.
  for (const [mimeType, data] of [
    ['image/jpeg', '/9j/AA=='],
    ['image/jpg', '/9j/AA=='],
    ['image/gif', 'R0lGODlhAA=='],
    ['image/gif', 'R0lGODdhAA=='],
    ['image/webp', 'UklGRgQAAABXRUJQ'],
  ]) {
    it(`recognizes magic bytes and normalizes ${mimeType}`, () => {
      expect(toAmpPrompt([{ type: 'image', mimeType, data }])).toEqual([
        { type: 'image', source: { type: 'base64', media_type: mimeType === 'image/jpg' ? 'image/jpeg' : mimeType, data } },
      ]);
    });
  }

  it('rejects unsupported MIME types instead of discarding them', () => {
    for (const mimeType of ['image/svg+xml', 'image/heic', 'image/bmp', 'application/octet-stream']) {
      expect(() => toAmpPrompt([{ ...image, mimeType }])).toThrow('Unsupported image MIME type');
    }
  });

  it('rejects invalid base64 alphabet, padding, pad bits and empty data', () => {
    for (const data of ['', 'invalid!', 'a', 'abcd===', 'iVBORw0KGgp=', 'iVBORw0KGgo=\n', 'iVBORw0KGgo==']) {
      expect(() => toAmpPrompt([{ ...image, data }])).toThrow('Invalid image base64');
    }
  });

  it('rejects mismatched, unknown and truncated magic bytes with invalidParams', () => {
    for (const data of ['/9j/AA==', 'aGVsbG8=', 'iVBORw==', 'UklGRgQAAABXQVZF']) {
      try {
        toAmpPrompt([{ ...image, data }]);
        throw new Error('image was accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(RequestError);
        expect(error).toMatchObject({ code: -32602, message: expect.stringContaining('magic bytes') });
      }
    }
  });

  it('rejects high-bit GIF and WebP signature lookalikes', () => {
    for (const [mimeType, data] of [
      ['image/gif', 'x0lGODlhAA=='],
      ['image/webp', '0klGRgQAAABXRUJQ'],
      ['image/webp', 'UklGRgQAAADXRUJQ'],
    ]) {
      expect(() => toAmpPrompt([{ type: 'image', mimeType, data }])).toThrow('magic bytes');
    }
  });

  it('keeps /init expansion as text and handles an empty prompt', () => {
    const [part] = toAmpPrompt([{ type: 'text', text: ' /init ' }]);
    expect(part.type).toBe('text');
    expect(part).toMatchObject({ text: expect.stringContaining('create an AGENTS.md file') });
    expect(toAmpPrompt([])).toEqual([]);
  });
});
