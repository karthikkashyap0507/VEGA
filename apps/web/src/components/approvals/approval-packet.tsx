'use client';
import { useEffect, useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { approvalActions, type PacketView } from '@/lib/approvals';
import { DecisionPacket } from './decision-packet';

/** A run's approval, decided where the run is shown (chat), through the same hashed packet. */
export function ApprovalPacket({ requestId, onDone }: { requestId: string; onDone: () => void }) {
  const [view, setView] = useState<PacketView | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    approvalActions.packet(requestId).then(setView).catch(setError);
  }, [requestId]);
  if (error) return <ErrorText error={error} />;
  if (!view) return <p className="text-xs text-muted">Loading the decision…</p>;
  return (
    <DecisionPacket
      view={view}
      compact
      onDecide={async (decision, extra) => {
        await approvalActions.decide(requestId, { decision, packetDigest: view.digest, ...extra });
        onDone();
      }}
    />
  );
}
