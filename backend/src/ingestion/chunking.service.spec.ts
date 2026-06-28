import { ChunkingService, DEFAULT_CHUNK_OPTIONS, buildDeterministicContext } from './chunking.service';
import { SourceDocument } from '../common/types';

const doc: SourceDocument = {
  id: 'doc1',
  title: 'Avery Lancaster.md',
  category: 'employees',
  text: [
    '# Avery Lancaster',
    '',
    '## Summary',
    '',
    'Date of Birth: March 15, 1985. Job Title: Co-Founder and CEO. Location: San Francisco.',
    '',
    'Current salary is 225000 dollars per year.',
    '',
    '## Career Progression',
    '',
    'Avery co-founded Assurio in 2015 and has guided the company since then.',
    '',
    'Before Assurio, Avery was a Senior Product Manager at Innovate Insurance Solutions.',
  ].join('\n'),
};

describe('ChunkingService', () => {
  const svc = new ChunkingService();

  describe('fixed profile (baseline)', () => {
    it('produces overlapping windows and covers the whole document', () => {
      const chunks = svc.chunkDocument(doc, 'fixed', { targetTokens: 20, overlapTokens: 5 });
      expect(chunks.length).toBeGreaterThan(1);
      // Every chunk carries no heading path — the profile is structure-blind.
      expect(chunks.every((c) => c.headingPath.length === 0)).toBe(true);
      // Overlap means consecutive windows share text.
      expect(chunks[0].charEnd).toBeGreaterThan(chunks[1].charStart);
    });

    it('embedText equals text (nothing is enriched)', () => {
      const chunks = svc.chunkDocument(doc, 'fixed', DEFAULT_CHUNK_OPTIONS.fixed);
      expect(chunks.every((c) => c.embedText === c.text)).toBe(true);
    });

    it('terminates on a document shorter than one window', () => {
      const tiny: SourceDocument = { ...doc, text: 'short body' };
      const chunks = svc.chunkDocument(tiny, 'fixed', DEFAULT_CHUNK_OPTIONS.fixed);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe('short body');
    });
  });

  describe('structural profile (advanced)', () => {
    it('captures the markdown heading path', () => {
      const chunks = svc.chunkDocument(doc, 'structural', DEFAULT_CHUNK_OPTIONS.structural);
      const paths = chunks.map((c) => c.headingPath.join(' > '));
      expect(paths.some((p) => p.includes('Summary'))).toBe(true);
      expect(paths.some((p) => p.includes('Career Progression'))).toBe(true);
    });

    it('never mixes two sections into one chunk', () => {
      const chunks = svc.chunkDocument(doc, 'structural', DEFAULT_CHUNK_OPTIONS.structural);
      for (const c of chunks) {
        const inSummary = c.text.includes('Date of Birth');
        const inCareer = c.text.includes('co-founded Assurio');
        expect(inSummary && inCareer).toBe(false);
      }
    });

    it('splits an oversized paragraph on sentence boundaries', () => {
      const long: SourceDocument = {
        ...doc,
        text: `# T\n\n${'This is a sentence about insurance policies. '.repeat(60)}`,
      };
      const chunks = svc.chunkDocument(long, 'structural', { targetTokens: 40, overlapTokens: 0 });
      expect(chunks.length).toBeGreaterThan(3);
      expect(chunks.every((c) => c.text.length <= 40 * 4 + 8)).toBe(true);
    });

    it('falls back to fixed windows for unstructured text', () => {
      const plain: SourceDocument = { ...doc, text: 'no headings here. '.repeat(200) };
      const chunks = svc.chunkDocument(plain, 'structural', { targetTokens: 30, overlapTokens: 0 });
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  describe('contextual profile (advanced-pro)', () => {
    it('embeds a context header but leaves the answerable text untouched', () => {
      const chunks = svc.chunkDocument(doc, 'contextual', DEFAULT_CHUNK_OPTIONS.contextual);
      for (const c of chunks) {
        expect(c.embedText).not.toBe(c.text);
        expect(c.embedText.startsWith('[Context:')).toBe(true);
        expect(c.embedText.endsWith(c.text)).toBe(true);
      }
    });

    it('context header names the document and section', () => {
      const chunks = svc.chunkDocument(doc, 'contextual', DEFAULT_CHUNK_OPTIONS.contextual);
      const withSummary = chunks.find((c) => c.headingPath.includes('Summary'));
      expect(withSummary).toBeDefined();
      expect(buildDeterministicContext(withSummary!)).toContain('Avery Lancaster');
      expect(buildDeterministicContext(withSummary!)).toContain('Summary');
    });
  });

  it('assigns unique, deterministic chunk ids', () => {
    const a = svc.chunkAll([doc], 'structural');
    const b = svc.chunkAll([doc], 'structural');
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(new Set(a.map((c) => c.id)).size).toBe(a.length);
  });

  it('never emits an empty chunk', () => {
    const messy: SourceDocument = { ...doc, text: '# A\n\n\n\n## B\n\n\n\ncontent\n\n\n' };
    for (const profile of ['fixed', 'structural', 'contextual'] as const) {
      const chunks = svc.chunkDocument(messy, profile, DEFAULT_CHUNK_OPTIONS[profile]);
      expect(chunks.every((c) => c.text.trim().length > 0)).toBe(true);
    }
  });
});
