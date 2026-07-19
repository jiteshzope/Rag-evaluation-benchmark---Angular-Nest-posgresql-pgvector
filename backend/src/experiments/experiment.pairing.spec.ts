import { BadRequestException } from '@nestjs/common';
import { Subject } from 'rxjs';

import { EvaluationItem } from '../common/types';
import { ExperimentService } from './experiment.service';
import { EvaluationEvent, ExperimentContext, KnowledgeBaseSource } from './experiment.types';

/**
 * The demo corpus and the demo question set are one pairing, and the server is
 * what enforces it — the UI only greys the buttons out. These cover the rule
 * from both directions, plus what happens when the corpus changes underneath a
 * dataset that was already loaded.
 */

const QA_ITEMS: EvaluationItem[] = Array.from({ length: 150 }, (_, i) => ({
  id: `q${i + 1}`,
  question: `Question ${i + 1}?`,
  referenceAnswer: `Answer ${i + 1}`,
  expectedKeywords: ['keyword'],
  questionType: 'direct_fact',
  goldChunkIds: [],
}));

function makeExperiment(kbSource: KnowledgeBaseSource | null): ExperimentContext {
  return {
    id: 'exp-1',
    createdAt: Date.now(),
    lastTouchedAt: Date.now(),
    status: 'created',
    strategies: ['baseline'],
    documents: kbSource ? [{ id: 'd1', title: 'doc', category: 'x', text: 'text' }] : [],
    knowledgeBase: kbSource
      ? {
          source: kbSource,
          label: kbSource === 'default' ? 'demo' : 'upload.md',
          documentCount: 1,
          totalChars: 100,
          originalChars: 100,
          trimmed: false,
          categories: [],
          preEmbedded: kbSource === 'default',
        }
      : null,
    dataset: [],
    datasetInfo: null,
    results: new Map(),
    summaries: new Map(),
    events: new Subject<EvaluationEvent>(),
    eventLog: [],
    cancelled: false,
  };
}

/** ExperimentService with only the collaborators these paths actually touch. */
function makeService(): ExperimentService {
  const defaultCorpus = {
    getQaSet: () => ({ items: QA_ITEMS, byType: [] }),
    sampleQuestions: (n: number) => QA_ITEMS.slice(0, n),
    getCorpus: () => ({
      documents: [{ id: 'd1', title: 'demo', category: 'company', text: 'demo text' }],
      totalChars: 9,
      fingerprint: 'abc',
      categories: [{ name: 'company', documents: 1 }],
    }),
  };
  const parser = {
    parseUpload: async () => ({
      documents: [{ id: 'u1', title: 'upload.md', category: 'uploaded', text: 'uploaded text' }],
      keptChars: 13,
      originalChars: 13,
      trimmed: false,
      notice: undefined,
    }),
  };
  const pgvector = { isAvailable: async () => true };

  return new ExperimentService(
    {} as never,
    defaultCorpus as never,
    parser as never,
    {} as never,
    {} as never,
    {} as never,
    pgvector as never,
  );
}

describe('default corpus / default question set pairing', () => {
  it('rejects the demo question set on an uploaded corpus', () => {
    const service = makeService();
    const experiment = makeExperiment('upload');

    expect(() => service.applyDefaultDataset(experiment, 10)).toThrow(BadRequestException);
    expect(experiment.datasetInfo).toBeNull();
  });

  it('rejects the demo question set when no corpus is chosen yet', () => {
    const service = makeService();
    const experiment = makeExperiment(null);

    expect(() => service.applyDefaultDataset(experiment, 10)).toThrow(BadRequestException);
  });

  it('accepts the demo question set on the demo corpus', () => {
    const service = makeService();
    const experiment = makeExperiment('default');

    const info = service.applyDefaultDataset(experiment, 10);

    expect(info.source).toBe('default');
    expect(info.questionCount).toBe(10);
    expect(info.available).toBe(150);
    // Sampling 10 of 150 is the user's choice, not a cap.
    expect(info.truncated).toBe(false);
  });

  it('clamps a request above the per-run question limit and flags it', () => {
    const service = makeService();
    const experiment = makeExperiment('default');

    const info = service.applyDefaultDataset(experiment, 500);

    expect(info.questionCount).toBe(100);
    expect(info.truncated).toBe(true);
  });

  it.each(['upload', 'paste'] as const)('rejects a %s dataset on the demo corpus', (source) => {
    const service = makeService();
    const experiment = makeExperiment('default');

    expect(() => service.setDataset(experiment, '[]', source)).toThrow(BadRequestException);
  });

  it('rejects generation on the demo corpus', async () => {
    const service = makeService();
    const experiment = makeExperiment('default');

    await expect(service.generateDataset(experiment, 5)).rejects.toThrow(BadRequestException);
  });

  it('accepts a pasted dataset on an uploaded corpus', () => {
    const service = makeService();
    const experiment = makeExperiment('upload');

    const info = service.setDataset(
      experiment,
      JSON.stringify([{ question: 'Q?', reference_answer: 'A', keywords: ['k'] }]),
      'paste',
    );

    expect(info.source).toBe('paste');
    expect(info.questionCount).toBe(1);
  });
});

describe('changing the corpus under a loaded dataset', () => {
  it('drops the demo questions when the corpus becomes an upload', async () => {
    const service = makeService();
    const experiment = makeExperiment('default');
    service.applyDefaultDataset(experiment, 10);
    expect(experiment.dataset).toHaveLength(10);

    await service.setUploadedKnowledgeBase(experiment, {
      originalname: 'upload.md',
      mimetype: 'text/markdown',
      buffer: Buffer.from('uploaded text'),
    });

    expect(experiment.datasetInfo).toBeNull();
    expect(experiment.dataset).toHaveLength(0);
  });

  it('drops uploaded questions when the corpus becomes the demo one', async () => {
    const service = makeService();
    const experiment = makeExperiment('upload');
    service.setDataset(
      experiment,
      JSON.stringify([{ question: 'Q?', reference_answer: 'A', keywords: ['k'] }]),
      'paste',
    );
    expect(experiment.dataset).toHaveLength(1);

    await service.applyDefaultKnowledgeBase(experiment);

    expect(experiment.datasetInfo).toBeNull();
    expect(experiment.dataset).toHaveLength(0);
  });

  it('keeps the demo questions when the demo corpus is re-applied', async () => {
    const service = makeService();
    const experiment = makeExperiment('default');
    service.applyDefaultDataset(experiment, 10);

    await service.applyDefaultKnowledgeBase(experiment);

    expect(experiment.dataset).toHaveLength(10);
  });
});

/**
 * The experiment is created on the first setup action, so its strategy list is
 * a snapshot of that moment. Ticking a different box afterwards has to be able
 * to reach the server — otherwise the run either benchmarks something the user
 * is no longer looking at, or is refused for a change they were invited to make.
 */
describe('changing the strategy selection after setup', () => {
  it('replaces the selection', () => {
    const service = makeService();
    const experiment = makeExperiment('default');

    const out = service.setStrategies(experiment, ['graphrag', 'advanced-pro']);

    expect(out).toEqual(['graphrag', 'advanced-pro']);
    expect(experiment.strategies).toEqual(['graphrag', 'advanced-pro']);
  });

  it('drops duplicates', () => {
    const service = makeService();
    const experiment = makeExperiment('default');

    expect(service.setStrategies(experiment, ['baseline', 'baseline'])).toEqual(['baseline']);
  });

  it('discards results belonging to the previous selection', () => {
    const service = makeService();
    const experiment = makeExperiment('default');
    experiment.results.set('baseline', []);
    experiment.summaries.set('baseline', {} as never);

    service.setStrategies(experiment, ['graphrag']);

    expect(experiment.results.size).toBe(0);
    expect(experiment.summaries.size).toBe(0);
  });

  it('refuses while a run is in flight, and says what to do', () => {
    const service = makeService();
    const experiment = makeExperiment('default');
    experiment.status = 'evaluating';

    expect(() => service.setStrategies(experiment, ['graphrag'])).toThrow(/already running/i);
    expect(() => service.setStrategies(experiment, ['graphrag'])).toThrow(/cancel/i);
    expect(experiment.strategies).toEqual(['baseline']);
  });
});

describe('run preconditions', () => {
  it('refuses a run with no corpus', () => {
    const service = makeService();
    expect(() => service.assertRunnable(makeExperiment(null))).toThrow(
      /Add a knowledge base/,
    );
  });

  it('refuses a run with no questions', () => {
    const service = makeService();
    expect(() => service.assertRunnable(makeExperiment('default'))).toThrow(
      /Add an evaluation dataset/,
    );
  });

  it('accepts a fully configured experiment without starting anything', () => {
    const service = makeService();
    const experiment = makeExperiment('default');
    service.applyDefaultDataset(experiment, 5);
    const statusBefore = experiment.status;

    expect(() => service.assertRunnable(experiment)).not.toThrow();
    // A check must stay a check — the controller calls it before charging the
    // quota, so it must not mark the experiment as started.
    expect(experiment.status).toBe(statusBefore);
    expect(experiment.status).not.toBe('evaluating');
  });
});
