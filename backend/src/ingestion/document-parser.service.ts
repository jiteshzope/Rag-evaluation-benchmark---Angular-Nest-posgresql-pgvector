import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as path from 'path';

import { MAX_KB_CHARS, MIN_KB_CHARS } from '../config/limits';
import { SourceDocument } from '../common/types';
import { cleanExtractedText, hashId, trimToChars } from './text-utils';

export interface ParsedUpload {
  documents: SourceDocument[];
  originalChars: number;
  /** Characters kept after the MAX_KB_CHARS trim. */
  keptChars: number;
  trimmed: boolean;
  /** Human-readable note surfaced to the user when a trim happened. */
  notice?: string;
}

/**
 * Extracts **plain text only** from an uploaded PDF / DOCX / TXT / MD.
 *
 * Nothing is written to disk and nothing about the upload is persisted — the
 * buffer arrives in memory, text comes out, the buffer is dropped. Images,
 * embedded objects, macros and attachments are all discarded by construction:
 * we only ever read the text layer.
 */
@Injectable()
export class DocumentParserService {
  private readonly logger = new Logger(DocumentParserService.name);

  async parseUpload(file: {
    originalname: string;
    mimetype: string;
    buffer: Buffer;
  }): Promise<ParsedUpload> {
    const ext = path.extname(file.originalname).toLowerCase();
    const raw = await this.extractText(file.buffer, ext, file.mimetype, file.originalname);
    const cleaned = cleanExtractedText(raw);

    if (cleaned.length < MIN_KB_CHARS) {
      throw new BadRequestException(
        `Only ${cleaned.length} characters of text could be extracted from "${file.originalname}". ` +
          `At least ${MIN_KB_CHARS} are needed to build a meaningful index. ` +
          `Scanned PDFs without a text layer cannot be read — this project does not run OCR.`,
      );
    }

    const originalChars = cleaned.length;
    const { text, trimmed } = trimToChars(cleaned, MAX_KB_CHARS);

    const title = path.basename(file.originalname);
    const documents: SourceDocument[] = [
      {
        id: `up_${hashId(`${title}:${text.length}`)}`,
        title,
        category: 'uploaded',
        text,
      },
    ];

    const notice = trimmed
      ? `Your knowledge base was trimmed from ${group(originalChars)} to ` +
        `${group(text.length)} characters (the ${group(MAX_KB_CHARS)}-character ` +
        `limit for anonymous runs). Everything after the cut-off was not indexed, so questions about ` +
        `the tail of the document will legitimately score low.`
      : undefined;

    if (trimmed) this.logger.log(`Trimmed upload ${title}: ${originalChars} -> ${text.length} chars`);

    return { documents, originalChars, keptChars: text.length, trimmed, notice };
  }

  private async extractText(
    buffer: Buffer,
    ext: string,
    mimetype: string,
    filename: string,
  ): Promise<string> {
    if (ext === '.txt' || ext === '.md' || mimetype.startsWith('text/')) {
      return buffer.toString('utf8');
    }

    if (ext === '.pdf' || mimetype === 'application/pdf') {
      return this.extractPdf(buffer, filename);
    }

    if (
      ext === '.docx' ||
      mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      return this.extractDocx(buffer, filename);
    }

    throw new BadRequestException(
      `Unsupported file type "${ext || mimetype}". Upload a PDF, DOCX, TXT or MD file.`,
    );
  }

  private async extractPdf(buffer: Buffer, filename: string): Promise<string> {
    try {
      // Required lazily: pdf-parse runs a debug harness at import time when its
      // module entry point is loaded directly.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (
        b: Buffer,
      ) => Promise<{ text: string; numpages: number }>;
      const result = await pdfParse(buffer);
      return result.text ?? '';
    } catch (err) {
      this.logger.warn(`PDF parse failed for ${filename}: ${(err as Error).message}`);
      throw new BadRequestException(
        `"${filename}" could not be read as a PDF. It may be corrupt, password protected, ` +
          `or a scan with no text layer.`,
      );
    }
  }

  private async extractDocx(buffer: Buffer, filename: string): Promise<string> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mammoth = require('mammoth') as {
        extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>;
      };
      const result = await mammoth.extractRawText({ buffer });
      return result.value ?? '';
    } catch (err) {
      this.logger.warn(`DOCX parse failed for ${filename}: ${(err as Error).message}`);
      throw new BadRequestException(
        `"${filename}" could not be read as a DOCX file. Legacy .doc files are not supported — ` +
          `re-save as .docx, PDF or plain text.`,
      );
    }
  }
}

/**
 * Thousands separators for user-facing text. Pinned to en-US rather than the
 * server's locale, which would otherwise render 384030 as "3,84,030" depending
 * on where the process happens to be running.
 */
function group(n: number): string {
  return n.toLocaleString('en-US');
}
