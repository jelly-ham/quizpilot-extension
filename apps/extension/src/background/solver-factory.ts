import { ApiError, getAuth, markRemote, readRemote, solveRemote } from '../lib/api';
import { apiErrorMessage } from '../lib/messages';
import { t } from '../lib/i18n';
import type { Settings } from '../lib/settings';
import { byokSolver, UserError, type Solver } from './solver';

export async function createSolver(settings: Settings): Promise<Solver> {
  if (settings.mode === 'byok') return byokSolver(settings);
  if (!(await getAuth())) throw new UserError(t('err_paidNeedsLogin'));
  return paidSolver();
}

/** Paid mode: our API picks the models and charges credits. API errors are shown as user errors. */
function paidSolver(): Solver {
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw err instanceof ApiError ? new UserError(apiErrorMessage(err)) : err;
    }
  };
  return {
    canRead: true,
    read: (req, signal) => call(() => readRemote(req, signal)),
    solve: (req, signal) => call(() => solveRemote(req, signal)),
    mark: (req, signal) => call(() => markRemote(req, signal)),
  };
}
