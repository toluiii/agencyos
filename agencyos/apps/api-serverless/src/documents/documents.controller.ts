import { BadRequestException, Body, Logger, Controller, Delete, Get, Param, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors, NotFoundException, ForbiddenException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { pipeline } from 'stream/promises';
import { OrgGuard } from '../common/guards/org.guard';
import { Scope, TenantScope } from '../common/decorators/scope.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { AuditService } from '../common/audit.service';
import { ProjectsService } from '../projects/projects.service';
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain', 'text/csv', 'application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/msword', 'application/vnd.ms-excel']);
@ApiTags('Documents') @ApiBearerAuth() @Controller('documents') @UseGuards(OrgGuard)
export class DocumentsController {
  private readonly logger = new Logger(DocumentsController.name);
  constructor(private prisma: PrismaService, private storage: IntegrationsService, private audit: AuditService, private projects: ProjectsService) {}
  @Get() async list(@Scope() s: TenantScope, @Query('projectId') projectId?: string, @Query('clientId') clientId?: string) {
    if (projectId) await this.projects.assertAccess(s, projectId);
    return this.prisma.document.findMany({ where: { organizationId: s.organizationId, ...(projectId ? { projectId } : {}), ...(s.role === 'CLIENT' ? { clientId: s.clientId ?? '__none__' } : clientId ? { clientId } : {}), ...(s.role === 'DEVELOPER' ? { OR: [{ projectId: null }, { project: { members: { some: { userId: s.userId } } } }] } : {}) }, orderBy: { createdAt: 'desc' }, include: { uploadedBy: { select: { id: true, name: true } }, project: { select: { id: true, name: true } }, client: { select: { id: true, name: true } } } });
  }
  @Post('upload') @ApiConsumes('multipart/form-data') @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } }))
  async upload(@Scope() s: TenantScope, @UploadedFile() file: Express.Multer.File, @Body('projectId') projectId?: string, @Body('clientId') clientId?: string) {
    if (!file) throw new BadRequestException('file is required');
    // Multipart fields are untyped (a repeated field arrives as an array); reject anything but a string.
    if ((projectId !== undefined && typeof projectId !== 'string') || (clientId !== undefined && typeof clientId !== 'string')) throw new BadRequestException('projectId and clientId must be strings');
    projectId = projectId || undefined; clientId = clientId || undefined;
    if (file.size > MAX_BYTES) throw new BadRequestException('File exceeds 10 MB limit');
    if (!ALLOWED.has(file.mimetype)) throw new BadRequestException('File type not allowed');
    let resolvedClientId = clientId;
    if (projectId) { const p = await this.projects.assertAccess(s, projectId); resolvedClientId = p.clientId; }
    if (s.role === 'CLIENT') { if (resolvedClientId && resolvedClientId !== s.clientId) throw new BadRequestException('Cannot upload for another client'); resolvedClientId = s.clientId ?? undefined; if (!resolvedClientId) throw new BadRequestException('Client account is not linked'); }
    if (resolvedClientId) { const c = await this.prisma.client.findFirst({ where: { id: resolvedClientId, organizationId: s.organizationId } }); if (!c) throw new BadRequestException('Client not found'); }
    const key = this.storage.newStorageKey(s.organizationId, file.originalname);
    const provider = await this.storage.putFile(key, file.buffer, file.mimetype);
    const doc = await this.prisma.document.create({ data: { organizationId: s.organizationId, clientId: resolvedClientId, projectId, name: file.originalname.slice(0, 200), mimeType: file.mimetype, sizeBytes: file.size, storageKey: key, provider, uploadedById: s.userId }, include: { uploadedBy: { select: { id: true, name: true } } } });
    await this.audit.record({ organizationId: s.organizationId, actorId: s.userId, action: 'document.uploaded', entityType: 'Document', entityId: doc.id, metadata: { projectId, clientId: resolvedClientId, name: doc.name, sizeBytes: doc.sizeBytes } });
    return doc;
  }
  @Get(':id/download') async download(@Scope() s: TenantScope, @Param('id') id: string, @Res() res: Response) {
    const doc = await this.findOne(s, id);
    const { stream, size } = await this.storage.openFileStream(doc.storageKey);
    res.attachment(doc.name); res.setHeader('Content-Type', doc.mimeType); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (size !== undefined) res.setHeader('Content-Length', size);
    try {
      await pipeline(stream, res);
    } catch (e) {
      // Headers are already on the wire, so the only option left is to abort the response.
      // A client closing the tab mid-download is normal and not worth a warning.
      if ((e as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') this.logger.warn(`Download of document ${doc.id} aborted: ${(e as Error).message}`);
      if (!res.headersSent) res.status(500).end(); else res.destroy();
    }
  }
  @Delete(':id') async remove(@Scope() s: TenantScope, @Param('id') id: string) {
    const doc = await this.findOne(s, id);
    if (s.role === 'CLIENT' && doc.uploadedById !== s.userId) throw new ForbiddenException('Clients can only delete their own uploads');
    await this.storage.deleteFile(doc.storageKey); await this.prisma.document.delete({ where: { id } });
    await this.audit.record({ organizationId: s.organizationId, actorId: s.userId, action: 'document.deleted', entityType: 'Document', entityId: id });
    return { message: 'Document deleted' };
  }
  private async findOne(s: TenantScope, id: string) {
    const doc = await this.prisma.document.findFirst({ where: { id, organizationId: s.organizationId, ...(s.role === 'CLIENT' ? { clientId: s.clientId ?? '__none__' } : {}) }, include: { project: true } });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.projectId) await this.projects.assertAccess(s, doc.projectId);
    return doc;
  }
}
