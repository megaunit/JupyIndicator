import * as crypto from 'crypto';
import { CellType, ParsedCell, ParsedNotebook } from './types';

interface RawCell {
  cell_type?: string;
  source?: string | string[];
  metadata?: { id?: string } & Record<string, unknown>;
  id?: string;
}

interface RawNotebook {
  nbformat?: number;
  nbformat_minor?: number;
  cells?: RawCell[];
}

const EMPTY: ParsedNotebook = { nbformat: 4, nbformatMinor: 5, cells: [] };

export function parseNotebook(raw: string | null | undefined): ParsedNotebook {
  if (!raw) return EMPTY;
  let nb: RawNotebook;
  try {
    nb = JSON.parse(raw) as RawNotebook;
  } catch {
    return EMPTY;
  }
  if (!nb || !Array.isArray(nb.cells)) return EMPTY;

  const cells: ParsedCell[] = nb.cells.map((c, index) => {
    const source = normalizeSource(c.source);
    const cellType = normalizeCellType(c.cell_type);
    const stableId = extractId(c);
    return {
      id: stableId ?? synthesizeId(index, cellType, source),
      hasStableId: stableId !== null,
      index,
      cellType,
      source,
    };
  });

  return {
    nbformat: typeof nb.nbformat === 'number' ? nb.nbformat : 4,
    nbformatMinor: typeof nb.nbformat_minor === 'number' ? nb.nbformat_minor : 5,
    cells,
  };
}

function normalizeSource(src: string | string[] | undefined): string {
  if (src == null) return '';
  if (typeof src === 'string') return src;
  return src.join('');
}

function normalizeCellType(t: string | undefined): CellType {
  if (t === 'code' || t === 'markdown' || t === 'raw') return t;
  return 'code';
}

function extractId(c: RawCell): string | null {
  const fromMeta = c.metadata?.id;
  if (typeof fromMeta === 'string' && fromMeta.length > 0) return fromMeta;
  if (typeof c.id === 'string' && c.id.length > 0) return c.id;
  return null;
}

function synthesizeId(index: number, type: CellType, source: string): string {
  const h = crypto
    .createHash('sha1')
    .update(`${index}|${type}|${source}`)
    .digest('hex')
    .slice(0, 10);
  return `synth-${index}-${h}`;
}
