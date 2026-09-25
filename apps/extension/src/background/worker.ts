import type { RunMode, RuntimeMessage } from '../lib/protocol';
import { fillLastRun, forgetRun, isRunning, runPipeline, stopRun, undoLastRun } from './pipeline';
import { googleLogin } from './google';
import { createSolver } from './solver-factory';

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // Nothing to persist: getSettings() fills in defaults on every read.
  if (reason === 'install') chrome.runtime.openOptionsPage();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'qp-page',
      title: chrome.i18n.getMessage('solvePage'),
      contexts: ['all'],
    });
    chrome.contextMenus.create({
      id: 'qp-assist',
      title: chrome.i18n.getMessage('solveAssist'),
      contexts: ['all'],
    });
    chrome.contextMenus.create({
      id: 'qp-auto',
      title: chrome.i18n.getMessage('solveAuto'),
      contexts: ['all'],
    });
    chrome.contextMenus.create({
      id: 'qp-region',
      title: chrome.i18n.getMessage('solveRegion'),
      contexts: ['all'],
    });
    chrome.contextMenus.create({
      id: 'qp-learn',
      title: chrome.i18n.getMessage('relearnPage'),
      contexts: ['all'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const modes: Record<string, RunMode> = {
    'qp-page': 'page',
    'qp-auto': 'auto',
    'qp-assist': 'assist',
    'qp-region': 'region',
    'qp-learn': 'learn',
  };
  const mode = modes[String(info.menuItemId)];
  if (tab?.id && mode) void runPipeline(tab, mode, createSolver);
});

/** Keyboard commands (manifest `commands`); users can rebind them at chrome://extensions/shortcuts. */
const COMMANDS: Record<string, RunMode> = {
  'solve-page': 'page',
  'solve-assist': 'assist',
  'solve-auto': 'auto',
  'solve-region': 'region',
  'relearn-page': 'learn',
};

chrome.commands.onCommand.addListener(async (command, tab) => {
  const target = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!target?.id) return;
  // The continuous modes' keys toggle: pressed again while running, they stop.
  if (
    command === 'stop-run' ||
    ((command === 'solve-auto' || command === 'solve-assist') && isRunning(target.id))
  ) {
    stopRun(target.id);
    return;
  }
  const mode = COMMANDS[command];
  if (mode) void runPipeline(target, mode, createSolver);
});

chrome.tabs.onRemoved.addListener((tabId) => void forgetRun(tabId));

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  switch (msg.type) {
    case 'qp:google-login':
      // Runs here, not in the popup: the popup closes when the sign-in window takes focus.
      void (async () => {
        try {
          await googleLogin();
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
      })();
      return true;
    case 'qp:run':
      void (async () => runPipeline(await chrome.tabs.get(msg.tabId), msg.mode, createSolver))();
      break;
    case 'qp:fill':
      if (tabId) fillLastRun(tabId);
      break;
    case 'qp:undo':
      if (tabId) undoLastRun(tabId);
      break;
    case 'qp:close':
      if (tabId) void forgetRun(tabId);
      break;
    case 'qp:stop':
      if (tabId) stopRun(tabId);
      break;
  }
  sendResponse();
});
