import { ChatTabs } from './chat-tabs';

export const metadata = { title: 'Chat' };

/**
 * The conversational surface (docs/module4.md §6.1): plain-language objectives become runs —
 * understood, planned, executed durably, streamed back as action cards. The plan sandbox
 * (Module 3) stays beside it: the same interpreter, for writing and dry-running a plan by hand.
 */
export default function ChatPage() {
  return (
    <div className="grid gap-4">
      <header className="mx-auto grid w-full max-w-6xl gap-1">
        <h1 className="text-lg font-semibold">Conversational surface</h1>
        <p className="text-sm text-muted">
          Your instruction is the only trusted input. Everything the agent reads from outside is labelled, and anything consequential shows up as an action card before it happens.
        </p>
      </header>
      <div className="mx-auto w-full max-w-6xl">
        <ChatTabs />
      </div>
    </div>
  );
}
