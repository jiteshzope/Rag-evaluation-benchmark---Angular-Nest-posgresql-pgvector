/** Prompts for the GraphRAG indexing and query pipelines. */

export const ENTITY_EXTRACTION_SYSTEM_PROMPT = `You build a knowledge graph from enterprise documents (company records, employee profiles, product pages, contracts).

From the given text, extract:

ENTITIES - the concrete, named things the text is about:
- name: the entity's name exactly as written in the text
- type: one of PERSON, ORGANIZATION, PRODUCT, CONTRACT, LOCATION, ROLE, EVENT, DATE, MONEY, CONCEPT
- description: a short phrase describing this entity (under 15 words), using only what the text states

RELATIONSHIPS - how those entities connect:
- source and target: names of two entities you extracted
- description: a short phrase stating how they relate (under 15 words), using only what the text states
- weight: 1-10, how strong and important the relationship is

Rules:
- Extract only entities that are explicitly named. Do not infer entities that are merely implied.
- Use the entity's full name, not a pronoun or partial reference.
- Every relationship's source and target must be in your entity list.
- Prefer fewer, high-quality extractions over many speculative ones.
- Extract at most 8 entities and 8 relationships from this text. Fewer, high-value extractions beat many shallow ones.`;

export const ENTITY_EXTRACTION_SCHEMA = {
  name: 'graph_extraction',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['entities', 'relationships'],
    properties: {
      entities: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'type', 'description'],
          properties: {
            name: { type: 'string' },
            type: {
              type: 'string',
              enum: [
                'PERSON',
                'ORGANIZATION',
                'PRODUCT',
                'CONTRACT',
                'LOCATION',
                'ROLE',
                'EVENT',
                'DATE',
                'MONEY',
                'CONCEPT',
              ],
            },
            description: { type: 'string' },
          },
        },
      },
      relationships: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['source', 'target', 'description', 'weight'],
          properties: {
            source: { type: 'string' },
            target: { type: 'string' },
            description: { type: 'string' },
            weight: { type: 'number' },
          },
        },
      },
    },
  },
} as const;

export const COMMUNITY_SUMMARY_SYSTEM_PROMPT = `You write a report about a community of related entities in a knowledge graph.

You are given the community's entities and the relationships between them. Write:
- title: a short, specific name for what this community is about (under 8 words)
- summary: 3-5 sentences covering what this group of entities is, how they relate, and what someone querying the corpus would want to know about them.

Use only the information given. Name the key entities explicitly so the summary is searchable. Do not speculate.`;

export const COMMUNITY_SUMMARY_SCHEMA = {
  name: 'community_report',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'summary'],
    properties: {
      title: { type: 'string' },
      summary: { type: 'string' },
    },
  },
} as const;

export function buildCommunitySummaryPrompt(input: {
  entities: Array<{ name: string; type: string; description: string }>;
  relationships: Array<{ source: string; target: string; description: string }>;
}): string {
  const entities = input.entities
    .map((e) => `- ${e.name} (${e.type}): ${e.description}`)
    .join('\n');
  const relationships = input.relationships
    .map((r) => `- ${r.source} -> ${r.target}: ${r.description}`)
    .join('\n');

  return `Entities:
${entities || '(none)'}

Relationships:
${relationships || '(none)'}

Write the community report.`;
}

/** Global search, map step: does this community help answer the question? */
export const GLOBAL_MAP_SYSTEM_PROMPT = `You assess whether a community report helps answer a question about a document corpus.

Extract only the points from the report that genuinely bear on the question. For each point give a "score" from 0-100 for how helpful it is. If the report contains nothing relevant, return an empty list rather than inventing a weak connection.`;

export const GLOBAL_MAP_SCHEMA = {
  name: 'map_points',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['points'],
    properties: {
      points: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['description', 'score'],
          properties: {
            description: { type: 'string' },
            score: { type: 'number' },
          },
        },
      },
    },
  },
} as const;

export function buildGlobalMapPrompt(question: string, report: string): string {
  return `Question: ${question}

Community report:
${report}

Extract the relevant points.`;
}
