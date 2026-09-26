import { ProgramSandbox } from './program-sandbox';

export const metadata = { title: 'Chat' };

/**
 * The conversational surface. Module 4 adds objectives in plain language and the planner that
 * turns them into programs; Module 3 ships the part that makes it safe to look at a plan: the
 * sandbox, provenance chips and the security explanation panel.
 */
export default function ChatPage() {
  return (
    <div className="grid gap-4">
      <header className="mx-auto grid w-full max-w-5xl gap-1">
        <h1 className="text-lg font-semibold">Conversational surface</h1>
        <p className="text-sm text-muted">
          Plain-language objectives arrive with the planner (Module 4). Every plan it writes runs through the interpreter below: your instruction is the only trusted input, and every
          claim traces back to its source.
        </p>
      </header>
      <ProgramSandbox />
    </div>
  );
}
