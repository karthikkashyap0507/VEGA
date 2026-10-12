'use client';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { Fingerprint } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { DecisionPacket } from '@/components/approvals/decision-packet';
import { ErrorText } from '@/components/error-text';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/api';
import { approvalActions, type PacketView } from '@/lib/approvals';

/**
 * APPROVE FROM A PHONE — docs/module8.md §6.3. Asymmetric on purpose:
 *
 *   Reject   nothing — the safe action is always the fastest (the push itself carries it too)
 *   Approve  this phone's biometric: a WebAuthn assertion WITH user verification, bound by the
 *            server to exactly this approval — approving from a phone is a real decision
 *
 * (Revoking a held action from the push needs nothing either — Module 6.)
 */
export default function MobileApprovalPage() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<PacketView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [needsDevice, setNeedsDevice] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    approvalActions.packet(id, 'mobile').then(setView).catch(setError);
  }, [id]);

  const registerDevice = async () => {
    setError(null);
    try {
      const options = await api.post<Parameters<typeof startRegistration>[0]['optionsJSON']>('/v1/me/devices/options');
      const response = await startRegistration({ optionsJSON: options });
      await api.post('/v1/me/devices', { response, label: navigator.userAgent.slice(0, 80) });
      setNeedsDevice(false);
    } catch (e) {
      setError(e);
    }
  };

  const approveWithBiometric = async (edits?: Record<string, unknown>) => {
    if (!view) return;
    try {
      const options = await api.post<Parameters<typeof startAuthentication>[0]['optionsJSON']>(`/v1/approvals/${id}/device-options`);
      const response = await startAuthentication({ optionsJSON: options });
      await api.post(`/v1/approvals/${id}/approve-on-device`, { response, packetDigest: view.digest, ...(edits ? { edits } : {}) });
      setDone('Approved.');
    } catch (e) {
      if (e instanceof ApiError && e.status === 428) setNeedsDevice(true);
      throw e;
    }
  };

  if (done) return <p className="mx-auto max-w-md p-6 text-center text-sm" role="status">{done}</p>;
  if (error && !view) return <ErrorText error={error} />;
  if (!view) return <p className="p-6 text-sm text-muted">Loading…</p>;
  return (
    <div className="mx-auto grid w-full max-w-md gap-3">
      {needsDevice ? (
        <div className="grid gap-2 rounded-lg border border-border bg-surface p-3 text-sm">
          <p>Approving from a phone needs this phone’s fingerprint or face. Register it once:</p>
          <Button onClick={() => void registerDevice()}>
            <Fingerprint /> Register this phone
          </Button>
        </div>
      ) : null}
      <DecisionPacket
        view={view}
        surface="mobile"
        compact
        approveLabel="Approve (biometric)"
        onDecide={async (decision, extra) => {
          if (decision === 'reject') {
            await approvalActions.decide(id, { decision: 'reject', packetDigest: view.digest, surface: 'mobile', ...(extra.reason ? { reason: extra.reason } : {}) });
            setDone('Rejected — it will not happen.');
          } else await approveWithBiometric(extra.edits);
        }}
      />
      {error ? <ErrorText error={error} /> : null}
    </div>
  );
}
