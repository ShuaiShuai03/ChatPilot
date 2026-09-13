import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  manifest: {
    name: 'ChatPilot',
    description: '在本地浏览、搜索、选择和导出 ChatGPT 对话。',
    permissions: ['storage'],
    icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
    action: { default_title: 'ChatPilot 设置' },
  },
});
