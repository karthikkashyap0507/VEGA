import { describe, expect, it } from 'vitest';
import { launchRegistry } from '@vega/connectors';
import { callsOf, parse, ParseError, print, ProgramSchema, validate, type ValidationEnv } from '../src/index.js';

const registry = launchRegistry();
const records = new Map(registry.records().map((r) => [r.toolId, r]));
const env: ValidationEnv = {
  tool: (id) => records.get(id),
  hasSchema: (n) => ['MeetingRequest', 'Invoice', 'Summary'].includes(n),
  hasTemplate: (n) => ['meeting-offer', 'reply'].includes(n),
};
const codes = (src: string) => validate(parse(src), env).errors.map((e) => e.code);

const MEETING = `
-- The docs/module3.md §6.4 example, against the real launch declarations.
let inbox    = call gmail.search({ query: "from:acme.com is:unread" })
let messages = map inbox.messages as m { call gmail.read({ messageId: m.id }) }
let request  = extract messages into MeetingRequest
let sender   = resolve request.fromEmail in contacts
when count(request.proposedTimes) > 0 {
  call gmail.draft({
    to: [sender.email],
    subject: "Re: " + request.subject,
    body: render("meeting-offer", { times: request.proposedTimes })
  }) as draft
  emit draft
}
`;

describe('parser', () => {
  it('parses the canonical example into a schema-valid AST with node ids in source order', () => {
    const p = parse(MEETING);
    expect(ProgramSchema.safeParse(p).success).toBe(true);
    expect(callsOf(p).map((c) => [c.id, c.tool])).toEqual([
      ['n1', 'gmail.search'],
      ['n2', 'gmail.read'],
      ['n4', 'gmail.draft'],
    ]);
  });

  it('round-trips through the printer', () => {
    const p = parse(MEETING);
    expect(parse(print(p))).toEqual(p);
    const q = parse(`let x = (a + b) + "c"\nlet a = 1\nwhen not (x == "y") and true { emit x.z[0]["odd key"] } otherwise { emit coalesce(x, null) }`);
    expect(parse(print(q))).toEqual(q);
  });

  it.each([
    ['let = 1', /identifier/],
    ['let x = "unterminated', /unterminated string/],
    ['call gmail({})', /connector\.tool/],
    ['call gmail.send([1])', /object literal/],
    ['emit {a: 1, a: 2}', /duplicate key/],
    ['let x = 1 +', /unexpected end/],
    ['let x = map y as m limit 0 { m }', /positive integer/],
    ['let x = exec("rm -rf /")', /expected let|unexpected/], // no builtins: an unknown name followed by ( is not a call
    ['let x = y @ z', /unexpected character/],
  ])('rejects %s', (src, re) => {
    expect(() => parse(src)).toThrow(ParseError);
    expect(() => parse(src)).toThrow(re);
  });
});

describe('static validation', () => {
  it('accepts the example; the draft needs no approval, all reads are used', () => {
    const r = validate(parse(MEETING), env);
    expect(r.errors).toEqual([]);
    // A draft is INTERNAL with maxTaint UNTRUSTED: nobody receives anything yet.
    expect(r.calls.find((c) => c.toolId === 'gmail.draft')).toMatchObject({ expected: 'PROCEED', recipients: [] });
  });

  it('sending to a RESOLVED contact passes the recipient rule but still needs approval', () => {
    const r = validate(
      parse(`let m = call gmail.read({ messageId: "1" })
             let req = extract m into MeetingRequest
             let who = resolve req.fromEmail in contacts
             call gmail.send({ to: [who.email], subject: "Re", body: "Thursday works" })`),
      env,
    );
    expect(r.errors).toEqual([]);
    expect(r.calls.at(-1)).toMatchObject({ recipients: [{ path: 'to[0]', dataTaint: 'TRUSTED' }], argTaint: 'UNTRUSTED', expected: 'REQUIRE_APPROVAL' });
  });

  it('rejects an untrusted recipient statically (CRITICAL, no approval path)', () => {
    const r = validate(
      parse(`let inbox = call gmail.search({ query: "x" })
             let req = extract inbox into MeetingRequest
             call gmail.send({ to: [req.fromEmail], subject: "hi", body: "x" })`),
      env,
    );
    expect(r.errors).toMatchObject([{ code: 'TAINT_RECIPIENT', severity: 'CRITICAL', path: 'to[0]' }]);
  });

  it('summarizing does not launder: a summary of untrusted content used as a recipient is refused', () => {
    expect(codes(`let m = call gmail.read({ messageId: "1" })
                  let s = extract m into Summary
                  call gmail.send({ to: s.recipient, subject: "x", body: "y" })`)).toContain('TAINT_RECIPIENT');
  });

  it('untrusted content in an external send body requires approval, not rejection', () => {
    const r = validate(
      parse(`let m = call gmail.read({ messageId: "1" })
             let s = extract m into Summary
             call gmail.send({ to: ["boss@acme.example"], subject: "FYI", body: s.text })`),
      env,
    );
    expect(r.errors).toEqual([]);
    expect(r.calls.at(-1)).toMatchObject({ toolId: 'gmail.send', argTaint: 'UNTRUSTED', expected: 'REQUIRE_APPROVAL' });
  });

  it('untrusted arguments over an INTERNAL tool ceiling are a violation (HIGH)', () => {
    expect(validate(parse(`let r = call gmail.search({ query: "x" })\ncall gmail.label({ messageId: r.messages[0].id, labelIds: ["X"] })`), env).errors).toMatchObject([
      { code: 'TAINT_CEILING', severity: 'HIGH' },
    ]);
  });

  it('implicit flow: a literal recipient inside an untrusted branch needs approval; the decision is tainted', () => {
    const r = validate(
      parse(`let m = call gmail.read({ messageId: "1" })
             let s = extract m into Summary
             when s.urgent == true { call gmail.send({ to: ["boss@acme.example"], subject: "urgent", body: "see inbox" }) }`),
      env,
    );
    expect(r.errors).toEqual([]);
    expect(r.calls.at(-1)).toMatchObject({ contextTaint: 'UNTRUSTED', argTaint: 'UNTRUSTED', expected: 'REQUIRE_APPROVAL', recipients: [{ dataTaint: 'TRUSTED' }] });
  });

  it('a branch cannot pick a value that flows out of it: branch bindings are block-scoped', () => {
    expect(codes(`let m = call gmail.read({ messageId: "1" })
                  let s = extract m into Summary
                  when s.flag == true { let to = "a@acme.example" } otherwise { let to = "b@acme.example" }
                  call gmail.send({ to: [to], subject: "x", body: "y" })`)).toContain('UNKNOWN_REF');
  });

  it.each([
    ['call gmail.teleport({})', 'UNKNOWN_TOOL'],
    ['call gmail.send({ to: ["a@b.example"], subject: "s", body: "b", bogus: 1 })', 'UNKNOWN_ARG'],
    ['call gmail.send({ to: ["a@b.example"], subject: "s" })', 'MISSING_ARG'],
    ['call gmail.send({ to: ["a@b.example"], subject: 7, body: "b" })', 'ARG_TYPE'],
    ['let m = call gmail.read({ messageId: "1" })\nemit extract m into Nope', 'UNKNOWN_SCHEMA'],
    ['emit render("nope", {})', 'UNKNOWN_TEMPLATE'],
    ['emit nothing', 'UNKNOWN_REF'],
    ['let a = 1\nlet a = 2\nemit a', 'DUPLICATE_BINDING'],
    ['let r = call gmail.search({ query: "x" })\nemit map r as m limit 5000 { m }', 'BOUND_EXCEEDED'],
    ['call gmail.send({ to: ["a@b.example"], subject: "s", body: call gmail.read({ messageId: "1" }) })', 'NESTED_CALL'],
    ['when true { emit 1 }', 'UNREACHABLE'],
    ['let r = call gmail.search({ query: "x" })', 'UNUSED_READ'],
    ['call gmail.search({ query: "x" })', 'UNUSED_READ'],
    ['emit { k: "call" }', undefined],
  ])('%s → %s', (src, code) => {
    const got = codes(src);
    if (code) expect(got).toContain(code);
    else expect(got).toEqual([]);
  });

  it('rejects ASTs that do not match the schema (a planner emitting JSON directly)', () => {
    expect(validate({ version: 1, body: [{ k: 'exec', code: 'rm -rf /' }] }, env).errors[0]?.code).toBe('SCHEMA');
    expect(validate({ version: 1, body: [{ k: 'do', call: { k: 'call', id: 'n1', tool: 'gmail.send', args: [], extra: true } }] }, env).errors[0]?.code).toBe('SCHEMA');
  });
});
