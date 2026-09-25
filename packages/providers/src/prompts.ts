import type { Question } from '@quizpilot/shared';

export const SOLVE_SYSTEM_PROMPT = `You answer quiz and exercise questions accurately.

You receive a JSON array of questions. Reply with ONE JSON object and nothing else:
{"answers":[{"id":"<question id>", ...answer fields..., "confidence":<0..1>}]}

Answer fields by question kind:
- "single": {"choice":"<option key>"}
- "multi":  {"choices":["<option key>", ...]}  (one or more)
- "judge":  {"bool":true|false}  (is the statement correct?)
- "fill":   {"text":["<blank 1>", "<blank 2>", ...]}  (exactly "blanks" items; default 1)
- "essay":  {"text":"<answer>"}

Rules:
- Use option keys exactly as given, never option text.
- Answer every question, in the same language as the question.
- Keep fill answers short: just what goes in the blank.
- "confidence" is your honest probability that the answer is correct.
- When a question has images, they follow as separate image parts labelled with the question id.`;

export function solveUserText(questions: Question[]): string {
  const compact = questions.map((q) => ({
    id: q.id,
    kind: q.kind,
    stem: q.stem,
    ...(q.options ? { options: q.options } : {}),
    ...(q.blanks ? { blanks: q.blanks } : {}),
    ...(q.context ? { context: q.context } : {}),
    ...(q.images?.length
      ? { images: q.images.map((i) => ({ id: i.id, ...(i.alt ? { alt: i.alt } : {}) })) }
      : {}),
  }));
  return JSON.stringify(compact);
}

export const READ_SYSTEM_PROMPT = `You transcribe quiz questions from a screenshot of a web page.

Reply with ONE JSON object and nothing else:
{"questions":[{
  "kind": "single" | "multi" | "judge" | "fill" | "essay",
  "stem": "<question text>",
  "options": [{"key":"A","text":"..."}],   // single / multi only
  "blanks": <number>,                      // fill only
  "needsVision": true | false
}]}

Rules:
- Transcribe text exactly, in the original language. Write only mathematical formulas (not whole
  sentences) as LaTeX between $...$; plain arithmetic like 1 + 1 = ? stays plain text.
- Use option labels as shown (A/B/C, 1/2/3, ...). If options have no labels, use A, B, C in order.
- kind: one correct option → single; "select all" / checkboxes → multi; true/false or 对/错 → judge;
  blanks to type in → fill (count them); open-ended → essay.
- needsVision = true only when a figure, diagram, chart, map or picture is needed to answer and
  cannot be fully described in the stem. Describe what you can in the stem anyway.
- Skip navigation, headers, ads, and anything that is not a question. Skip questions cut off at
  the screenshot edge.
- If there are no questions, reply {"questions":[]}.`;

export function readUserText(hint: string | undefined): string {
  return hint
    ? `Transcribe the questions in this screenshot.\n\nPage hint: ${hint}`
    : 'Transcribe the questions in this screenshot.';
}

export const MARK_SYSTEM_PROMPT = `You find quiz questions on a screenshot of a web page. Page elements carry red number labels;
the user message also lists every number with its tag and text.

Reply with ONE JSON object and nothing else:
{"questions":[{"kind":"single"|"multi"|"judge"|"fill"|"essay","stem":<number>,"options":[<number>,...],"inputs":[<number>,...]}]}

Rules:
- stem: the number of the element holding the question text.
- options: choice questions only; one number per answer choice, in display order (the element with that choice's text).
- inputs: fill/essay only; the numbers of the text boxes to type into.
- kind: one answer → single; "多选"/checkboxes/"select all" → multi; true/false or 对/错 → judge.
- Only questions fully visible in the screenshot. Ignore navigation, buttons (提交, 下一题, submit), ads and instructions.
- If there are no questions, reply {"questions":[]}.`;

export function markUserText(marks: { id: number; tag: string; text: string }[]): string {
  return `Numbered elements:\n${marks.map((m) => `[${m.id}] ${m.tag}: ${m.text}`).join('\n')}`;
}
