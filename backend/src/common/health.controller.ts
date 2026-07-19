import { Controller, Get } from '@nestjs/common';

import { PgVectorService } from '../vector-store/pgvector.service';
import { ExperimentStore } from '../experiments/experiment.store';

@Controller()
export class HealthController {
  constructor(
    private readonly pgvector: PgVectorService,
    private readonly store: ExperimentStore,
  ) {}

  @Get('health')
  async health() {
    return {
      status: 'ok',
      pgvector: await this.pgvector.isAvailable(),
      liveExperiments: this.store.liveCount,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }
}
