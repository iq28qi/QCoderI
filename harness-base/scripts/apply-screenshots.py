"""Install durable screenshots and their always-visible conversation preview."""
from pathlib import Path
import runpy

BASE = Path(__file__).resolve().parents[1]

def apply():
    runpy.run_path(str(BASE / 'scripts/build.py'))['sync_team']()
    path = BASE / 'source/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js'
    source = path.read_text(encoding='utf-8')
    start, end = '// QCODERI_SCREENSHOT_VIEW_BEGIN', '// QCODERI_SCREENSHOT_VIEW_END'
    view = (BASE / 'assets/screenshot-view.js').read_text(encoding='utf-8').replace(
        start, start + '\n' + (BASE / 'assets/report-view.js').read_text(encoding='utf-8').rstrip(), 1).rstrip()
    if start in source:
        begin = source.index(start)
        finish = source.index(end, begin) + len(end)
        source = source[:begin] + view + source[finish:]
    else:
        anchor = '\t\tconst ChatNodeSeat = '
        if source.count(anchor) != 1:
            raise RuntimeError('Image tool view anchor changed')
        source = source.replace(anchor, view + '\n' + anchor, 1)
    if 'const screenshotCards = ' not in source:
        anchor = '\t\t\tconst routedNode = node;'
        if source.count(anchor) != 1:
            raise RuntimeError('Chat node anchor changed')
        source = source.replace(anchor, anchor + '\n\t\t\tconst screenshotCards = (0, react.useMemo)(() => qcScreenshotItems(routedNode), [routedNode]);', 1)
        source = source.replace('const processHidden = controllerInactive || foldable && processMember && !processOpen;',
                                'const processHidden = screenshotCards.length === 0 && (controllerInactive || foldable && processMember && !processOpen);', 1)
        anchor = 'children: renderSlot("conversation.chat.node", routedOwner, {'
        source = source.replace(anchor, 'children: qcScreenshotView(screenshotCards, renderMessageImages, routedNode, renderSlot("conversation.chat.node", routedOwner, {', 1)
        anchor = 'payload: routedNode.data,\n\t\t\t\t\t\ttruncatedLabel: (total) => t("json.truncated", { total })\n\t\t\t\t\t})\n\t\t\t\t})'
        if source.count(anchor) != 1:
            raise RuntimeError('Chat node renderer end changed')
        source = source.replace(anchor, anchor + ')', 1)
    if 'imageGroup, useChatNode' not in source:
        source = source.replace('function ChatNodeSeat({ nodeKey, useChatNode', 'function ChatNodeSeat({ nodeKey, imageGroup, useChatNode', 1)
        source = source.replace('() => qcScreenshotItems(routedNode), [routedNode]',
            '() => imageGroup ?? qcScreenshotItems(routedNode), [imageGroup, routedNode]', 1)
        source = source.replace('function ChatNodeList({ order, ...seatProps })', 'function ChatNodeList({ order, imageGroups, ...seatProps })', 1)
        source = source.replace('return order.map((nodeKey) => (0, react_jsx_runtime.jsx)(ChatNodeSeat, {',
            'return order.map((nodeKey) => imageGroups?.get(nodeKey) === null ? null : (0, react_jsx_runtime.jsx)(ChatNodeSeat, {', 1)
        source = source.replace('\t\t\t\tnodeKey,\n\t\t\t\t...seatProps',
            '\t\t\t\tnodeKey,\n\t\t\t\timageGroup: imageGroups?.get(nodeKey),\n\t\t\t\t...seatProps', 1)
    if source != path.read_text(encoding='utf-8'):
        path.write_text(source, encoding='utf-8', newline='\n')
    attachment_path = path.parents[2] / 'dsh-client-ui-attachment/lib/client.js'
    native = attachment_path.read_text(encoding='utf-8')
    start = '// QCODERI_IMAGE_GALLERY_BEGIN'
    end = '// QCODERI_IMAGE_GALLERY_END'
    implementation = (BASE / 'assets/image-gallery.js').read_text(encoding='utf-8').rstrip()
    if start in native:
        begin = native.index(start)
        finish = native.index(end, begin) + len(end)
    else:
        begin = native.index('\t\tfunction ImageGallery(')
        finish = native.index('\n\t\t//#endregion', begin)
    attachment_path.write_text(native[:begin] + implementation + native[finish:], encoding='utf-8', newline='\n')
    print('Screenshot integration: ready')

if __name__ == '__main__':
    apply()
