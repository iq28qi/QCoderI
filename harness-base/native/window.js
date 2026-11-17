Object.defineProperty(window, 'dshDesktop', {
  value: Object.freeze({
    protocolVersion: 1,
    quit: () => window.ipc.postMessage('quit'),
    updates: Object.freeze({
      ready: () => window.ipc.postMessage('window-ready'),
      async request(action = '') {
        const response = await fetch('/.qcoderi/update' + (action ? '/' + action : ''), {
          method: action ? 'POST' : 'GET',
          cache: 'no-store',
        });
        if (!response.ok) throw Error('Служба обновлений недоступна.');
        return response.json();
      },
    }),
    system: Object.freeze({
      async snapshot() {
        const response = await fetch('/.qcoderi/system', { cache: 'no-store' });
        if (response.ok) return response.json();
      },
    }),
    voice: Object.freeze({
      async synthesize(text, signal) {
        const response = await fetch('/.qcoderi/speech', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: text,
          signal,
        });
        if (!response.ok) throw new Error('Локальное озвучивание недоступно');
        return response.blob();
      },
    }),
  }),
});
