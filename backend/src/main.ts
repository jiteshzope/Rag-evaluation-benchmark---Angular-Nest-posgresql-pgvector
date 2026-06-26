import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { AppConfig, buildOriginMatcher } from './config/app-config';
import { MAX_FILE_SIZE_BYTES } from './config/limits';
import { HttpExceptionFilter } from './common/http-exception.filter';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const config = app.get(AppConfig);

  const allowedOrigins = config.corsOrigins;
  const isAllowedOrigin = buildOriginMatcher(allowedOrigins);

  app.enableCors({
    // A callback rather than a list, so CORS_ORIGIN entries can use wildcards
    // for Vercel's per-deployment preview hostnames.
    origin(origin, callback) {
      // No Origin header: same-origin navigations, curl, health checks.
      if (!origin) return callback(null, true);
      if (isAllowedOrigin(origin)) return callback(null, true);

      logger.warn(`Blocked a cross-origin request from ${origin}`);
      // Reject by omitting the header rather than erroring — the browser then
      // reports a normal CORS failure instead of the API returning a 500.
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    credentials: false,
  });

  // Needed for per-IP quotas to be correct behind a reverse proxy.
  app.set('trust proxy', 1);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());

  // The multipart limit is enforced by Multer per route; this bounds JSON and
  // urlencoded bodies (pasted datasets and knowledge base text).
  app.useBodyParser('json', { limit: '4mb' });
  app.useBodyParser('urlencoded', { limit: '4mb', extended: true });

  const port = config.port;
  await app.listen(port, '0.0.0.0');

  logger.log(`RAG Evaluation Benchmark API listening on http://localhost:${port}`);
  logger.log(`Models: answer=${config.answerModel}, judge=${config.judgeModel}, embed=${config.embeddingModel}`);
  logger.log(`Upload limit: ${(MAX_FILE_SIZE_BYTES / 1024).toFixed(0)} KB`);
  logger.log(`CORS allows: ${allowedOrigins.join(', ')}`);
}

void bootstrap();
