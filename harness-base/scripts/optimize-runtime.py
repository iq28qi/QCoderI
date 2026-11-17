"""Reproducible streaming hot-path fixes, applied after Studio integration."""
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
PACKAGES = BASE / 'source/dsh/node_modules/@deepseek-ai'

def apply():
    changed = []
    path = PACKAGES / 'dsh-client-ui-conversation/lib/client.js'
    source = path.read_text(encoding='utf-8')
    owner = source.index('var BoundConversation = class')
    marker = '\n// QCODERI_STREAM_PUBLICATION'
    start = source.index(marker, owner) if marker in source[owner:] else source.index('\n\t\t\tpublish(publication) {', owner)
    end = source.index('\n\t\t\tflush() {', start)
    implementation = (BASE / 'assets/stream-publication.js').read_text(encoding='utf-8')
    source = source[:start] + '\n' + implementation + source[end:]
    if 'QCODERI_INPUT_ISOLATION' not in source:
        source = source.replace('const repeatVideo=async job=>{', 'const repeatVideo=react.useCallback(async job=>{', 1)
        before = '''requestAnimationFrame(()=>document.querySelector('[contenteditable="true"]')?.focus());
            };
            const inputBar'''
        after = '''requestAnimationFrame(()=>document.querySelector('[contenteditable="true"]')?.focus());
            },[session?.running,sessionId,inputActions]);
            // QCODERI_INPUT_ISOLATION: typing changes the composer, not the
            // transcript subtree or every media-context consumer.
            const sessionView=react.useMemo(()=>sessionId===undefined?null:renderSlot("conversation.session",{}),[sessionId,renderSlot]);
            const inputBar'''
        if before not in source: raise RuntimeError('Composer callback changed; review input isolation')
        source = source.replace(before, after, 1)
        source = source.replace('children: [sessionId === void 0 ? null : renderSlot("conversation.session", {}),', 'children: [sessionView,', 1)
    if 'QCODERI_DRAFT_VIEW_ISOLATION' not in source:
        owner = source.index('function DefaultConversationViews(')
        end_owner = source.index('\n\t\t//#endregion', owner)
        segment = source[owner:end_owner]
        before = '''if (session.blank && conversationPhase(session, conversation) === "blank") return null;'''
        after = '''// QCODERI_DRAFT_VIEW_ISOLATION: the draft mirror subscribes
            // here, but its updates must not re-render the active transcript.
            const viewContent=react.useMemo(()=>active===undefined?null:renderSlot("conversation.view",{
                viewRequest,openView,completeViewRequest:actions.completeViewRequest
            },{only:active.id}),[active,viewRequest,openView,actions.completeViewRequest,renderSlot]);
            if (session.blank && conversationPhase(session, conversation) === "blank") return null;'''
        if before not in segment: raise RuntimeError('View mounting changed; review draft isolation')
        segment = segment.replace(before, after, 1)
        before = '''children: active !== void 0 && renderSlot("conversation.view", {
					viewRequest,
					openView,
					completeViewRequest: actions.completeViewRequest
				}, { only: active.id })'''
        if before not in segment: raise RuntimeError('View slot changed; review draft isolation')
        segment = segment.replace(before, 'children: viewContent', 1)
        source = source[:owner] + segment + source[end_owner:]
    if source != path.read_text(encoding='utf-8'):
        path.write_text(source, encoding='utf-8', newline='\n')
        changed.append(path)

    path = PACKAGES / 'dsh-client-ui-chat/lib/client.js'
    source = path.read_text(encoding='utf-8')
    before = '''if (!readerMovedScroll(el.scrollTop, floor, observedTopRef.current)) {
							sample();
							return;
						}'''
    after = '''if (!readerMovedScroll(el.scrollTop, floor, observedTopRef.current)) {
                            // QCODERI_SCROLL_ECHO: programmatic follow-scroll is
                            // already reflected in refs. Do not re-render the
                            // entire transcript to sample our own scroll write.
                            scrollSamplePendingRef.current = false;
                            if (sampleTimer !== undefined) window.clearTimeout(sampleTimer);
                            sampleTimer = undefined;
                            return;
                        }'''
    if 'QCODERI_SCROLL_ECHO' not in source:
        if before not in source: raise RuntimeError('Chat scroll hot path changed; review optimization')
        source = source.replace(before, after, 1)
        path.write_text(source, encoding='utf-8', newline='\n')
        changed.append(path)
    return changed

if __name__ == '__main__':
    for path in apply(): print(path)
