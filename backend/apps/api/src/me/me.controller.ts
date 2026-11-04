import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '@shared/http/zod-validation.pipe.js';
import { type Actor } from '@modules/access/actor.js';
import { BearerAuthGuard, CurrentActor, RequireRoles } from '@modules/access/http/bearer-auth.guard.js';
import { type TeacherSettings, TeacherSettingsUseCase } from '@modules/people/teacher-settings.use-case.js';
import { uuidParam } from '../admin/admin.schemas.js';
import {
  type CreateTemplateDto,
  createTemplateSchema,
  type TemplateKindDto,
  templateKindSchema,
  type UpdateMeDto,
  updateMeSchema,
} from './me.schemas.js';

function view({ account, profile }: TeacherSettings) {
  return {
    id: account.id,
    firstName: account.firstName,
    lastName: account.lastName,
    username: account.username,
    timezone: account.timezone,
    locale: account.locale,
    subjectIds: profile.subjectIds,
    defaultDurationMin: profile.defaultDurationMin,
    bufferBeforeMin: profile.bufferBeforeMin,
    bufferAfterMin: profile.bufferAfterMin,
    calendarMode: profile.calendarMode,
    bookingConfirmation: profile.bookingConfirmation,
    lateCancelHours: profile.lateCancelHours,
    studentCancelCutoffHours: profile.studentCancelCutoffHours,
    studentCanCancel: profile.studentCanCancel,
    parentCanCancel: profile.parentCanCancel,
    defaultNoticeText: profile.defaultNoticeText,
  };
}

/** Teacher's own profile and settings (9.2 "Me"); the use-case re-checks the role and every value. */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(BearerAuthGuard)
@RequireRoles('TEACHER')
@Controller('me')
export class MeController {
  constructor(private readonly settings: TeacherSettingsUseCase) {}

  @Get()
  async get(@CurrentActor() actor: Actor) {
    return view(await this.settings.get(actor));
  }

  @Patch()
  async update(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(updateMeSchema)) body: UpdateMeDto) {
    return view(await this.settings.update(actor, body));
  }

  @Get('templates')
  async templates(
    @CurrentActor() actor: Actor,
    @Query('kind', new ZodValidationPipe(templateKindSchema)) kind: TemplateKindDto,
  ) {
    const rows = await this.settings.listTemplates(actor, kind);
    return rows.map((t) => ({ id: t.id, kind: t.kind, text: t.text, position: t.position }));
  }

  @Post('templates')
  async addTemplate(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createTemplateSchema)) body: CreateTemplateDto,
  ) {
    const t = await this.settings.addTemplate(actor, body.kind, body.text);
    return { id: t.id, kind: t.kind, text: t.text, position: t.position };
  }

  @Delete('templates/:id')
  @HttpCode(200)
  async removeTemplate(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
  ) {
    await this.settings.removeTemplate(actor, id);
    return { id, removed: true };
  }
}
