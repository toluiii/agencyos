import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Resend } from 'resend';
import Stripe from 'stripe';
import OpenAI from 'openai';
import { createReadStream, promises as fs } from 'fs';
import { Readable } from 'stream';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { randomUUID } from 'crypto';

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger('Integrations');
  private stripe?: Stripe;
  private resend?: Resend;
  private openai?: OpenAI;
  private s3?: S3Client;
  constructor(private config: ConfigService) {
    const sk = config.get<string>('STRIPE_SECRET_KEY');
    if (sk) this.stripe = new Stripe(sk);
    const rk = config.get<string>('RESEND_API_KEY');
    if (rk) this.resend = new Resend(rk);
    const ok = config.get<string>('OPENAI_API_KEY');
    if (ok) this.openai = new OpenAI({ apiKey: ok });
    if (config.get('S3_BUCKET') && config.get('S3_ACCESS_KEY_ID') && config.get('S3_SECRET_ACCESS_KEY')) {
      this.s3 = new S3Client({ region: config.get('S3_REGION') || 'auto', endpoint: config.get('S3_ENDPOINT') || undefined, forcePathStyle: config.get<boolean>('S3_FORCE_PATH_STYLE') ?? true, credentials: { accessKeyId: config.get('S3_ACCESS_KEY_ID')!, secretAccessKey: config.get('S3_SECRET_ACCESS_KEY')! } });
    }
  }
  /**
   * Local disk is a development convenience. On serverless platforms the deployment
   * filesystem is read-only, so /tmp is used and the files are explicitly reported as
   * ephemeral; durable storage requires S3-compatible credentials.
   */
  private storageRoot() { return resolve(process.env.STORAGE_DIR || (process.env.VERCEL ? '/tmp/agencyos-storage' : resolve(process.cwd(), 'storage'))); }
  private localPath(key: string) {
    const root = this.storageRoot();
    const path = resolve(root, key);
    const rel = relative(root, path);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Invalid storage key');
    return path;
  }
  status() {
    return {
      stripe: { configured: !!this.stripe, webhookConfigured: !!this.config.get('STRIPE_WEBHOOK_SECRET'), mode: this.stripe ? 'test-or-live-key-not-disclosed' : 'unavailable' },
      openai: { configured: !!this.openai, model: this.openai ? this.config.get('OPENAI_MODEL') : null },
      email: { configured: !!this.resend, provider: 'resend' },
      storage: { configured: true, provider: this.s3 ? 's3' : 'local', bucket: this.s3 ? this.config.get('S3_BUCKET') : null, ephemeral: !this.s3 && !!process.env.VERCEL },
      errorMonitoring: { configured: !!this.config.get('SENTRY_DSN') },
    };
  }
  getStripe() { if (!this.stripe) throw new ServiceUnavailableException({ statusCode: 503, code: 'STRIPE_UNAVAILABLE', message: 'Stripe is not configured. Set STRIPE_SECRET_KEY to enable test payments.' }); return this.stripe; }
  getOpenAI() { if (!this.openai) throw new ServiceUnavailableException({ statusCode: 503, code: 'AI_UNAVAILABLE', message: 'OpenAI is not configured. Set OPENAI_API_KEY to enable the assistant. No generated result is returned.' }); return this.openai; }
  async sendEmail(to: string, subject: string, html: string): Promise<boolean> {
    if (!this.resend) { this.logger.warn(JSON.stringify({ event: 'email.skipped', reason: 'RESEND_API_KEY not configured', to: to.replace(/(.{2}).*(@.*)/, '$1***$2'), subject })); return false; }
    try {
      const { error } = await this.resend.emails.send({ from: this.config.getOrThrow('EMAIL_FROM'), to, subject, html });
      if (error) throw new Error(error.message);
      return true;
    } catch (e) { this.logger.error(JSON.stringify({ event: 'email.failed', subject, error: e instanceof Error ? e.message : String(e) })); return false; }
  }
  async putFile(key: string, body: Buffer, mimeType: string) {
    if (this.s3) { await this.s3.send(new PutObjectCommand({ Bucket: this.config.getOrThrow('S3_BUCKET'), Key: key, Body: body, ContentType: mimeType })); return 'S3' as const; }
    const path = this.localPath(key);
    await fs.mkdir(join(path, '..'), { recursive: true });
    await fs.writeFile(path, body);
    return 'LOCAL' as const;
  }
  async getFile(key: string): Promise<Buffer> {
    if (this.s3) {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.config.getOrThrow('S3_BUCKET'), Key: key }));
      return Buffer.from(await res.Body!.transformToByteArray());
    }
    const path = this.localPath(key);
    return fs.readFile(path);
  }
  /**
   * Opens a stored file as a stream so downloads are piped to the client instead of being
   * loaded fully into memory (uploads can be tens of MB and run in small serverless instances).
   */
  async openFileStream(key: string): Promise<{ stream: Readable; size?: number }> {
    if (this.s3) {
      try {
        const res = await this.s3.send(new GetObjectCommand({ Bucket: this.config.getOrThrow('S3_BUCKET'), Key: key }));
        if (!res.Body) throw new NotFoundException('File not found');
        return { stream: res.Body as Readable, size: res.ContentLength };
      } catch (e) {
        const name = (e as { name?: string })?.name;
        if (name === 'NoSuchKey' || name === 'NotFound') throw new NotFoundException('File not found');
        throw e;
      }
    }
    const path = this.localPath(key);
    const stat = await fs.stat(path).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') throw new NotFoundException('File not found'); throw e; });
    return { stream: createReadStream(path), size: stat.size };
  }
  async deleteFile(key: string) {
    if (this.s3) { await this.s3.send(new DeleteObjectCommand({ Bucket: this.config.getOrThrow('S3_BUCKET'), Key: key })); return; }
    const path = this.localPath(key);
    await fs.unlink(path).catch(() => undefined);
  }
  async signedDownload(key: string) {
    if (!this.s3) return null;
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.config.getOrThrow('S3_BUCKET'), Key: key }), { expiresIn: 300 });
  }
  newStorageKey(orgId: string, filename: string) { const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120); return `${orgId}/${randomUUID()}-${safe}`; }
}
