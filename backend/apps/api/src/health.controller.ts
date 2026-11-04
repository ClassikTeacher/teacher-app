import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Clock } from '@shared/time/index.js';

@ApiTags('system')
@Controller('health')
export class HealthController {
  constructor(private readonly clock: Clock) {}

  @Get()
  health(): { status: 'ok'; time: string } {
    return { status: 'ok', time: this.clock.now().toISOString() };
  }
}
