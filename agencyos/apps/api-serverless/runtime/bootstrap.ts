import 'reflect-metadata';
import express, { json, urlencoded, type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';
import { NotificationService } from '../src/notifications/notifications.service';
import { MaintenanceService } from '../src/maintenance/maintenance.service';
import { safeEqual } from '../src/common/utils/security';

/**
 * Serverless bootstrap. Identical module graph, guards, pipes, cookies, CORS and error
 * handling to apps/api/src/main.ts — the only differences are the ones a serverless
 * platform forces:
 *
 *  1. no app.listen(): the platform owns the socket, we hand it an Express handler;
 *  2. no in-process cron: Vercel Cron calls /api/cron/reminders instead;
 *  3. Swagger UI is served from a CDN because @nestjs/swagger's static asset copy is not
 *     reliably traced into a serverless bundle (the OpenAPI JSON is always served locally);
 *  4. local file storage falls back to /tmp and is reported as ephemeral.
 */

// Pinned to an exact version with Subresource Integrity so a compromised or re-published CDN
// file cannot run script on the API origin. To upgrade: change the version and recompute both
// hashes with `openssl dgst -sha384 -binary node_modules/swagger-ui-dist/<file> | base64`.
const SWAGGER_UI = 'https://unpkg.com/swagger-ui-dist@5.34.1';
const DOCS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>AgencyOS API</title><link rel="stylesheet" href="${SWAGGER_UI}/swagger-ui.css" integrity="sha384-4c3vsE5f+trhFyHrFrLM1fFGUn531NIaC7dcqEWIJdoRQJ5CkJbSuSCwXLpaS1KF" crossorigin="anonymous" referrerpolicy="no-referrer">
<style>body{margin:0}</style></head><body><div id="swagger"></div>
<script src="${SWAGGER_UI}/swagger-ui-bundle.js" integrity="sha384-XFYN47VzPiDY6qPtxYKg0nqUeW/upo20xf1j2SUE7gT/i35FJB4cuS/71Iegzk8Z" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script>window.onload=()=>SwaggerUIBundle({url:'/api/docs-json',dom_id:'#swagger',deepLinking:true,persistAuthorization:false});</script>
</body></html>`;

export async function createApp(): Promise<Express> {
  const server = express();
  server.disable('x-powered-by');
  // Vercel terminates TLS in front of the function; trust the proxy for secure cookies / IPs.
  server.set('trust proxy', 1);

  const app = await NestFactory.create(AppModule, new ExpressAdapter(server), { bodyParser: false });
  const config = app.get(ConfigService);

  app.use(helmet());
  app.use(cookieParser());
  // Raw bytes for Stripe signature verification must survive before any JSON parsing.
  app.use('/api/v1/billing/webhooks/stripe', json({ verify: (req: any, _res, buf) => { req.rawBody = Buffer.from(buf); } }));
  app.use(json({ limit: '2mb' }));
  app.use(urlencoded({ extended: true, limit: '2mb' }));
  app.enableCors({ origin: config.getOrThrow<string>('WEB_URL'), credentials: true });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }));

  const swagger = new DocumentBuilder()
    .setTitle('AgencyOS API')
    .setDescription('Multi-tenant agency operations platform (Vercel serverless deployment). Organization-scoped endpoints require the x-organization-id header. Browser mutations use HTTP-only cookies plus x-csrf-token.')
    .setVersion('1.0').addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'x-organization-id', in: 'header' }, 'organization').build();
  const document = SwaggerModule.createDocument(app, swagger);

  server.get('/api/docs-json', (_req: Request, res: Response) => { res.json(document); });
  server.get('/api/docs', (_req: Request, res: Response) => {
    res.removeHeader('Content-Security-Policy'); // CDN-hosted Swagger UI assets
    res.type('html').send(DOCS_HTML);
  });

  // Vercel Cron target. Vercel sends `Authorization: Bearer <CRON_SECRET>`.
  server.get('/api/cron/reminders', async (req: Request, res: Response) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) { res.status(503).json({ code: 'CRON_UNAVAILABLE', message: 'CRON_SECRET is not configured.' }); return; }
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !safeEqual(auth, `Bearer ${secret}`)) { res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid cron credentials.' }); return; }
    try {
      const reminders = await app.get(NotificationService).deadlineReminders();
      const retention = await app.get(MaintenanceService).purgeExpiredRecords();
      res.json({ ...reminders, retention });
    } catch (error) {
      Logger.error(error instanceof Error ? error.message : String(error), 'Cron');
      res.status(500).json({ code: 'CRON_FAILED', message: 'Reminder job failed.' });
    }
  });

  server.get('/', (_req: Request, res: Response) => {
    res.json({ service: 'AgencyOS API', runtime: 'vercel-serverless', docs: '/api/docs', health: '/api/v1/health/ready' });
  });

  await app.init();
  return server;
}
