import { createRoot } from 'react-dom/client';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import Navigator from '../../src/components/Navigator';
import { ConversationController } from '../../src/conversation/controller';
import { normalizeSettings, settingsItem } from '../../src/settings';

export default defineContentScript({
  matches: ['https://chatgpt.com/*'],
  cssInjectionMode: 'ui',
  runAt: 'document_idle',
  async main(ctx) {
    let settings = normalizeSettings(await settingsItem.getValue());
    if (ctx.isInvalid) return;
    const controller = new ConversationController(settings);
    const ui = await createShadowRootUi(ctx, {
      name: 'chatpilot-ui', mode: 'open', position: 'overlay', zIndex: 1000,
      anchor: 'body', append: 'last', isolateEvents: true,
      onMount(container) {
        const wrapper = document.createElement('div');
        wrapper.lang = 'zh-CN';
        container.append(wrapper);
        const root = createRoot(wrapper);
        root.render(<Navigator controller={controller} settings={settings} />);
        return root;
      },
      onRemove(root) { root?.unmount(); },
    });
    if (ctx.isInvalid) { controller.dispose(); return; }
    ui.mount();
    controller.start();
    const unwatch = settingsItem.watch(value => {
      settings = normalizeSettings(value);
      controller.setSettings(settings);
      ui.mounted?.render(<Navigator controller={controller} settings={settings} />);
    });
    ctx.addEventListener(window, 'wxt:locationchange', event => controller.onLocationChange(event.newUrl));
    ctx.onInvalidated(() => { unwatch(); controller.dispose(); ui.remove(); });
  },
});
