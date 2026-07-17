import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { AppConfig } from '../config/app-config';
import { EvaluationItem, QuestionType, SourceDocument } from '../common/types';
import { cleanExtractedText } from '../ingestion/text-utils';
import { asStringArray, normalizeQuestionType } from './dataset-parser';

export interface DefaultCorpus {
  documents: SourceDocument[];
  totalChars: number;
  fingerprint: string;
  categories: Array<{ name: string; documents: number }>;
}

export interface DefaultQaSet {
  items: EvaluationItem[];
  byType: Array<{ questionType: QuestionType; count: number }>;
}

/**
 * Loads the shipped demo corpus and question set from disk.
 *
 * Loaded once at boot and held in memory — it is ~310 KB of markdown and never
 * changes at run time, so re-reading it per request would be pure overhead.
 */
@Injectable()
export class DefaultCorpusService implements OnModuleInit {
  private readonly logger = new Logger(DefaultCorpusService.name);

  private corpus: DefaultCorpus | null = null;
  private qaSet: DefaultQaSet | null = null;

  constructor(private readonly config: AppConfig) {}

  onModuleInit(): void {
    try {
      this.getCorpus();
      this.getQaSet();
    } catch (err) {
      this.logger.error(`Failed to load the default corpus: ${(err as Error).message}`);
    }
  }

  getCorpus(): DefaultCorpus {
    if (this.corpus) return this.corpus;

    const root = this.config.defaultKbDir;
    if (!fs.existsSync(root)) {
      throw new Error(`Default knowledge base directory not found: ${root}`);
    }

    const documents: SourceDocument[] = [];
    for (const file of walk(root)) {
      if (!/\.(md|txt)$/i.test(file)) continue;
      const relative = path.relative(root, file).split(path.sep).join('/');
      const category = relative.includes('/') ? relative.split('/')[0] : 'root';
      const text = cleanExtractedText(fs.readFileSync(file, 'utf8'));
      if (!text) continue;

      documents.push({
        // Stable, path-derived id so chunk ids stay identical across seed runs.
        id: `kb_${crypto.createHash('sha1').update(relative).digest('hex').slice(0, 12)}`,
        title: relative,
        category,
        text,
      });
    }

    documents.sort((a, b) => a.title.localeCompare(b.title));

    const totalChars = documents.reduce((sum, d) => sum + d.text.length, 0);
    const fingerprint = crypto
      .createHash('sha256')
      .update(documents.map((d) => `${d.title}:${d.text.length}`).join('|'))
      .digest('hex')
      .slice(0, 16);

    const counts = new Map<string, number>();
    for (const d of documents) counts.set(d.category, (counts.get(d.category) ?? 0) + 1);

    this.corpus = {
      documents,
      totalChars,
      fingerprint,
      categories: [...counts.entries()]
        .map(([name, docs]) => ({ name, documents: docs }))
        .sort((a, b) => b.documents - a.documents),
    };

    this.logger.log(
      `Default corpus loaded: ${documents.length} documents, ${totalChars.toLocaleString()} chars, ` +
        `fingerprint ${fingerprint}`,
    );

    return this.corpus;
  }

  getQaSet(): DefaultQaSet {
    if (this.qaSet) return this.qaSet;

    const file = this.config.defaultQaSetPath;
    if (!fs.existsSync(file)) {
      throw new Error(`Default question/answer set not found: ${file}`);
    }

    const items: EvaluationItem[] = [];
    const lines = fs.readFileSync(file, 'utf8').split('\n');

    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const row = JSON.parse(trimmed) as Record<string, unknown>;
        const question = String(row.question ?? '').trim();
        const referenceAnswer = String(row.reference_answer ?? '').trim();
        if (!question || !referenceAnswer) return;

        items.push({
          id: `default-${i + 1}`,
          question: alignCorpusNaming(question),
          referenceAnswer: alignCorpusNaming(referenceAnswer),
          expectedKeywords: asStringArray(row.keywords).map(alignCorpusNaming),
          questionType: normalizeQuestionType(String(row.category ?? '')),
        });
      } catch {
        this.logger.warn(`Skipping malformed QA line ${i + 1}`);
      }
    });

    const counts = new Map<QuestionType, number>();
    for (const item of items) {
      counts.set(item.questionType, (counts.get(item.questionType) ?? 0) + 1);
    }

    this.qaSet = {
      items,
      byType: [...counts.entries()]
        .map(([questionType, count]) => ({ questionType, count }))
        .sort((a, b) => b.count - a.count),
    };

    this.logger.log(`Default QA set loaded: ${items.length} questions`);
    return this.qaSet;
  }

  /**
   * Deterministic stratified sample of `count` questions, preserving the
   * question-type mix of the full set.
   *
   * Stratification matters: the by-question-type charts are the most
   * interesting output of the whole benchmark, and a naive `slice(0, 20)` on a
   * file grouped by category would return 20 direct_fact questions and leave
   * every other bar empty.
   */
  sampleQuestions(count: number): EvaluationItem[] {
    const all = this.getQaSet().items;
    if (count >= all.length) return all;

    const byType = new Map<QuestionType, EvaluationItem[]>();
    for (const item of all) {
      const list = byType.get(item.questionType) ?? [];
      list.push(item);
      byType.set(item.questionType, list);
    }

    // Largest groups first so rounding leftovers land where there is most to
    // draw from, then round-robin until the quota is met.
    const groups = [...byType.entries()].sort((a, b) => b[1].length - a[1].length);
    const picked: EvaluationItem[] = [];
    const cursors = new Map<QuestionType, number>();

    while (picked.length < count) {
      let addedThisRound = false;
      for (const [type, list] of groups) {
        if (picked.length >= count) break;
        const cursor = cursors.get(type) ?? 0;
        if (cursor >= list.length) continue;
        picked.push(list[cursor]);
        cursors.set(type, cursor + 1);
        addedThisRound = true;
      }
      if (!addedThisRound) break;
    }

    // Restore the original file order so the results table reads naturally.
    const order = new Map(all.map((item, i) => [item.id, i]));
    return picked.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }
}

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * The shipped question set was written against an earlier name for the fictional
 * company ("Insurellm"); the knowledge base now calls it "Assurio". Left alone,
 * the judge would mark factually correct answers wrong for using the name that
 * actually appears in the corpus.
 *
 * The mismatch is confined to prose in questions and reference answers — no
 * expected keyword contains it — so this rename is a pure data fix and does not
 * touch what is being measured.
 */
export function alignCorpusNaming(text: string): string {
  return text.replace(/Insurellm/gi, (match) =>
    match === match.toUpperCase() ? 'ASSURIO' : match[0] === match[0].toUpperCase() ? 'Assurio' : 'assurio',
  );
}
