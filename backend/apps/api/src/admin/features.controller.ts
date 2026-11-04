import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { TransactionManager } from '@shared/db/transaction-manager.js';
import { ZodValidationPipe } from '@shared/http/zod-validation.pipe.js';
import { type Actor } from '@modules/access/actor.js';
import { FEATURE_CATALOG, FEATURE_KEYS } from '@modules/access/features/catalog.js';
import { FeatureAdminUseCase } from '@modules/access/features/feature-admin.use-case.js';
import { FeatureService } from '@modules/access/features/feature.service.js';
import type { ResolvedFeatures } from '@modules/access/features/rules.js';
import { BearerAuthGuard, CurrentActor, RequireRoles } from '@modules/access/http/bearer-auth.guard.js';
import { uuidParam } from './admin.schemas.js';

const limits = z.record(z.string().min(1).max(40), z.number().nonnegative().nullable());

const globalPatch = z.object({
  key: z.enum(FEATURE_KEYS),
  globalEnabled: z.boolean().optional(),
  defaultEnabled: z.boolean().optional(),
  defaultLimits: limits.optional(),
});
const globalPut = z.object({ features: z.array(globalPatch).min(1).max(FEATURE_KEYS.length) });

const teacherPatch = z.object({
  key: z.enum(FEATURE_KEYS),
  enabled: z.boolean().nullable().optional(),
  limits: limits.nullable().optional(),
});
const teacherPut = z.object({ features: z.array(teacherPatch).min(1).max(FEATURE_KEYS.length) });

function serialize(resolved: ResolvedFeatures) {
  return FEATURE_CATALOG.map((f) => {
    const r = resolved.get(f.key)!;
    return {
      key: f.key,
      stage: f.stage,
      toggleable: f.toggleable,
      dependsOn: f.dependsOn,
      enabled: r.enabled,
      reason: r.reason,
      globalEnabled: r.globalEnabled,
      defaultEnabled: r.defaultEnabled,
      personalEnabled: r.personalEnabled,
      limits: r.limits,
    };
  });
}

/**
 * 9.2 Admin: `GET|PUT /admin/features` (platform), `GET|PUT /admin/teachers/{id}/features`.
 * A PUT is validated as a whole and applied in one transaction: either every key changes or none.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(BearerAuthGuard)
@RequireRoles('ADMIN', 'SUPER_ADMIN')
@Controller('admin')
export class FeaturesController {
  constructor(
    private readonly features: FeatureService,
    private readonly admin: FeatureAdminUseCase,
    private readonly txm: TransactionManager,
  ) {}

  @Get('features')
  async getGlobal() {
    return serialize(await this.features.computeGlobal());
  }

  @Put('features')
  async putGlobal(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(globalPut)) body: z.infer<typeof globalPut>,
  ) {
    for (const { key, ...patch } of body.features) this.admin.validateGlobal(key, patch);
    await this.txm.run(async () => {
      for (const { key, ...patch } of body.features) await this.admin.setGlobal(actor, key, patch);
    });
    return serialize(await this.features.computeGlobal());
  }

  @Get('teachers/:id/features')
  async getTeacher(@Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    await this.admin.assertTeacher(id);
    return serialize(await this.features.compute(id));
  }

  @Put('teachers/:id/features')
  async putTeacher(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(teacherPut)) body: z.infer<typeof teacherPut>,
  ) {
    for (const { key, ...patch } of body.features) this.admin.validateTeacher(key, patch);
    const resolved = await this.txm.run(async () => {
      let last: ResolvedFeatures | undefined;
      for (const { key, ...patch } of body.features)
        last = await this.admin.setTeacher(actor, id, key, patch);
      return last;
    });
    return serialize(resolved ?? (await this.features.compute(id)));
  }
}
