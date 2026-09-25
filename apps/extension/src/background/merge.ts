import { Question, type Answer } from '@quizpilot/shared';
import type { ExtractStatus } from '../content/extract/generic';
import { t } from '../lib/i18n';

/** One question in a run, across frames and sources. */
export interface Entry {
  /** Unique across frames, sent to the model. */
  id: string;
  frameId: number;
  /** Id inside its frame's content script. */
  localId: string;
  question: Question;
  status: ExtractStatus;
  /** False when there is no DOM control to write into (answer is only shown). */
  fillable: boolean;
  /** A screenshot of this question was taken and used (read or attached as a figure). */
  visionChecked: boolean;
  tags: string[];
  /** The question as the page's text shows it, before any screenshot read (see questionKey). */
  domKey?: string;
}

export const entryId = (frameId: number, localId: string) => `f${frameId}-${localId}`;

const CHOICE = new Set(['single', 'multi', 'judge']);

/** The question depends on a figure: keep DOM text, attach the crop, answer with a vision model. */
export function withFigure(entry: Entry, crop: string): Entry {
  return {
    ...entry,
    question: { ...entry.question, needsVision: true, images: [{ id: 'figure', dataUrl: crop }] },
    visionChecked: true,
    tags: [...entry.tags, t('tag_vision')],
  };
}

/**
 * Merge a screenshot transcription of one question into its DOM entry. DOM option keys are kept so
 * the answer still maps onto the page controls; the vision text replaces unreadable DOM text.
 */
export function mergeVision(entry: Entry, read: Question | undefined, crop: string): Entry {
  if (!read) return { ...entry, visionChecked: true, tags: [...entry.tags, t('tag_incomplete')] };
  const dom = entry.question;
  const images = read.needsVision
    ? { needsVision: true, images: [{ id: 'crop', dataUrl: crop }] }
    : {};
  const tags = [...entry.tags, t('tag_screenshot'), ...(read.needsVision ? [t('tag_vision')] : [])];

  let merged: unknown;
  if (dom.options && read.options?.length === dom.options.length && CHOICE.has(read.kind)) {
    const kind = dom.kind === 'multi' ? 'multi' : read.kind === 'multi' ? dom.kind : read.kind;
    merged = {
      ...read,
      ...images,
      id: entry.id,
      kind,
      options: dom.options.map((o, i) => ({ key: o.key, text: read.options![i]!.text })),
    };
  } else if (!dom.options && (read.kind === 'fill' || read.kind === 'essay')) {
    merged = {
      ...read,
      ...images,
      id: entry.id,
      kind: dom.kind,
      blanks: dom.blanks,
      options: undefined,
    };
  }

  const parsed = merged ? Question.safeParse(merged) : null;
  if (parsed?.success) return { ...entry, question: parsed.data, visionChecked: true, tags };
  // Shapes disagree: trust the screenshot, but we can no longer map the answer onto the page.
  return {
    ...entry,
    question: { ...read, ...images, id: entry.id },
    fillable: false,
    visionChecked: true,
    tags: [...tags, t('tag_displayOnly')],
  };
}

/** Tag entries that needed a screenshot but were answered from DOM text only. */
export function markUnverified(entry: Entry): Entry {
  if (entry.status === 'ok' || entry.visionChecked) return entry;
  return { ...entry, tags: [entry.status === 'figure' ? t('tag_noImage') : t('tag_incomplete')] };
}

export function formatAnswer(q: Question, a: Answer): string {
  const label = (key: string) => {
    const text = q.options?.find((o) => o.key === key)?.text;
    return text ? `${key}. ${text}` : key;
  };
  switch (q.kind) {
    case 'single':
      return a.choice ? label(a.choice) : '';
    case 'multi':
      return (a.choices ?? []).map(label).join('\n');
    case 'judge':
      return a.bool ? t('ans_true') : t('ans_false');
    case 'fill':
      return (Array.isArray(a.text) ? a.text : [a.text ?? '']).join('；');
    case 'essay':
      return Array.isArray(a.text) ? a.text.join('\n') : (a.text ?? '');
  }
}
