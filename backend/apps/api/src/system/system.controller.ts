import { Body, Controller, Delete, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ZodValidationPipe } from '@shared/http/zod-validation.pipe.js';
import { SystemKeyGuard } from '@modules/access/http/system-key.guard.js';
import { SuperAdminTransferUseCase } from '@modules/identity/super-admin-transfer.use-case.js';
import { uuidParam } from '../admin/admin.schemas.js';

const transferBody = z.object({
  toAccountId: z.string().uuid(),
  previousRole: z.enum(['ADMIN', 'NONE']).default('ADMIN'),
});

/** 5.3.4 / UC-02: `POST /system/super-admin/transfer` with `X-System-Key`; the new SA confirms in AuthBot. */
@ApiTags('system')
@ApiSecurity('system-key')
@UseGuards(SystemKeyGuard)
@Controller('system')
export class SystemController {
  constructor(private readonly transfer: SuperAdminTransferUseCase) {}

  @Post('super-admin/transfer')
  @HttpCode(202)
  async requestTransfer(
    @Req() request: FastifyRequest,
    @Body(new ZodValidationPipe(transferBody)) body: z.infer<typeof transferBody>,
  ) {
    const row = await this.transfer.request({ ...body, ip: request.ip });
    return {
      id: row.id,
      toAccountId: row.toAccountId,
      status: row.status,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  /** Withdraws a pending transfer (wrong target, compromised key): frees the single pending slot at once. */
  @Delete('super-admin/transfer/:id')
  @HttpCode(200)
  async cancelTransfer(
    @Req() request: FastifyRequest,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
  ) {
    const row = await this.transfer.cancel(id, { byAccountId: null, ip: request.ip });
    return { id: row.id, status: row.status };
  }
}
