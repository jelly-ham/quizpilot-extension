/** The store's review page. Chrome has no in-extension rating prompt, so we can only link to it. */
export const REVIEW_URL =
  'https://chromewebstore.google.com/detail/quizpilot/gloldlbaimjdhcpgpcdcihcekfclgeha/reviews';

/** Runs that answered something before we ask, so nobody is asked before the extension has helped. */
export const REVIEW_AFTER_RUNS = 3;

const KEY = 'reviewPrompt';

interface ReviewPrompt {
  runs: number;
  /** The user followed the link or dismissed it; never ask again. */
  closed: boolean;
}

async function read(): Promise<ReviewPrompt> {
  const stored = (await chrome.storage.local.get(KEY))[KEY] as Partial<ReviewPrompt> | undefined;
  return { runs: stored?.runs ?? 0, closed: stored?.closed ?? false };
}

const write = (state: ReviewPrompt) => chrome.storage.local.set({ [KEY]: state });

/** Counts a run that answered at least one question. Stays on this device. */
export async function recordAnsweredRun(): Promise<void> {
  const state = await read();
  if (!state.closed) await write({ ...state, runs: state.runs + 1 });
}

export async function shouldAskForReview(): Promise<boolean> {
  const state = await read();
  return !state.closed && state.runs >= REVIEW_AFTER_RUNS;
}

export async function closeReviewPrompt(): Promise<void> {
  await write({ ...(await read()), closed: true });
}
