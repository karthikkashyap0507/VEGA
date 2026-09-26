import { Studio } from './studio';

export const metadata = { title: 'Agent Studio' };

export default function StudioPage() {
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4">
      <header className="grid gap-1">
        <h1 className="text-lg font-semibold">Agent Studio</h1>
        <p className="text-sm text-muted">What an agent is for, what it may touch, when it runs, and how far it may go. Every save is a new version.</p>
      </header>
      <Studio />
    </div>
  );
}
