{{- define "ns.experience" -}}{{ .Values.prefix }}-experience{{- end -}}
{{- define "ns.control" -}}{{ .Values.prefix }}-control{{- end -}}
{{- define "ns.execution" -}}{{ .Values.prefix }}-execution{{- end -}}
{{- define "ns.evidence" -}}{{ .Values.prefix }}-evidence{{- end -}}

{{- define "labels" -}}
app.kubernetes.io/part-of: {{ .root.Values.prefix }}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
platform/plane: {{ .plane }}
{{- end -}}

{{/* Hardened pod defaults shared by every workload. */}}
{{- define "podSecurity" -}}
automountServiceAccountToken: false
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
  seccompProfile: { type: RuntimeDefault }
{{- end -}}

{{- define "containerSecurity" -}}
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities: { drop: [ALL] }
{{- end -}}

{{/* mTLS certificate for a workload, mounted at /tls. */}}
{{- define "tlsVolume" -}}
{{- if .root.Values.mtls.enabled }}
- name: tls
  secret:
    secretName: {{ .name }}-tls
    defaultMode: 0440
{{- end }}
- name: tmp
  emptyDir: {}
{{- end -}}

{{- define "tlsMount" -}}
{{- if .Values.mtls.enabled }}
- { name: tls, mountPath: /tls, readOnly: true }
{{- end }}
- { name: tmp, mountPath: /tmp }
{{- end -}}

{{- define "tlsEnv" -}}
{{- if .Values.mtls.enabled }}
- { name: TLS_CERT_PATH, value: /tls/tls.crt }
- { name: TLS_KEY_PATH, value: /tls/tls.key }
- { name: TLS_CA_PATH, value: /tls/ca.crt }
{{- end }}
{{- end -}}

{{- define "scheme" -}}{{ if .Values.mtls.enabled }}https{{ else }}http{{ end }}{{- end -}}
