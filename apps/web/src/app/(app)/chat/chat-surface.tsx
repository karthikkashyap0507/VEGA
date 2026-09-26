'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, MessageSquarePlus, Send } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { RunCard } from '@/components/runs/run-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { useAgents } from '@/lib/queries';
import { runKeys, useConversations, useThread, type Conversation } from '@/lib/runs';
import { cn } from '@/lib/utils';

/**
 * The chat surface (docs/module4.md §6.1). Threads per agent; each message is an objective that
 * becomes a run; the agent's side of the thread is that run — live progress, the action card it
 * waits on, its result with provenance.
 */
export function ChatSurface() {
  const qc = useQueryClient();
  const agents = useAgents();
  const active = (agents.data ?? []).filter((a) => a.status === 'active');
  const threads = useConversations();
  const [current, setCurrent] = useState<string | undefined>();
  const [agentId, setAgentId] = useState<string>('');
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [sending, setSending] = useState(false);
  const thread = useThread(current);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!agentId && active[0]) setAgentId(active[0].id);
  }, [active, agentId]);
  useEffect(() => {
    if (!current && threads.data?.[0]) setCurrent(threads.data[0].id);
  }, [threads.data, current]);
  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [thread.data?.messages.length]);

  const agentName = (id: string) => agents.data?.find((a) => a.id === id)?.name ?? 'agent';

  async function newThread(): Promise<string | undefined> {
    if (!agentId) return undefined;
    const c = await api.post<Conversation>('/v1/conversations', { agentId });
    await qc.invalidateQueries({ queryKey: runKeys.conversations });
    setCurrent(c.id);
    return c.id;
  }

  async function send() {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    try {
      const id = current ?? (await newThread());
      if (!id) return;
      await api.post(`/v1/conversations/${id}/messages`, { text: body });
      setText('');
      await qc.invalidateQueries({ queryKey: runKeys.thread(id) });
      await qc.invalidateQueries({ queryKey: runKeys.conversations });
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
    }
  }

  if (agents.isSuccess && !active.length) {
    return (
      <Card>
        <CardContent className="grid justify-items-center gap-2 p-8 text-center">
          <Bot aria-hidden className="size-8 text-muted" />
          <p className="font-medium">No active agent yet</p>
          <p className="text-sm text-muted">Give an agent a spec — its tools, limits and triggers — and it becomes available here.</p>
          <Button asChild size="sm">
            <Link href="/studio">Open Agent Studio</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
      <aside className="grid content-start gap-2" aria-label="Conversations">
        <label className="grid gap-1 text-xs">
          <span className="text-muted">Agent</span>
          <select className="h-8 rounded-md border border-border bg-surface px-2 text-sm" value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Agent">
            {active.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" variant="secondary" onClick={() => void newThread()} disabled={!agentId}>
          <MessageSquarePlus aria-hidden /> New conversation
        </Button>
        <ul className="grid gap-1">
          {(threads.data ?? []).map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setCurrent(c.id)}
                className={cn('w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-muted', current === c.id && 'bg-surface-muted font-medium')}
                title={c.title}
              >
                {c.title}
                <span className="block text-xs font-normal text-muted">{agentName(c.agentId)}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="grid min-h-[28rem] grid-rows-[1fr_auto] gap-3 rounded-lg border border-border bg-surface p-3" aria-label="Conversation">
        <div className="grid content-start gap-3 overflow-y-auto" data-testid="thread">
          {!thread.data?.messages.length ? (
            <p className="text-sm text-muted">
              Ask for something in plain language — “Email Peter saying the numbers are attached”, “Schedule a meeting with Sam on 2026-10-05 at 14:00”. Mention{' '}
              <code>@gmail</code> or <code>@calendar</code> to point at a connector.
            </p>
          ) : null}
          {thread.data?.messages.map((m) =>
            m.role === 'user' ? (
              <p key={m.id} className="max-w-[80%] justify-self-end whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground" data-testid="user-message">
                {m.body}
              </p>
            ) : m.role === 'agent' && m.runId ? (
              <div key={m.id} className="max-w-[92%]">
                <RunCard runId={m.runId} />
              </div>
            ) : (
              <p key={m.id} className="text-sm text-risk-critical">
                {m.body}
              </p>
            ),
          )}
          <div ref={bottom} />
        </div>
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="flex gap-2">
            <textarea
              className="min-h-[2.5rem] flex-1 resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm"
              placeholder="What should the agent do?"
              aria-label="Message"
              value={text}
              maxLength={4000}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <Button type="submit" disabled={sending || !text.trim()} aria-label="Send">
              <Send aria-hidden />
            </Button>
          </div>
          {error ? <ErrorText error={error} /> : null}
        </form>
      </section>
    </div>
  );
}
