import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const workbench = readFileSync(new URL('../assets/workbench-view.js', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../assets/studio-sidebar.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(source, component, options = {}) {
  const effects = [], layoutEffects = [], intervals = new Map(), listeners = new Map(), states = [];
  let stateIndex = 0, sequence = 0, changes = 0;
  const document = {
    hidden: false,
    querySelector: () => options.root ?? null,
    querySelectorAll: () => [],
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
  };
  const window = {
    dshDesktop: { updates: options.updater },
    __qcoderiWorkbench: options.request,
  };
  const react = {
    useState(initial) {
      const index = stateIndex++;
      states[index] = index === 0 && options.tab !== undefined ? options.tab : initial;
      return [states[index], value => {
        const next = typeof value === 'function' ? value(states[index]) : value;
        if (next !== states[index]) changes++;
        states[index] = next;
      }];
    },
    useRef: initial => ({ current: initial }),
    useEffect: (effect, deps) => effects.push({ effect, deps }),
    useLayoutEffect: effect => layoutEffects.push(effect),
    createElement: () => null,
  };
  const context = {
    react, window, document, AbortController, DOMException,
    setInterval(fn, delay) { const id = ++sequence; intervals.set(id, { fn, delay }); return id; },
    clearInterval: id => intervals.delete(id),
    MutationObserver: options.MutationObserver,
  };
  const render = vm.runInNewContext(source + '\n' + component, context);
  render({ sessionId: 'session-1', chatMode: false, wide: false });
  return { document, effects, layoutEffects, intervals, listeners, states, changes: () => changes };
}

test('streamed DOM mutations reuse the connected microphone seat and replacement is discovered', () => {
  let seat = { isConnected: true, dataset: { qcVoiceSeat: 'session-1' } };
  let searches = 0, changed, disconnected = false;
  const root = { querySelectorAll() { searches++; return [seat]; } };
  const ui = fixture(workbench, 'WorkbenchPanel', { root, MutationObserver: class {
    constructor(callback) { changed = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  } });
  const cleanup = ui.layoutEffects[0]();
  assert.equal(searches, 1);
  for (let i = 0; i < 1000; i++) changed();
  assert.equal(searches, 1, 'a long streamed transcript does not get rescanned');
  seat.isConnected = false;
  seat = { isConnected: true, dataset: { qcVoiceSeat: 'session-1' } };
  changed();
  assert.equal(searches, 2);
  assert.equal(ui.states.at(-1), seat, 'portal moves to a replacement composer');
  cleanup();
  assert.equal(disconnected, true);
});

test('workbench polling coalesces slow requests, pauses hidden and refreshes on return', async () => {
  let requests = 0, complete;
  const ui = fixture(workbench, 'WorkbenchPanel', {
    tab: 'memory',
    request: () => { requests++; return new Promise(resolve => { complete = resolve; }); },
  });
  const disposeSession = ui.effects[0].effect();
  const dispose = ui.effects[1].effect();
  const timer = [...ui.intervals.values()][0];
  assert.equal(timer.delay, 2500);
  assert.equal(requests, 1);
  await timer.fn();
  await timer.fn();
  assert.equal(requests, 1, 'slow RPCs cannot pile up');
  complete({ memory: [] });
  await settle();
  ui.document.hidden = true;
  await timer.fn();
  assert.equal(requests, 1);
  ui.document.hidden = false;
  ui.listeners.get('visibilitychange')();
  assert.equal(requests, 2);
  dispose();
  complete({ memory: ['stale'] });
  await settle();
  assert.equal(ui.states[1].memory.length, 0, 'closed panel ignores late results');
  assert.equal(ui.intervals.size, 0);
  assert.equal(ui.listeners.size, 0);
  disposeSession();
});

test('voice panel avoids loading unrelated project state', () => {
  const ui = fixture(workbench, 'WorkbenchPanel', { tab: 'voice', request: () => assert.fail('unused project RPC') });
  ui.effects[1].effect();
  assert.equal(ui.intervals.size, 0);
});

test('idle updater polls every 15 seconds and identical state preserves the sidebar tree', async () => {
  let ready = 0, requests = 0;
  const ui = fixture(sidebar, 'NightProfile', { updater: {
    ready() { ready++; },
    async request() { requests++; return { phase: 'current', currentVersion: '1.3.1' }; },
  } });
  ui.effects[0].effect();
  const dispose = ui.effects[1].effect();
  await settle();
  assert.equal(ready, 1);
  const timer = [...ui.intervals.values()][0];
  assert.equal(timer.delay, 15000);
  const changes = ui.changes();
  for (let i = 0; i < 5; i++) await timer.fn();
  assert.equal(requests, 6);
  assert.equal(ui.changes(), changes, 'unchanged status does not re-render the sidebar');
  ui.document.hidden = true;
  await timer.fn();
  assert.equal(requests, 6);
  ui.document.hidden = false;
  ui.listeners.get('visibilitychange')();
  await settle();
  assert.equal(requests, 7);
  dispose();
  assert.equal(ui.intervals.size, 0);
  assert.equal(ui.listeners.size, 0);
});

test('open update panel retains one-second progress polling', async () => {
  const ui = fixture(sidebar, 'NightProfile', { tab: true, updater: { ready() {}, async request() { return { phase: 'downloading', percent: 12 }; } } });
  const dispose = ui.effects[1].effect();
  await settle();
  assert.equal([...ui.intervals.values()][0].delay, 1000);
  dispose();
});
