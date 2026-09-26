'use client';
import { HelpCircle } from 'lucide-react';
import { useState } from 'react';
import type { Ambiguity } from '@vega/contracts';
import { Button } from '@/components/ui/button';

/**
 * CLARIFICATION PROMPT — docs/module4.md §8.2. A blocking ambiguity: the plan would do something
 * irreversible with a name that could mean more than one person, so nothing runs until someone
 * picks. The candidates come from the directory and trusted contacts only.
 */
export function ClarificationPrompt({ ambiguity, reason, onAnswer, busy }: { ambiguity: Ambiguity; reason?: string; onAnswer: (field: string, choice: string) => Promise<unknown>; busy?: boolean }) {
  const [choice, setChoice] = useState<string>('');
  return (
    <form
      className="grid gap-3 rounded-lg border border-risk-medium bg-surface p-3"
      data-testid="clarification-prompt"
      onSubmit={(e) => {
        e.preventDefault();
        if (choice) void onAnswer(ambiguity.field, choice);
      }}
    >
      <p className="flex items-start gap-2 text-sm">
        <HelpCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-risk-medium" />
        <span>
          <strong>Which “{ambiguity.raw}”?</strong> {reason ?? 'The plan cannot be undone once it runs, so it will not guess.'}
        </span>
      </p>
      <fieldset className="grid gap-1">
        <legend className="sr-only">Candidates for {ambiguity.raw}</legend>
        {ambiguity.candidates.map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-sm">
            <input type="radio" name={`amb-${ambiguity.binding}`} value={c.id} checked={choice === c.id} onChange={() => setChoice(c.id)} />
            {c.label}
          </label>
        ))}
      </fieldset>
      <div>
        <Button size="sm" type="submit" disabled={!choice || busy}>
          Continue with this person
        </Button>
      </div>
    </form>
  );
}
