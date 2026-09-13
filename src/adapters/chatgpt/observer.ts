import { ConversationIndex } from '../../conversation';
import { createIdleBatch } from '../../utils/debounce';

export function observeConversation(index: ConversationIndex): () => void {
  const batch = createIdleBatch(() => index.flush());
  const observer = new MutationObserver(mutations => {
    if (index.applyMutations(mutations)) batch.schedule();
  });
  observer.observe(index.root, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['data-message-id', 'data-message-author-role', 'data-turn-id', 'data-turn-id-container',
      'data-testid', 'data-turn', 'hidden', 'aria-hidden', 'open', 'data-is-streaming', 'data-message-status', 'style'],
  });
  return () => { observer.disconnect(); batch.cancel(); };
}
