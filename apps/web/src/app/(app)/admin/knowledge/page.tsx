'use client';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BookOpen, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Table, Td, Th } from '@/components/ui/table';
import { fileToBase64, kKeys, knowledgeActions, useAclPreview, useDocuments, type KbDocument } from '@/lib/knowledge';

/**
 * KNOWLEDGE BASE ADMIN — docs/module9.md §8.2. Sources, sync status, the document list with
 * sensitivity and index state, a per-document ACL preview ("who can retrieve this"), and
 * re-index. Uploads go through base64 to the control plane (§9); parsing, chunking, classifying
 * and embedding happen server-side, self-hosted.
 */

const TAINT_TONE: Record<string, 'success' | 'info' | 'danger'> = { TRUSTED: 'success', ORG: 'info', UNTRUSTED: 'danger' };

function AclPreviewDialog({ id, title }: { id: string; title: string }) {
  const [open, setOpen] = useState(false);
  const preview = useAclPreview(open ? id : null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className="text-xs text-primary">
          Who can retrieve this
        </button>
      </DialogTrigger>
      <DialogContent title={`Who can retrieve “${title}”`} description="Every active user of the organization, checked against the document's permissions.">
        {preview.error ? <ErrorText error={preview.error} /> : null}
        {!preview.data ? (
          <p className="text-sm text-muted">Checking…</p>
        ) : (
          <ul className="grid max-h-80 gap-1 overflow-y-auto text-sm" data-testid="acl-preview-list">
            {preview.data.map((u) => (
              <li key={u.userId} className="flex items-center justify-between gap-2">
                <span className="truncate">{u.email}</span>
                <Badge tone={u.canRead ? 'success' : 'neutral'}>{u.canRead ? 'can retrieve' : 'no access'}</Badge>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DocumentRow({ d, onChanged }: { d: KbDocument; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <tr data-testid="kb-document-row">
        <Td>
          <p className="font-medium">{d.title}</p>
          <p className="text-xs text-muted">
            {d.sourceKind} · {d.mime}
          </p>
        </Td>
        <Td>
          <Badge tone={TAINT_TONE[d.taint]}>{d.taint}</Badge>
        </Td>
        <Td>
          {d.sensitivity >= 70 ? (
            <span className="flex items-center gap-1 text-risk-high">
              <AlertTriangle aria-hidden className="size-3.5" /> {d.sensitivity}
            </span>
          ) : (
            d.sensitivity
          )}
          {d.labels.length ? <p className="text-xs text-muted">{d.labels.join(', ')}</p> : null}
        </Td>
        <Td>
          <Badge tone={d.state === 'indexed' ? 'success' : d.state === 'failed' ? 'danger' : 'neutral'}>{d.state}</Badge>
          {d.error ? <p className="text-xs text-danger">{d.error}</p> : null}
        </Td>
        <Td className="text-right tabular-nums">{d.chunks}</Td>
        <Td>
          <div className="flex flex-wrap items-center gap-2">
            <AclPreviewDialog id={d.id} title={d.title} />
            <button type="button" className="text-xs text-primary disabled:opacity-50" disabled={busy} onClick={() => run(() => knowledgeActions.reindex(d.id))}>
              <RefreshCw aria-hidden className="mr-0.5 inline size-3" /> Re-index
            </button>
            <button type="button" className="text-xs text-danger disabled:opacity-50" disabled={busy} onClick={() => confirm(`Delete “${d.title}”? Its chunks and permissions go with it.`) && run(() => knowledgeActions.deleteDocument(d.id))}>
              <Trash2 aria-hidden className="mr-0.5 inline size-3" /> Delete
            </button>
          </div>
        </Td>
      </tr>
      {error ? (
        <tr>
          <Td colSpan={6}>
            <ErrorText error={error} />
          </Td>
        </tr>
      ) : null}
    </>
  );
}

export default function KnowledgeAdminPage() {
  const qc = useQueryClient();
  const docs = useDocuments();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    try {
      const dataBase64 = await fileToBase64(file);
      await knowledgeActions.upload({ title: file.name, mime: file.type || 'text/plain', dataBase64 });
      await qc.invalidateQueries({ queryKey: kKeys.documents() });
    } catch (e) {
      setError(e);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  if (docs.error) return <ErrorText error={docs.error} />;

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="grid gap-0.5">
              <CardTitle>Knowledge base</CardTitle>
              <CardDescription>Documents agents can retrieve — parsed by structure, classified, embedded self-hosted, and gated by the same permissions as the source.</CardDescription>
            </div>
            <div>
              <input ref={fileRef} type="file" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} accept=".txt,.md,.html,.docx,text/plain,text/markdown,text/html,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
              <Button size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
                <Upload /> {uploading ? 'Uploading…' : 'Upload document'}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-2">
          {error ? <ErrorText error={error} /> : null}
          {!docs.data?.length ? (
            <EmptyState icon={BookOpen} title="No documents yet" module="Module 9" description="Upload text, Markdown, HTML or DOCX — PDFs and slide decks need Docling configured. Each document's permissions mirror who could already open it.">
              Nothing indexed
            </EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Document</Th>
                  <Th>Taint</Th>
                  <Th>Sensitivity</Th>
                  <Th>State</Th>
                  <Th className="text-right">Chunks</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {docs.data.map((d) => (
                  <DocumentRow key={d.id} d={d} onChanged={() => qc.invalidateQueries({ queryKey: kKeys.documents() })} />
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
