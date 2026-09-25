/** Current key bindings of the manifest `commands`, which users can change in Chrome. */
export async function getShortcuts(): Promise<Record<string, string>> {
  try {
    const all = await chrome.commands.getAll();
    return Object.fromEntries(all.filter((c) => c.name).map((c) => [c.name!, c.shortcut ?? '']));
  } catch {
    return {};
  }
}

/** Chrome's own page for rebinding extension shortcuts. */
export const openShortcutSettings = () =>
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
