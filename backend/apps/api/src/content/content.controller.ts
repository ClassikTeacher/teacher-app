import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '@shared/http/zod-validation.pipe.js';
import type { Actor } from '@modules/access/actor.js';
import { BearerAuthGuard, CurrentActor, RequireRoles } from '@modules/access/http/bearer-auth.guard.js';
import { GrantsUseCase } from '@modules/content/grants.use-case.js';
import { MaterialsQuery } from '@modules/content/materials.query.js';
import {
  MAX_BODY_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_URL_LENGTH,
  MaterialsUseCase,
} from '@modules/content/materials.use-case.js';
import type { AccessGrantRow, CollectionRow, MaterialRow } from '@modules/content/schema.js';
import { uuidParam } from '../admin/admin.schemas.js';

const base = {
  title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
  description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).nullable().optional(),
  subjectId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
};
const materialBody = z.discriminatedUnion('kind', [
  // file materials need a stored file: uploads arrive through the bots in MVP (`POST /files/uploads` is stage 2)
  z.object({ kind: z.literal('file'), fileId: z.string().uuid(), ...base }).strict(),
  z.object({ kind: z.literal('link'), url: z.string().trim().min(1).max(MAX_URL_LENGTH), ...base }).strict(),
  z
    .object({ kind: z.literal('text'), body: z.string().trim().min(1).max(MAX_BODY_LENGTH), ...base })
    .strict(),
]);
const collectionBody = z
  .object({
    title: base.title,
    description: base.description,
    periodFrom: z.string().date().nullable().optional(),
    periodTo: z.string().date().nullable().optional(),
  })
  .strict();
const collectionItemBody = z.object({ materialId: z.string().uuid() }).strict();
const grantBody = z
  .object({
    subjectType: z.enum(['material', 'collection']),
    subjectId: z.string().uuid(),
    studentId: z.string().uuid().optional(),
    groupId: z.string().uuid().optional(),
    availableFrom: z.coerce.date().nullable().optional(),
    availableUntil: z.coerce.date().nullable().optional(),
  })
  .strict()
  .refine((b) => (b.studentId ? 1 : 0) + (b.groupId ? 1 : 0) === 1, 'exactly one of studentId, groupId');

const materialView = (m: MaterialRow) => ({
  id: m.id,
  kind: m.kind,
  title: m.title,
  description: m.description,
  fileId: m.fileId,
  url: m.url,
  body: m.body,
  subjectId: m.subjectId,
  tags: m.tags,
  archivedAt: m.archivedAt?.toISOString() ?? null,
  createdAt: m.createdAt.toISOString(),
});
const collectionView = (c: CollectionRow) => ({
  id: c.id,
  title: c.title,
  description: c.description,
  periodFrom: c.periodFrom,
  periodTo: c.periodTo,
  archivedAt: c.archivedAt?.toISOString() ?? null,
});
const grantView = (g: AccessGrantRow) => ({
  id: g.id,
  subjectType: g.subjectType,
  subjectId: g.subjectId,
  granteeType: g.granteeType,
  granteeId: g.granteeId,
  availableFrom: g.availableFrom?.toISOString() ?? null,
  availableUntil: g.availableUntil?.toISOString() ?? null,
  revokedAt: g.revokedAt?.toISOString() ?? null,
});

/** Content of the calling teacher (9.2 "Content"): materials, collections, grants (M5-02). */
@ApiTags('content')
@ApiBearerAuth()
@UseGuards(BearerAuthGuard)
@RequireRoles('TEACHER')
@Controller()
export class ContentController {
  constructor(
    private readonly materials: MaterialsUseCase,
    private readonly grants: GrantsUseCase,
    private readonly query: MaterialsQuery,
  ) {}

  @Get('materials')
  async listMaterials(@CurrentActor() actor: Actor) {
    return (await this.query.list(actor.accountId)).map(materialView);
  }

  @Post('materials')
  async createMaterial(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(materialBody)) body: z.infer<typeof materialBody>,
  ) {
    return materialView(await this.materials.create(actor, body));
  }

  @Get('materials/:id')
  async material(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    const card = await this.query.card(actor.accountId, id);
    return {
      ...materialView(card.material),
      grants: card.grants.map((g) => grantView(g.grant)),
      viewedBy: card.views.map((v) => v.studentId),
      collectionIds: card.collections.map((c) => c.id),
    };
  }

  /** Р-27: archives the material and erases its file from storage, freeing the quota. */
  @Delete('materials/:id')
  @HttpCode(204)
  async deleteMaterial(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
  ) {
    await this.materials.delete(actor, id);
  }

  @Get('collections')
  async listCollections(@CurrentActor() actor: Actor) {
    return (await this.query.collections(actor.accountId)).map(collectionView);
  }

  @Post('collections')
  async createCollection(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(collectionBody)) body: z.infer<typeof collectionBody>,
  ) {
    return collectionView(await this.materials.createCollection(actor, body));
  }

  @Post('collections/:id/items')
  @HttpCode(204)
  async addItem(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(collectionItemBody)) body: z.infer<typeof collectionItemBody>,
  ) {
    await this.materials.addToCollection(actor, id, body.materialId);
  }

  @Post('grants')
  async grant(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(grantBody)) body: z.infer<typeof grantBody>,
  ) {
    const result = await this.grants.grant(actor, {
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      grantee: body.studentId ? { studentId: body.studentId } : { groupId: body.groupId! },
      availableFrom: body.availableFrom ?? null,
      availableUntil: body.availableUntil ?? null,
    });
    return { ...grantView(result.grant), studentIds: result.studentIds };
  }

  @Delete('grants/:id')
  @HttpCode(204)
  async revoke(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    await this.grants.revoke(actor, id);
  }
}
