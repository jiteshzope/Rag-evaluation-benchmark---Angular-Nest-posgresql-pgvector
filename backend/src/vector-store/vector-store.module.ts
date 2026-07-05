import { Global, Module } from '@nestjs/common';

import { AppConfig } from '../config/app-config';
import { PgVectorService } from './pgvector.service';

/**
 * Global so the evaluation and experiment services can read the pre-embedded
 * default corpus without every feature module importing it.
 */
@Global()
@Module({
  providers: [AppConfig, PgVectorService],
  exports: [PgVectorService],
})
export class VectorStoreModule {}
