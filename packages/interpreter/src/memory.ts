import type { DerivationRecord, Entity, EntityPort, Pager, ProgramRecord, Recorder, SourceRecord, ViolationRecord } from './ports.js';

export class MemoryRecorder implements Recorder {
  readonly programs: ProgramRecord[] = [];
  readonly sources: SourceRecord[] = [];
  readonly derivations: DerivationRecord[] = [];
  readonly violations: ViolationRecord[] = [];
  async program(p: ProgramRecord) {
    this.programs.push(p);
  }
  async source(s: SourceRecord) {
    this.sources.push(s);
  }
  async derivation(d: DerivationRecord) {
    this.derivations.push(d);
  }
  async violation(v: ViolationRecord) {
    this.violations.push(v);
  }
}

export class MemoryEntities implements EntityPort {
  constructor(private readonly entries: Partial<Record<'directory' | 'contacts', Entity[]>> = {}) {}
  async lookup(_tenantId: string, registry: 'directory' | 'contacts', key: string) {
    const k = key.trim().toLowerCase();
    return (this.entries[registry] ?? []).find((e) => e.email.toLowerCase() === k || e.id === key) ?? null;
  }
}

export class MemoryPager implements Pager {
  readonly pages: ViolationRecord[] = [];
  async page(v: ViolationRecord) {
    this.pages.push(v);
  }
}
