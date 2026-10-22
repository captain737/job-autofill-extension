const $ = (id) => document.getElementById(id);
const status = $('status');
const FILES = ['content/core.js', 'content/sidebar.js', 'content/main.js'];

$('profile').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
$('tracker').onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('tracker.html') }); };

async function showShortcut(el) {
  const cmds = await chrome.commands.getAll();
  const c = cmds.find((x) => x.name === 'toggle-sidebar');
  el.innerHTML = c && c.shortcut
    ? `Sidebar shortcut: <b>${c.shortcut}</b> · <a href="#" class="sc">change</a>`
    : 'No sidebar shortcut set · <a href="#" class="sc">set one</a>';
  el.querySelector('.sc').onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); };
}
showShortcut(document.getElementById('shortcut'));

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = '';
  try { host = new URL(tab.url).host; } catch {}
  const { settings = {}, memory = [], applications = [] } = await chrome.storage.local.get(['settings', 'memory', 'applications']);
  $('host').textContent = host || 'this site';
  $('counts').textContent = `${applications.length} tracked application${applications.length === 1 ? '' : 's'} · ${memory.length} remembered answer${memory.length === 1 ? '' : 's'}`;
  const paused = new Set(settings.pausedHosts || []);
  $('auto').checked = settings.autoFill !== false && !paused.has(host);
  $('auto').disabled = settings.autoFill === false || !host;
  if (settings.autoFill === false) $('host').textContent += ' (auto-fill is off in settings)';
  $('auto').onchange = async (e) => {
    const { settings: s = {} } = await chrome.storage.local.get('settings');
    const set = new Set(s.pausedHosts || []);
    e.target.checked ? set.delete(host) : set.add(host);
    await chrome.storage.local.set({ settings: { ...s, pausedHosts: [...set] } });
  };

  // Tabs opened before the extension was installed/updated don't have the scripts yet.
  async function inject() {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: FILES });
  }

  $('open').onclick = async () => {
    try {
      await inject();
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.__JA && window.__JA.actions && window.__JA.actions.open(),
      });
      window.close();
    } catch (err) {
      status.textContent = "Can't run on this page.";
      console.error(err);
    }
  };

  $('fill').onclick = async () => {
    status.textContent = 'Filling… (the AI takes a few seconds)';
    try {
      await inject();
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => (window.__autofill ? window.__autofill({ force: true }) : null),
      });
      const sum = (k) => results.reduce((n, r) => n + ((r.result && r.result[k]) || 0), 0);
      const errors = results.map((r) => r.result && r.result.error).filter(Boolean);
      if (errors.length) status.textContent = `AI step failed: ${errors[0]}`;
      else if (!sum('asked')) status.textContent = 'No empty fields found on this page.';
      else {
        status.textContent = `✓ Filled ${sum('filled')} of ${sum('asked')} empty fields`;
        if (sum('review')) status.textContent += `\n⚠ ${sum('review')} outlined in orange need a look.`;
      }
    } catch (err) {
      status.textContent = "Can't run on this page.";
      console.error(err);
    }
  };
})();
