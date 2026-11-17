function useStudioChat(useSessions) {
  const selection = useSessions(state => {
    const current = state.current;
    return current === undefined ? '' : state.byId[current]?.projectionValues?.agentPreset ?? 'project';
  });
  const [requested, setRequested] = react.useState(document.body.dataset.qcRequestedMode ?? 'chat');
  react.useEffect(() => {
    const update = event => setRequested(event.detail?.mode ?? 'chat');
    window.addEventListener('qcoderi:mode', update);
    return () => window.removeEventListener('qcoderi:mode', update);
  }, []);
  const chat = selection === 'qcoder-chat' || selection === '' && requested !== 'project';
  react.useEffect(() => { document.body.dataset.qcMode = chat ? 'chat' : 'project'; }, [chat]);
  return chat;
}
