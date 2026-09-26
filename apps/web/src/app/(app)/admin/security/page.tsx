'use client';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useMe } from '@/lib/me';
import { TaintViolations, TrustedContacts } from './taint-violations';

/** Session and security — module1.md §6.2. SSO configuration is an exposed surface (D-09). */
export default function SecurityPage() {
  const me = useMe();
  const sso = me.entitlements.exposed.sso;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Single sign-on</CardTitle>
            <CardDescription>SAML and SCIM provisioning through your identity provider.</CardDescription>
          </div>
          <Badge tone={sso ? 'success' : 'neutral'}>{sso ? 'available' : 'enterprise plan'}</Badge>
        </CardHeader>
        <CardContent className="text-sm text-muted">
          {sso
            ? 'Connect your identity provider in the organization’s identity settings. SCIM provisioning completes in Module 10.'
            : 'Your organization signs in through its own identity organization today. SAML federation is exposed on the enterprise plan.'}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>How access is protected</CardTitle>
            <CardDescription>Properties that hold on every plan.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-1.5 text-sm">
            <li>Tenant data is isolated in the database itself (row-level security, forced).</li>
            <li>Session cookies are httpOnly and rotate; stolen tokens are detected on reuse.</li>
            <li>Agents act with their own short-lived credentials — never a person’s.</li>
            <li>Undo and injection defense are never plan-gated.</li>
            <li>Content from outside your organization can never choose who an agent contacts.</li>
          </ul>
        </CardContent>
      </Card>
      <TaintViolations />
      <TrustedContacts />
    </div>
  );
}
