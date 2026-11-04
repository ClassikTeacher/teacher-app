import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Paged } from '@shared/http/envelope.js';
import { ZodValidationPipe } from '@shared/http/zod-validation.pipe.js';
import { BearerAuthGuard, RequireRoles } from '@modules/access/http/bearer-auth.guard.js';
import { AuditService } from '@modules/audit/audit.service.js';

const query = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    actorId: z.string().uuid().optional(),
    entityType: z.string().min(1).max(40).optional(),
    entityId: z.string().uuid().optional(),
    action: z.string().min(1).max(60).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine((q) => !q.from || !q.to || q.from < q.to, { message: 'from must be before to', path: ['from'] });

/** 9.2 Admin: `GET /admin/audit` — append-only trail, readable by admins (5.15). */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(BearerAuthGuard)
@RequireRoles('ADMIN', 'SUPER_ADMIN')
@Controller('admin')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('audit')
  async list(@Query(new ZodValidationPipe(query)) q: z.infer<typeof query>) {
    const { items, total } = await this.audit.query(q);
    return new Paged(
      items.map((row) => ({
        id: row.id,
        at: row.at.toISOString(),
        actorId: row.actorId,
        actorRole: row.actorRole,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        before: row.before,
        after: row.after,
        source: row.source,
        correlationId: row.correlationId,
      })),
      { page: q.page, limit: q.limit, total },
    );
  }
}
