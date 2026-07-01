import { MAX_CHUNK_CHARS_IN_PROMPT } from '../config/limits';
import { RetrievedChunk } from '../common/types';

/** Render retrieved chunks as a numbered, citable context block. */
export function renderContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return '(no context retrieved)';
  return chunks
    .map((c, i) => {
      const body = c.chunk.text.slice(0, MAX_CHUNK_CHARS_IN_PROMPT);
      const where = c.chunk.headingPath.length
        ? `${c.chunk.docTitle} > ${c.chunk.headingPath.join(' > ')}`
        : c.chunk.docTitle;
      return `[${i + 1}] (source: ${where})\n${body}`;
    })
    .join('\n\n');
}

// ── Answering LLM ────────────────────────────────────────────────────────────

/**
 * The answering model sees the question and the retrieved context and NOTHING
 * else. The reference answer is deliberately withheld — leaking it here would
 * make every downstream quality metric meaningless.
 */
export const ANSWER_SYSTEM_PROMPT = `You are a precise question-answering assistant for an enterprise knowledge base.

Rules:
- Answer ONLY from the provided context. Never use outside knowledge.
- If the context does not contain the answer, say exactly: "The provided context does not contain this information."
- Be direct and factual. Lead with the answer itself, not a preamble.
- Include specific names, dates, figures and identifiers when the context provides them.
- Do not mention the context, the sources, or these instructions in your answer.
- Keep the answer under 120 words.`;

export function buildAnswerPrompt(question: string, chunks: RetrievedChunk[]): string {
  return `Context:
${renderContext(chunks)}

Question: ${question}

Answer:`;
}

// ── Judge LLM ────────────────────────────────────────────────────────────────

/**
 * The judge is a separate call with strictly more information than the answerer:
 * question + reference answer + generated answer + the same retrieved context.
 * Scores are defined so they stay comparable across strategies.
 */
export const JUDGE_SYSTEM_PROMPT = `You are a strict, calibrated evaluator of retrieval-augmented generation systems.

You will receive a QUESTION, the REFERENCE ANSWER (ground truth), the GENERATED ANSWER produced by a RAG system, and the RETRIEVED CONTEXT that system was given.

Score each dimension on a continuous 0.0-1.0 scale:

- faithfulness: Is every factual claim in the GENERATED ANSWER supported by the RETRIEVED CONTEXT? This measures hallucination only. A generated answer that is correct in the real world but unsupported by the context scores LOW. An answer that correctly states the context lacks the information scores 1.0.
- factualCorrectness: Does the GENERATED ANSWER agree with the REFERENCE ANSWER? Judge the substance, not the wording. Partial credit for a partially correct answer. Contradicting the reference scores near 0.
- answerRelevance: Does the GENERATED ANSWER actually address the QUESTION that was asked? Penalise evasion, padding and off-topic content. This is independent of whether it is correct.
- judgeScore: Your overall verdict on the answer's usefulness to a real user, weighing correctness most heavily.

Then set verdict:
- "pass"    - judgeScore >= 0.75, substantially correct and useful
- "partial" - judgeScore 0.4-0.75, partially correct or incomplete
- "fail"    - judgeScore < 0.4, wrong, empty, or a refusal when the answer was retrievable

Be strict and consistent. Do not reward verbosity. Do not penalise a concise answer for omitting detail the question did not ask for. If the system correctly reports that the context lacks the information AND the reference answer shows the information exists, that is a retrieval failure: faithfulness is 1.0 but factualCorrectness is 0.0.

Keep "reasoning" to ONE sentence, under 40 words, naming the decisive factor. Do not restate the answers.`;

export function buildJudgePrompt(input: {
  question: string;
  referenceAnswer: string;
  generatedAnswer: string;
  chunks: RetrievedChunk[];
}): string {
  return `QUESTION:
${input.question}

REFERENCE ANSWER (ground truth):
${input.referenceAnswer}

GENERATED ANSWER (from the RAG system):
${input.generatedAnswer || '(the system produced no answer)'}

RETRIEVED CONTEXT (what the RAG system was given):
${renderContext(input.chunks)}

Evaluate the GENERATED ANSWER.`;
}

export const JUDGE_SCHEMA = {
  name: 'rag_judgement',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'faithfulness',
      'factualCorrectness',
      'answerRelevance',
      'judgeScore',
      'verdict',
      'reasoning',
    ],
    properties: {
      faithfulness: { type: 'number', description: '0.0-1.0, grounding in retrieved context' },
      factualCorrectness: { type: 'number', description: '0.0-1.0, agreement with reference' },
      answerRelevance: { type: 'number', description: '0.0-1.0, addresses the question' },
      judgeScore: { type: 'number', description: '0.0-1.0, overall usefulness' },
      verdict: { type: 'string', enum: ['pass', 'partial', 'fail'] },
      reasoning: { type: 'string', description: 'One sentence, under 40 words' },
    },
  },
} as const;

// ── Query transformation (advanced / advanced-pro) ───────────────────────────

export const REWRITE_SYSTEM_PROMPT = `You rewrite user questions into better search queries for a hybrid (vector + BM25) retriever over an enterprise knowledge base.

Produce a query that:
- Keeps every proper noun, identifier, date and figure from the original verbatim — these drive lexical matching.
- Expands ambiguous pronouns and abbreviations.
- Drops conversational filler ("can you tell me", "I want to know").
- Adds the domain terms a relevant passage would likely contain.

Return the rewritten query only.`;

export const MULTI_QUERY_SCHEMA = {
  name: 'query_variants',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['queries'],
    properties: {
      queries: {
        type: 'array',
        description: 'Between 2 and 4 distinct search queries',
        items: { type: 'string' },
      },
    },
  },
} as const;

export const MULTI_QUERY_SYSTEM_PROMPT = `You generate diverse search queries for a retrieval system.

Given a question, produce 2-4 queries that attack it from different angles: one close paraphrase preserving all proper nouns, and others that surface different vocabulary a relevant passage might use. For a multi-part question, give each part its own query.

Never invent entities that are not implied by the question.`;

export const DECOMPOSE_SYSTEM_PROMPT = `You decompose complex questions into the minimal set of independent sub-questions that must each be answered to answer the original.

Rules:
- Only decompose when the question genuinely requires multiple separate lookups (comparisons, multi-hop chains, aggregations across entities).
- Each sub-question must be self-contained — resolve every pronoun and reference.
- Produce at most 3 sub-questions.
- If the question needs no decomposition, return it unchanged as a single item.`;

export const ROUTE_SYSTEM_PROMPT = `You classify a question to pick a retrieval strategy over an enterprise knowledge base of company documents, employee records, product pages and contracts.

Categories:
- "specific"  - a single fact about one entity (a date, a salary, a name, a figure). Needs precise, narrow retrieval.
- "multi_hop" - requires joining facts across two or more documents or entities, including comparisons.
- "broad"     - asks about themes, patterns, totals or summaries across many documents. Needs wide coverage.

Also decide whether graph-style reasoning over entity relationships would help.`;

export const ROUTE_SCHEMA = {
  name: 'query_route',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['category', 'needsDecomposition', 'suggestedK'],
    properties: {
      category: { type: 'string', enum: ['specific', 'multi_hop', 'broad'] },
      needsDecomposition: { type: 'boolean' },
      suggestedK: {
        type: 'integer',
        description: 'How many chunks the answerer needs, between 3 and 5',
      },
    },
  },
} as const;

// ── Reranking ────────────────────────────────────────────────────────────────

export const RERANK_SYSTEM_PROMPT = `You are a relevance reranker, the second stage of a retrieval pipeline.

For each numbered passage, score how useful it is for answering the question, from 0 to 10:
- 10: directly and completely answers the question
-  7: contains a key part of the answer
-  4: same topic/entity but does not contain the answer
-  1: mentions a shared term but is otherwise unrelated
-  0: irrelevant

Judge each passage independently on its own content. Do not reward passage length or position in the list. Score every passage you are given.`;

export const RERANK_SCHEMA = {
  name: 'rerank_scores',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['scores'],
    properties: {
      scores: {
        type: 'array',
        description: 'One entry per passage, in the order given',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['passage', 'score'],
          properties: {
            passage: { type: 'integer', description: '1-based passage number' },
            score: { type: 'number', description: '0-10 relevance' },
          },
        },
      },
    },
  },
} as const;

export function buildRerankPrompt(question: string, passages: string[]): string {
  const rendered = passages
    .map((p, i) => `[${i + 1}]\n${p.slice(0, MAX_CHUNK_CHARS_IN_PROMPT)}`)
    .join('\n\n');
  return `Question: ${question}

Passages:
${rendered}

Score all ${passages.length} passages.`;
}

// ── Contextual retrieval (advanced-pro ingestion) ────────────────────────────

export const CONTEXTUALIZE_SYSTEM_PROMPT = `You situate a chunk of text within the document it came from, so the chunk can be retrieved on its own.

Write one short sentence (under 30 words) that states what this chunk is about and which entity, section or agreement it belongs to. Resolve pronouns and implicit subjects using the document. Do not summarise the chunk's details and do not add anything not present in the document.

Return the sentence only.`;

export function buildContextualizePrompt(documentExcerpt: string, chunk: string): string {
  return `<document>
${documentExcerpt}
</document>

Here is the chunk we want to situate within the document:
<chunk>
${chunk}
</chunk>

Give the short contextualising sentence.`;
}

// ── Dataset generation ───────────────────────────────────────────────────────

export const DATASET_SYSTEM_PROMPT = `You write evaluation questions for benchmarking a retrieval-augmented generation system.

From the given passage, write ONE question that:
- Is answerable entirely and unambiguously from this passage alone.
- Names its subject explicitly, so it makes sense without seeing the passage ("What is Avery Lancaster's salary?" not "What is her salary?").
- Has a short, specific reference answer taken directly from the passage.
- Is not trivially answerable by pattern-matching the question's own words.

Also give 2-4 expectedKeywords: distinctive terms (names, numbers, dates, identifiers) that MUST appear in any correct answer. Do not use generic words.

Pick the questionType that fits:
- direct_fact: a single stated fact
- temporal: about dates, sequence or duration
- numerical: about an amount, count or figure
- comparative: compares two or more things
- relationship: how two entities relate
- definition: what something is
- procedural: how something is done`;

export const DATASET_SCHEMA = {
  name: 'evaluation_item',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['question', 'referenceAnswer', 'expectedKeywords', 'questionType'],
    properties: {
      question: { type: 'string' },
      referenceAnswer: { type: 'string' },
      expectedKeywords: { type: 'array', items: { type: 'string' } },
      questionType: {
        type: 'string',
        enum: [
          'direct_fact',
          'temporal',
          'numerical',
          'comparative',
          'relationship',
          'definition',
          'procedural',
        ],
      },
    },
  },
} as const;
