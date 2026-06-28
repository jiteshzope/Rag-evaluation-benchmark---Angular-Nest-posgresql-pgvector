import { Injectable } from '@nestjs/common';

import { Chunk, SourceDocument } from '../common/types';
import { estimateTokens, hashId, splitSentences } from './text-utils';

/**
 * Chunking profile. This is the first real architectural difference between the
 * strategies — not a top-K tweak.
 *
 *  fixed       Baseline. Fixed token window with overlap, blind to structure.
 *  structural  Advanced. Respects markdown headings and paragraph boundaries,
 *              packs to a token budget, never straddles a section.
 *  contextual  Advanced-Pro. Structural chunking plus a context header that is
 *              embedded but not shown to the answering LLM (contextual
 *              retrieval), plus parent-window bookkeeping for expansion.
 */
export type ChunkProfile = 'fixed' | 'structural' | 'contextual';

export interface ChunkOptions {
  /** Target chunk size in estimated tokens. */
  targetTokens: number;
  /** Overlap in estimated tokens (fixed profile) or sentences (structural). */
  overlapTokens: number;
}

export const DEFAULT_CHUNK_OPTIONS: Record<ChunkProfile, ChunkOptions> = {
  fixed: { targetTokens: 200, overlapTokens: 40 },
  structural: { targetTokens: 260, overlapTokens: 40 },
  contextual: { targetTokens: 260, overlapTokens: 40 },
};

interface Section {
  headingPath: string[];
  text: string;
  charStart: number;
}

@Injectable()
export class ChunkingService {
  chunkAll(
    documents: SourceDocument[],
    profile: ChunkProfile,
    options?: Partial<ChunkOptions>,
  ): Chunk[] {
    const opts = { ...DEFAULT_CHUNK_OPTIONS[profile], ...options };
    const out: Chunk[] = [];
    for (const doc of documents) {
      out.push(...this.chunkDocument(doc, profile, opts));
    }
    return out;
  }

  chunkDocument(doc: SourceDocument, profile: ChunkProfile, opts: ChunkOptions): Chunk[] {
    const chunks =
      profile === 'fixed'
        ? this.fixedChunks(doc, opts)
        : this.structuralChunks(doc, opts);

    if (profile === 'contextual') {
      // The LLM-written context header is attached later (contextualizer
      // service) when a budget allows it. The deterministic heading-path header
      // applied here is the always-available floor.
      return chunks.map((c) => ({
        ...c,
        embedText: buildDeterministicContext(c) + c.text,
      }));
    }

    return chunks;
  }

  // ── Baseline: fixed window, structure-blind ────────────────────────────────

  private fixedChunks(doc: SourceDocument, opts: ChunkOptions): Chunk[] {
    const charsPerChunk = opts.targetTokens * 4;
    const overlapChars = opts.overlapTokens * 4;
    const stride = Math.max(1, charsPerChunk - overlapChars);
    const text = doc.text;
    const chunks: Chunk[] = [];

    for (let start = 0, ordinal = 0; start < text.length; start += stride, ordinal++) {
      const end = Math.min(text.length, start + charsPerChunk);
      const slice = text.slice(start, end).trim();
      if (slice.length === 0) continue;

      chunks.push(this.makeChunk(doc, ordinal, slice, [], start, end));

      if (end >= text.length) break;
    }

    return chunks;
  }

  // ── Advanced / Advanced-Pro: heading + paragraph aware ─────────────────────

  private structuralChunks(doc: SourceDocument, opts: ChunkOptions): Chunk[] {
    const sections = splitIntoSections(doc.text);
    const maxChars = opts.targetTokens * 4;
    const overlapChars = opts.overlapTokens * 4;
    const chunks: Chunk[] = [];
    let ordinal = 0;

    for (const section of sections) {
      const paragraphs = section.text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);

      let buffer = '';
      let bufferStart = section.charStart;
      let cursor = section.charStart;

      const flush = () => {
        const body = buffer.trim();
        if (!body) return;
        chunks.push(
          this.makeChunk(doc, ordinal++, body, section.headingPath, bufferStart, bufferStart + body.length),
        );
        // Carry a tail of the previous chunk so a fact split across the boundary
        // is still recoverable.
        buffer = overlapChars > 0 ? tailSentences(body, overlapChars) : '';
        bufferStart = bufferStart + Math.max(0, body.length - buffer.length);
      };

      for (const para of paragraphs) {
        // A single paragraph longer than the budget is split on sentences.
        if (para.length > maxChars) {
          flush();
          for (const piece of packSentences(para, maxChars)) {
            chunks.push(
              this.makeChunk(doc, ordinal++, piece, section.headingPath, cursor, cursor + piece.length),
            );
            cursor += piece.length;
          }
          buffer = '';
          bufferStart = cursor;
          continue;
        }

        if (buffer.length + para.length + 2 > maxChars) flush();
        buffer = buffer ? `${buffer}\n\n${para}` : para;
        cursor += para.length + 2;
      }

      flush();
    }

    // A document with no usable structure still needs chunks.
    return chunks.length > 0 ? chunks : this.fixedChunks(doc, opts);
  }

  private makeChunk(
    doc: SourceDocument,
    ordinal: number,
    text: string,
    headingPath: string[],
    charStart: number,
    charEnd: number,
  ): Chunk {
    return {
      id: `${doc.id}#${ordinal}_${hashId(text.slice(0, 160))}`,
      docId: doc.id,
      docTitle: doc.title,
      category: doc.category,
      ordinal,
      text,
      embedText: text,
      headingPath,
      charStart,
      charEnd,
      tokenEstimate: estimateTokens(text),
    };
  }
}

/**
 * Deterministic context header: document title + heading path. Always available,
 * costs nothing, and already recovers most of the benefit of contextual
 * retrieval for structured corpora. The LLM-written variant layers on top.
 */
export function buildDeterministicContext(chunk: Chunk): string {
  const parts = [chunk.docTitle.replace(/\.(md|txt|pdf|docx)$/i, '')];
  if (chunk.category && chunk.category !== 'uploaded') parts.unshift(chunk.category);
  if (chunk.headingPath.length > 0) parts.push(...chunk.headingPath);
  return `[Context: ${parts.join(' > ')}]\n`;
}

/** Split markdown into sections keyed by their heading path. */
function splitIntoSections(text: string): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];
  const headingStack: string[] = [];

  let buffer: string[] = [];
  let charStart = 0;
  let cursor = 0;

  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body) sections.push({ headingPath: [...headingStack], text: body, charStart });
    buffer = [];
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      headingStack.length = Math.min(headingStack.length, level - 1);
      headingStack[level - 1] = heading[2].trim();
      // Drop any gaps left by skipped heading levels.
      for (let i = 0; i < headingStack.length; i++) {
        if (headingStack[i] === undefined) headingStack[i] = '';
      }
      charStart = cursor + line.length + 1;
    } else {
      buffer.push(line);
    }
    cursor += line.length + 1;
  }
  flush();

  return sections.length > 0 ? sections : [{ headingPath: [], text, charStart: 0 }];
}

/** Greedily pack sentences into pieces no larger than `maxChars`. */
function packSentences(text: string, maxChars: number): string[] {
  const sentences = splitSentences(text);
  const out: string[] = [];
  let buf = '';

  for (const s of sentences) {
    if (s.length > maxChars) {
      if (buf) {
        out.push(buf);
        buf = '';
      }
      // Pathological sentence — hard split.
      for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars));
      continue;
    }
    if (buf.length + s.length + 1 > maxChars) {
      out.push(buf);
      buf = s;
    } else {
      buf = buf ? `${buf} ${s}` : s;
    }
  }
  if (buf) out.push(buf);
  return out.filter((p) => p.trim().length > 0);
}

/** Trailing sentences of `text` up to `maxChars`, used as inter-chunk overlap. */
function tailSentences(text: string, maxChars: number): string {
  const sentences = splitSentences(text);
  let out = '';
  for (let i = sentences.length - 1; i >= 0; i--) {
    const candidate = out ? `${sentences[i]} ${out}` : sentences[i];
    if (candidate.length > maxChars) break;
    out = candidate;
  }
  return out;
}
