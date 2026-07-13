import { Injectable, NotFoundException } from '@nestjs/common';

import { ALL_STRATEGIES, StrategyId } from '../common/types';
import { RagStrategy } from './rag-strategy.interface';
import { BaselineRagService } from './baseline/baseline-rag.service';
import { AdvancedRagService } from './advanced/advanced-rag.service';
import { AdvancedProRagService } from './advanced-pro/advanced-pro-rag.service';
import { GraphRagService } from './graph/graph-rag.service';

export interface StrategyDescriptor {
  id: StrategyId;
  label: string;
  description: string;
  capabilities: string[];
  chunkProfile: string;
}

/**
 * Resolves a strategy id to its implementation. The evaluation orchestrator
 * depends only on this and the `RagStrategy` interface, so adding a fifth
 * strategy means adding one service and one case here.
 */
@Injectable()
export class RagStrategyFactory {
  private readonly registry: Map<StrategyId, RagStrategy>;

  constructor(
    baseline: BaselineRagService,
    advanced: AdvancedRagService,
    advancedPro: AdvancedProRagService,
    graphRag: GraphRagService,
  ) {
    this.registry = new Map<StrategyId, RagStrategy>([
      ['baseline', baseline],
      ['advanced', advanced],
      ['advanced-pro', advancedPro],
      ['graphrag', graphRag],
    ]);
  }

  get(id: StrategyId): RagStrategy {
    const strategy = this.registry.get(id);
    if (!strategy) {
      throw new NotFoundException(
        `Unknown RAG strategy "${id}". Valid strategies: ${ALL_STRATEGIES.join(', ')}.`,
      );
    }
    return strategy;
  }

  /** Metadata for the strategy cards on the setup screen. */
  describeAll(): StrategyDescriptor[] {
    return ALL_STRATEGIES.map((id) => {
      const s = this.get(id);
      return {
        id: s.id,
        label: s.label,
        description: s.description,
        capabilities: s.capabilities,
        chunkProfile: s.chunkProfile,
      };
    });
  }
}
