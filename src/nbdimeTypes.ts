export type NbdimeDiff = NbdimeDiffEntry[];

export interface NbdimeDiffEntry {
  op: string;
  key?: string | number;
  diff?: NbdimeDiff;
  value?: unknown;
  valuelist?: unknown[];
  length?: number;
  [key: string]: unknown;
}
