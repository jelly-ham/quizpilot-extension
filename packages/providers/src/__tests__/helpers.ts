import { Question, type QuestionInput } from '@quizpilot/shared';
import type { FetchFn } from '../types';

export interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: any;
}

type Reply = Response | ((req: Recorded) => Response) | Error;

/** fetch stub that serves queued replies and records requests. */
export function fakeFetch(...replies: Reply[]) {
  const calls: Recorded[] = [];
  const fn: FetchFn = async (input, init) => {
    const req: Recorded = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(req);
    const reply = replies.length > 1 ? replies.shift()! : replies[0];
    if (!reply) throw new Error('no reply queued');
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(req) : reply.clone();
  };
  return Object.assign(fn, { calls });
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

export const noRetry = { retries: 0 };
export const instantRetry = { sleep: async () => {} };

export const q = (input: QuestionInput): Question => Question.parse(input);

export const single = (id: string, stem = '2 + 2 = ?') =>
  q({
    id,
    kind: 'single',
    stem,
    options: [
      { key: 'A', text: '3' },
      { key: 'B', text: '4' },
    ],
  });

export const multi = (id: string) =>
  q({
    id,
    kind: 'multi',
    stem: 'Which are prime?',
    options: [
      { key: 'A', text: '2' },
      { key: 'B', text: '4' },
      { key: 'C', text: '5' },
    ],
  });

export const judge = (id: string, stem = 'Water boils at 100°C at sea level.') =>
  q({ id, kind: 'judge', stem });

export const fill = (id: string, blanks = 1) =>
  q({ id, kind: 'fill', stem: 'The capital of France is ___.', blanks });

export const PNG = 'data:image/png;base64,iVBORw0KGgo=';

/** Minimal OpenAI chat completion wrapping `content`. */
export const chatReply = (
  content: unknown,
  usage = { prompt_tokens: 100, completion_tokens: 20 },
) =>
  json({
    model: 'gpt-test',
    choices: [
      { message: { content: typeof content === 'string' ? content : JSON.stringify(content) } },
    ],
    usage,
  });
