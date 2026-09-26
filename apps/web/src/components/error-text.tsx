import { ApiError } from '@/lib/api';

/**
 * Shows the server's own explanation: the problem `detail` is written for humans, and a
 * validation problem's field errors say exactly what to fix.
 */
export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  if (!(error instanceof ApiError)) {
    return (
      <p role="alert" className="text-xs text-danger">
        Something went wrong. Please try again.
      </p>
    );
  }
  const fields = error.problem.errors ?? [];
  return (
    <div role="alert" className="grid gap-0.5 text-xs text-danger">
      <p>{error.problem.detail ?? error.problem.title}</p>
      {fields.length ? (
        <ul className="list-disc pl-4">
          {fields.map((f, i) => (
            <li key={i}>{f.message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
