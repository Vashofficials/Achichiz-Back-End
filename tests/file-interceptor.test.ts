/**
 * Regression: multi-image product upload failed with "Unexpected end of form".
 *
 * `defineRoute` mounts `fileInterceptor` for every multipart route, and the upload handlers
 * then ran multer AGAIN over the already-consumed request stream. These tests drive real
 * multipart bodies through the interceptor and assert it is the single parse, that every
 * file comes out in order, and that a bad file stops the batch before anything is stored.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const uploadMedia = vi.fn();
vi.mock('../src/modules/media/media.service.js', () => ({
  uploadMedia: (...args: unknown[]) => uploadMedia(...args),
}));

const { fileInterceptor, UPLOAD_LIMITS } = await import('../src/middleware/file-interceptor.js');

function app() {
  const a = express();
  a.post('/upload', fileInterceptor, (req: Request, res: Response) => {
    res.status(201).json({ assets: req.uploadedAssets, body: req.body as unknown });
  });
  a.use((err: Error & { status?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).json({ code: err.code, message: err.message });
  });
  return a;
}

let seq = 0;
beforeEach(() => {
  seq = 0;
  uploadMedia.mockReset();
  uploadMedia.mockImplementation((file: Express.Multer.File) =>
    Promise.resolve({
      id: `asset-${++seq}`,
      url: `https://cdn.test/${file.originalname}`,
      mimeType: file.mimetype,
      kind: file.mimetype.startsWith('video/') ? 'video' : 'image',
    }),
  );
});

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('fileInterceptor', () => {
  it('stores four images sent under one field name, in order, without a second parse', async () => {
    const res = await request(app())
      .post('/upload')
      .attach('files', png, { filename: 'a.png', contentType: 'image/png' })
      .attach('files', png, { filename: 'b.png', contentType: 'image/png' })
      .attach('files', png, { filename: 'c.png', contentType: 'image/png' })
      .attach('files', png, { filename: 'd.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.assets.map((a: { url: string }) => a.url)).toEqual([
      'https://cdn.test/a.png',
      'https://cdn.test/b.png',
      'https://cdn.test/c.png',
      'https://cdn.test/d.png',
    ]);
    // A repeated field used to be overwritten on every iteration, leaving one id.
    expect(res.body.body.files).toEqual(['asset-1', 'asset-2', 'asset-3', 'asset-4']);
  });

  it('accepts a short video alongside images', async () => {
    const res = await request(app())
      .post('/upload')
      .attach('files', png, { filename: 'a.png', contentType: 'image/png' })
      .attach('files', Buffer.alloc(1024), { filename: 'clip.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(201);
    expect(res.body.assets.map((a: { kind: string }) => a.kind)).toEqual(['image', 'video']);
  });

  it('keeps a single-file field as a plain id', async () => {
    const res = await request(app())
      .post('/upload')
      .field('note', 'hello')
      .attach('file', png, { filename: 'logo.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.body).toMatchObject({ note: 'hello', file: 'asset-1', imageUrl: 'https://cdn.test/logo.png' });
  });

  it('refuses an unsupported type and stores nothing from the batch', async () => {
    const res = await request(app())
      .post('/upload')
      .attach('files', png, { filename: 'ok.png', contentType: 'image/png' })
      .attach('files', Buffer.from('MZ'), { filename: 'evil.exe', contentType: 'application/x-msdownload' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('unsupported_media_type');
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('holds images to 5 MB even though the multer ceiling is the video limit', async () => {
    const big = Buffer.alloc(UPLOAD_LIMITS.imageBytes + 1);
    const res = await request(app())
      .post('/upload')
      .attach('files', big, { filename: 'huge.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('media_too_large');
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('refuses more than the file-count limit', async () => {
    let req = request(app()).post('/upload');
    for (let i = 0; i <= UPLOAD_LIMITS.maxFiles; i++) {
      req = req.attach('files', png, { filename: `${i}.png`, contentType: 'image/png' });
    }
    const res = await req;
    expect(res.status).toBe(400);
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('passes a request with no files straight through with an empty list', async () => {
    const res = await request(app()).post('/upload').field('only', 'text');
    expect(res.status).toBe(201);
    expect(res.body.assets).toEqual([]);
  });
});
