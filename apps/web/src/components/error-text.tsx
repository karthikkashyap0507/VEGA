import { ApiError } from '@/lib/api';

/** Shows the server's own explanation: the problem `detail` is written for humans. */
export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    error instanceof ApiError ? (error.problem.detail ?? error.problem.title) : 'Something went wrong. Please try again.';
  return (
    <p role="alert" className="text-xs text-danger">
      {message}
    </p>
  );
}
