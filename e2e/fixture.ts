export interface FixtureOptions {
  conversation?: 'a' | 'b' | 'new';
}

const turns = [
  { role: 'user', text: '请给出部署计划。' },
  { role: 'assistant', text: '第一步：创建可回滚的备份。' },
  { role: 'user', text: '代码示例也请保留。' },
  { role: 'assistant', text: '使用下面的代码：', code: 'print("```")\nprint("done")' },
  { role: 'user', text: '请汇总状态。' },
  { role: 'assistant', text: '状态表如下。', table: true },
  { role: 'user', text: '公式是什么？' },
  { role: 'assistant', text: '能量关系：', math: true },
  { role: 'user', text: `前置内容 ${'填充 '.repeat(32)}needle-full-body` },
  { role: 'assistant', text: '完整索引会保留这一条回答。' },
  { role: 'user', text: '最后一个问题。' },
  { role: 'assistant', text: '最后一个答案。' },
] as const;

const serializedTurns = JSON.stringify(turns).replace(/</g, '\\u003c');

/**
 * A self-contained, network-free ChatGPT-like conversation. Persistent shells
 * emulate virtualized history: sections are replaced as the feed scrolls.
 */
export function chatGptFixture(options: FixtureOptions = {}): string {
  const conversation = options.conversation ?? 'a';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>ChatPilot Fixture ${conversation.toUpperCase()}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { block-size: 100%; margin: 0; font-family: system-ui, sans-serif; }
    #fixture-header { block-size: 64px; display: flex; align-items: center; padding: 0 28px; border-bottom: 1px solid #ddd; }
    #conversation-feed { block-size: calc(100vh - 176px); overflow-y: auto; padding: 20px max(24px, calc((100vw - 780px) / 2)); scroll-behavior: auto; }
    [data-fixture-slot] { min-block-size: 230px; padding: 12px 0; }
    [data-testid^="conversation-turn-"] { border-radius: 10px; padding: 14px; background: #f6f7f8; }
    [data-turn="user"] { background: #eef5ff; }
    pre { background: #17232c; color: #f5f7fa; overflow: auto; padding: 10px; }
    table { border-collapse: collapse; } td, th { border: 1px solid #8b98a5; padding: 4px 8px; }
    #fixture-composer { block-size: 112px; display: flex; align-items: center; justify-content: center; border-top: 1px solid #ddd; background: #fff; }
  </style>
</head>
<body>
  <header id="fixture-header">Synthetic ChatGPT header</header>
  <main id="conversation-feed" aria-label="Conversation"></main>
  <footer id="fixture-composer"><form><label>Synthetic composer <textarea id="prompt-textarea" aria-label="Synthetic prompt"></textarea></label><button type="submit" data-testid="send-button">Send synthetic prompt</button></form></footer>
  <script>
    (() => {
      const turns = ${serializedTurns};
      const feed = document.querySelector('#conversation-feed');
      let currentConversation = ${JSON.stringify(conversation)};
      let activeTurns = [];
      let messageIds = [];

      function section(index, turn) {
        const number = index + 1;
        const shellKey = currentConversation + '-shell-' + number;
        const messageId = messageIds[index] ?? currentConversation + '-message-' + number;
        const details = turn.code
          ? '<pre><code class="language-python">' + turn.code.replaceAll('&', '&amp;').replaceAll('<', '&lt;') + '</code></pre>'
          : turn.table
            ? '<table><thead><tr><th>项目</th><th>状态</th></tr></thead><tbody><tr><td>备份</td><td>完成</td></tr><tr><td>验证</td><td>部分</td></tr></tbody></table>'
            : turn.math
              ? '<span class="katex"><span aria-hidden="true">E = mc²</span><span class="sr-only">E = mc^2</span></span>'
              : '';
        return '<section data-testid="conversation-turn-' + number + '" data-turn="' + turn.role + '" data-turn-id="' + shellKey + '" data-turn-id-container="' + shellKey + '"><div data-message-author-role="' + turn.role + '" data-message-id="' + messageId + '"><p>' + turn.text + '</p>' + details + '</div></section>';
      }

      function renderTurn(shell, index) {
        shell.innerHTML = section(index, activeTurns[index]);
      }

      function clearTurn(shell) {
        shell.replaceChildren();
      }

      function shells() {
        return Array.from(feed.children).filter(shell => shell.hasAttribute('data-fixture-slot'));
      }

      function renderWindow() {
        const midpoint = Math.round(feed.scrollTop / 230);
        shells().forEach((shell, index) => {
          if (Math.abs(index - midpoint) <= 2) {
            if (!shell.querySelector(':scope > section')) renderTurn(shell, index);
          } else if (shell.querySelector(':scope > section')) clearTurn(shell);
        });
      }

      function renderConversation() {
        feed.replaceChildren();
        activeTurns = turns.map(turn => ({ ...turn }));
        messageIds = activeTurns.map((_turn, index) => currentConversation + '-message-' + (index + 1));
        activeTurns.forEach((_turn, index) => {
          const shell = document.createElement('div');
          shell.dataset.turnIdContainer = currentConversation + '-shell-' + (index + 1);
          shell.dataset.fixtureSlot = String(index + 1);
          feed.append(shell);
          if (index >= turns.length - 4) renderTurn(shell, index);
        });
        const sentinel = document.createElement('div');
        sentinel.dataset.turnIdContainer = 'client-created-root';
        feed.append(sentinel);
        feed.scrollTop = feed.scrollHeight;
        renderWindow();
      }

      feed.addEventListener('scroll', () => requestAnimationFrame(renderWindow));
      document.querySelector('#fixture-composer form').addEventListener('submit', event => {
        event.preventDefault();
        if (currentConversation !== 'new') return;
        const number = activeTurns.length + 1;
        activeTurns.push({ role: 'user', text: 'Synthetic newly submitted prompt.' });
        messageIds.push('new-message-' + number);
        const shell = document.createElement('div');
        shell.dataset.turnIdContainer = 'new-shell-' + number;
        shell.dataset.fixtureSlot = String(number);
        feed.insertBefore(shell, feed.querySelector('[data-turn-id-container="client-created-root"]'));
        renderTurn(shell, number - 1);
        history.pushState({}, '', '/c/promoted');
      });
      window.__chatpilotFixture = {
        scrollToTurn(number) {
          const shell = feed.querySelector('[data-fixture-slot="' + number + '"]');
          shell?.scrollIntoView({ block: 'center' });
          renderWindow();
        },
        replaceConversation(next) {
          currentConversation = next;
          history.pushState({ conversation: next }, '', next === 'new' ? '/' : '/c/' + next);
          renderConversation();
        },
        setPath(next) {
          currentConversation = next;
          history.pushState({ conversation: next }, '', next === 'new' ? '/' : '/c/' + next);
        },
        renderCurrentConversation() {
          renderConversation();
        },
        renderConversationData(next) {
          currentConversation = next;
          renderConversation();
        },
        stream(number, suffix) {
          activeTurns[number - 1].text += suffix;
          const text = feed.querySelector('[data-fixture-slot="' + number + '"] p');
          if (text?.firstChild) text.firstChild.data += suffix;
        },
        replaceBranch(number) {
          const shell = feed.querySelector('[data-fixture-slot="' + number + '"]');
          if (!shell) return;
          activeTurns[number - 1] = { role: 'assistant', text: '分支替换后的答案。' };
          messageIds[number - 1] = currentConversation + '-branch-message-' + number;
          renderTurn(shell, number - 1);
        },
        showUnrenderable() {
          feed.replaceChildren();
          const shell = document.createElement('div');
          shell.dataset.turnIdContainer = 'unrenderable-shell';
          feed.append(shell);
        },
        feed,
      };
      renderConversation();
    })();
  </script>
</body>
</html>`;
}

declare global {
  interface Window {
    __chatpilotFixture?: unknown;
  }
}
