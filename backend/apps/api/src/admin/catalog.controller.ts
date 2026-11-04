import { Body, Controller, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '@shared/http/zod-validation.pipe.js';
import { type Actor } from '@modules/access/actor.js';
import { BearerAuthGuard, CurrentActor, RequireRoles } from '@modules/access/http/bearer-auth.guard.js';
import { CatalogAdminUseCase } from '@modules/people/catalog-admin.use-case.js';
import {
  FILE_CATEGORIES,
  FileTypeRepository,
  type FileTypeRow,
} from '@modules/people/file-type.repository.js';
import { SubjectRepository } from '@modules/people/subject.repository.js';
import { uuidParam } from './admin.schemas.js';

const subjectBody = z.object({ name: z.string().trim().min(1).max(60) });
const subjectPatch = z
  .object({ name: z.string().trim().min(1).max(60).optional(), isActive: z.boolean().optional() })
  .refine((p) => p.name !== undefined || p.isActive !== undefined, {
    message: 'name or isActive is required',
  });
const fileTypeItem = z
  .object({
    ext: z.string().trim().min(1).max(11),
    category: z.enum(FILE_CATEGORIES).optional(),
    mime: z.string().min(3).max(120).optional(),
    isAllowed: z.boolean(),
  })
  .refine((t) => (t.category === undefined) === (t.mime === undefined), {
    message: 'category and mime go together',
  });
const fileTypesPut = z.object({ types: z.array(fileTypeItem).min(1).max(100) });

const fileTypeDto = (t: FileTypeRow) => ({
  ext: t.ext,
  category: t.category,
  mime: t.mime,
  isAllowed: t.isAllowed,
});

/**
 * 9.2: `GET /subjects` (any staff), `GET|POST|PATCH /admin/subjects`, `GET|PUT /admin/file-types` (UC-44).
 * `PUT /admin/file-types` is a partial update (toggle or upsert per extension) applied in one transaction.
 */
@ApiTags('catalog')
@ApiBearerAuth()
@UseGuards(BearerAuthGuard)
@Controller()
export class CatalogController {
  constructor(
    private readonly subjects: SubjectRepository,
    private readonly fileTypes: FileTypeRepository,
    private readonly admin: CatalogAdminUseCase,
  ) {}

  @Get('subjects')
  async listSubjects() {
    return (await this.subjects.listActive()).map((s) => ({ id: s.id, name: s.name }));
  }

  @Get('admin/subjects')
  @RequireRoles('ADMIN', 'SUPER_ADMIN')
  async listAllSubjects() {
    return (await this.subjects.listAll()).map((s) => ({
      id: s.id,
      name: s.name,
      isActive: s.isActive,
      position: s.position,
    }));
  }

  @Post('admin/subjects')
  @RequireRoles('ADMIN', 'SUPER_ADMIN')
  async addSubject(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(subjectBody)) body: z.infer<typeof subjectBody>,
  ) {
    const row = await this.admin.addSubject(actor, body.name);
    return { id: row.id, name: row.name, isActive: row.isActive };
  }

  @Patch('admin/subjects/:id')
  @RequireRoles('ADMIN', 'SUPER_ADMIN')
  async patchSubject(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(subjectPatch)) body: z.infer<typeof subjectPatch>,
  ) {
    const row = await this.admin.updateSubject(actor, id, body);
    return { id: row.id, name: row.name, isActive: row.isActive };
  }

  @Get('admin/file-types')
  @RequireRoles('ADMIN', 'SUPER_ADMIN')
  async listFileTypes() {
    return (await this.fileTypes.listAll()).map(fileTypeDto);
  }

  @Put('admin/file-types')
  @RequireRoles('ADMIN', 'SUPER_ADMIN')
  async putFileTypes(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(fileTypesPut)) body: z.infer<typeof fileTypesPut>,
  ) {
    return (await this.admin.updateFileTypes(actor, body.types)).map(fileTypeDto);
  }
}
