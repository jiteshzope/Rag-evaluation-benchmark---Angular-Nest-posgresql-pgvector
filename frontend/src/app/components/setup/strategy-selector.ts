import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { StrategyDescriptor, StrategyId } from '../../api/types';
import { STRATEGY_COLOR } from '../../lib/format';
import { StepSection } from './step-section';

/**
 * Strategy picker. Multi-select up to the server's cap, because the whole point
 * of the app is comparing strategies against each other on identical inputs.
 */
@Component({
  selector: 'app-strategy-selector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StepSection],
  templateUrl: './strategy-selector.html',
})
export class StrategySelector {
  readonly strategies = input.required<StrategyDescriptor[]>();
  readonly selected = input.required<StrategyId[]>();
  readonly max = input.required<number>();
  readonly toggle = output<StrategyId>();

  protected readonly atCap = computed(() => this.selected().length >= this.max());
  protected readonly hint = computed(
    () => `Pick up to ${this.max()} to benchmark side by side on identical inputs.`,
  );

  protected isSelected(id: StrategyId): boolean {
    return this.selected().includes(id);
  }

  protected isDisabled(id: StrategyId): boolean {
    return !this.isSelected(id) && this.atCap();
  }

  protected color(id: StrategyId): string {
    return STRATEGY_COLOR[id];
  }
}
