/** Golden vectors, shared by the verifier's and the writer's canonicalization tests. */

/** RFC 8785 Appendix B: IEEE-754 bit patterns → their canonical text. */
export const NUMBERS: Array<[string, string]> = [
  ['0000000000000000', '0'],
  ['8000000000000000', '0'],
  ['0000000000000001', '5e-324'],
  ['8000000000000001', '-5e-324'],
  ['7fefffffffffffff', '1.7976931348623157e+308'],
  ['ffefffffffffffff', '-1.7976931348623157e+308'],
  ['4340000000000000', '9007199254740992'],
  ['c340000000000000', '-9007199254740992'],
  ['4430000000000000', '295147905179352830000'],
  ['44b52d02c7e14af5', '9.999999999999997e+22'],
  ['44b52d02c7e14af6', '1e+23'],
  ['44b52d02c7e14af7', '1.0000000000000001e+23'],
  ['444b1ae4d6e2ef4e', '999999999999999700000'],
  ['444b1ae4d6e2ef4f', '999999999999999900000'],
  ['444b1ae4d6e2ef50', '1e+21'],
  ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
  ['3eb0c6f7a0b5ed8d', '0.000001'],
  ['41b3de4355555553', '333333333.3333332'],
  ['41b3de4355555554', '333333333.33333325'],
  ['41b3de4355555555', '333333333.3333333'],
  ['41b3de4355555556', '333333333.3333334'],
  ['41b3de4355555557', '333333333.33333343'],
  ['becbf647612f3696', '-0.0000033333333333333333'],
  ['43143ff3c1cb0959', '1424953923781206.2'],
];

export const bits = (hex: string): number => new DataView(Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16))).buffer).getFloat64(0);

/** RFC 8785 §3.2.2 and §3.2.3 examples, plus the chain's own shapes. */
export const DOCUMENTS: Array<{ name: string; value: unknown; jcs: string }> = [
  {
    name: 'RFC 8785 §3.2.2 sample',
    // The RFC's own input: the literal is deliberately not representable (it canonicalizes to 333333333.3333333).
    // eslint-disable-next-line no-loss-of-precision
    value: { numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001], string: ['\u20ac', '$', '\u000f', '\n', 'A', "'", 'B', '"', '\u005c', '\u005c', '"', '/'].join(''), literals: [null, true, false] },
    jcs: "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"\u20ac$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}",
  },
  {
    name: 'RFC 8785 §3.2.3 sorting',
    value: { '\u20ac': 'Euro Sign', '\r': 'Carriage Return', '\ufb33': 'Hebrew Letter Dalet With Dagesh', '1': 'One', '\ud83d\ude00': 'Emoji: Grinning Face', '\u0080': 'Control', '\u00f6': 'Latin Small Letter O With Diaeresis' },
    jcs: "{\"\\r\":\"Carriage Return\",\"1\":\"One\",\"\u0080\":\"Control\",\"\u00f6\":\"Latin Small Letter O With Diaeresis\",\"\u20ac\":\"Euro Sign\",\"\ud83d\ude00\":\"Emoji: Grinning Face\",\"\ufb33\":\"Hebrew Letter Dalet With Dagesh\"}",
  },
  { name: 'nested, empty, undefined members', value: { b: [], a: {}, c: { z: 1, y: undefined, x: [1, 'two', null] } }, jcs: '{"a":{},"b":[],"c":{"x":[1,"two",null],"z":1}}' },
  { name: 'controls and escapes', value: { s: '\u0000\u0007\b\f\n\r\t\u001f "\\ /' }, jcs: '{"s":"\\u0000\\u0007\\b\\f\\n\\r\\t\\u001f \\"\\\\ /"}' },
  {
    name: 'a receipt',
    value: { action_id: 'a1', tool: { id: 'gmail.send', reversibility: 'R2' }, risk: { score: 68, tier: 'HIGH', weights_version: 4 }, arguments_digest: `sha256:${'ab'.repeat(32)}` },
    jcs: `{"action_id":"a1","arguments_digest":"sha256:${'ab'.repeat(32)}","risk":{"score":68,"tier":"HIGH","weights_version":4},"tool":{"id":"gmail.send","reversibility":"R2"}}`,
  },
];
