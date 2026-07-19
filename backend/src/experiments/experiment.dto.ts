import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { ALL_STRATEGIES, StrategyId } from '../common/types';
import {
  MAX_GENERATED_QUESTIONS,
  MAX_KB_CHARS,
  MAX_QUESTIONS,
  MAX_STRATEGIES_PER_RUN,
} from '../config/limits';

export class CreateExperimentDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Select at least one RAG strategy.' })
  @ArrayMaxSize(MAX_STRATEGIES_PER_RUN, {
    message:
      `A single run can benchmark at most ${MAX_STRATEGIES_PER_RUN} strategies. ` +
      `Each strategy re-runs every question through retrieval, an answering LLM and a judge, ` +
      `so this cap keeps a demo run affordable.`,
  })
  @IsIn(ALL_STRATEGIES, { each: true, message: 'Unknown strategy.' })
  strategies!: StrategyId[];

  /** Use the shipped, pre-embedded knowledge base and question set. */
  @IsOptional()
  @IsBoolean()
  useDefaultKnowledgeBase?: boolean;

  @IsOptional()
  @IsBoolean()
  useDefaultDataset?: boolean;

  /** How many questions to run. Capped at MAX_QUESTIONS server-side. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_QUESTIONS)
  questionCount?: number;
}

/**
 * Strategy selection, changeable for as long as the run has not started.
 *
 * The experiment is created on the first setup action, so its strategy list is
 * whatever was selected at that moment. Ticking a different box afterwards has
 * to reach the server, or the run would benchmark a set the user no longer sees.
 */
export class UpdateStrategiesDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Select at least one RAG strategy.' })
  @ArrayMaxSize(MAX_STRATEGIES_PER_RUN, {
    message:
      `A single run can benchmark at most ${MAX_STRATEGIES_PER_RUN} strategies. ` +
      `Each strategy re-runs every question through retrieval, an answering LLM and a judge, ` +
      `so this cap keeps a demo run affordable.`,
  })
  @IsIn(ALL_STRATEGIES, { each: true, message: 'Unknown strategy.' })
  strategies!: StrategyId[];
}

export class SetDatasetDto {
  @IsString()
  @MinLength(2, {
    message:
      'The evaluation dataset is empty. Provide questions as a JSON array, as JSONL ' +
      '(one object per line), or as CSV with a header row.',
  })
  @MaxLength(2_000_000, {
    message:
      'This dataset is over the 2,000,000 character limit. Trim it, or upload it as a file ' +
      `instead — a run uses at most ${MAX_QUESTIONS} questions either way.`,
  })
  content!: string;
}

export class GenerateDatasetDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_GENERATED_QUESTIONS)
  count?: number;
}

export class SetKnowledgeBaseTextDto {
  @IsString()
  @MinLength(200, { message: 'Provide at least 200 characters of knowledge base text.' })
  @MaxLength(MAX_KB_CHARS * 2)
  text!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;
}
