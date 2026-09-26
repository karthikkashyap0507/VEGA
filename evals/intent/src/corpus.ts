/**
 * The C1 entity-resolution corpus (docs/module4.md §11: "C1 entity resolution accuracy — eval
 * set from the beachhead corpus, ≥ 95%"). A professional-services directory and contact book,
 * and the requests its people actually type: first names, full names, lower case, addresses,
 * several people at once, the genuinely ambiguous, and names nobody knows.
 *
 * Grows with every production miss; its size is a tracked metric.
 */

export const DIRECTORY = [
  { name: 'Alice Nguyen', email: 'alice.nguyen@us.example' },
  { name: 'Bob Stone', email: 'bob.stone@us.example' },
  { name: 'Carol Diaz', email: 'carol.diaz@us.example' },
  { name: 'Dan Wu', email: 'dan.wu@us.example' },
  { name: 'Erin Park', email: 'erin.park@us.example' },
  { name: 'Sam Lee', email: 'sam.lee@us.example' },
];

export const CONTACTS = [
  { name: 'Peter Quill', email: 'peter@partner.example' },
  { name: 'Sam Park', email: 'sam.park@client.example' },
  { name: 'Grace Hopper', email: 'grace@cobol.example' },
  { name: 'Hank Pym', email: 'hank@pym.example' },
  { name: 'Ivy Chen', email: 'ivy.chen@client.example' },
  { name: 'Jonas Weber', email: 'jonas.weber@kanzlei.example' },
];

export interface IntentCase {
  text: string;
  /** Addresses that must be resolved (TRUSTED entities). */
  resolved: string[];
  /** Mentions that must be reported as ambiguous (and not silently resolved). */
  ambiguous?: string[];
}

export const CASES: IntentCase[] = [
  { text: 'Email Alice saying the deck is ready', resolved: ['alice.nguyen@us.example'] },
  { text: 'email alice the notes from today', resolved: ['alice.nguyen@us.example'] },
  { text: 'Schedule a meeting with Bob Stone on 2026-10-05 at 14:00', resolved: ['bob.stone@us.example'] },
  { text: 'Send Carol and Dan the agenda', resolved: ['carol.diaz@us.example', 'dan.wu@us.example'] },
  { text: 'Draft a reply to grace@cobol.example', resolved: ['grace@cobol.example'] },
  { text: 'Email newperson@startup.example saying welcome aboard', resolved: ['newperson@startup.example'] },
  { text: 'Tell Sam the plan changed', resolved: [], ambiguous: ['Sam'] },
  { text: 'email Sam Lee saying the room is booked', resolved: ['sam.lee@us.example'] },
  { text: 'Ask Peter to review the proposal', resolved: ['peter@partner.example'] },
  { text: 'Post in #general saying standup moved to 10', resolved: [] },
  { text: 'Email Zorro saying hi', resolved: [] },
  { text: 'Set up a sync with Erin and Ivy', resolved: ['erin.park@us.example', 'ivy.chen@client.example'] },
  { text: 'Send the engagement letter to Jonas Weber', resolved: ['jonas.weber@kanzlei.example'] },
  { text: 'remind hank about the invoice', resolved: ['hank@pym.example'] },
  { text: 'Email Peter Quill and Grace the timeline', resolved: ['peter@partner.example', 'grace@cobol.example'] },
  { text: 'Check my emails from Bob', resolved: ['bob.stone@us.example'] },
  { text: 'Reply to Dan Wu about the budget', resolved: ['dan.wu@us.example'] },
  { text: 'Invite Carol Diaz and Erin Park to the quarterly review', resolved: ['carol.diaz@us.example', 'erin.park@us.example'] },
  { text: 'Book a call with Ivy Chen on 2026-11-02 at 09:30', resolved: ['ivy.chen@client.example'] },
  { text: 'Email alice.nguyen@us.example about Q3', resolved: ['alice.nguyen@us.example'] },
  { text: 'Forward the minutes to sam.park@client.example', resolved: ['sam.park@client.example'] },
  { text: 'Let Sam Park know the draft is ready', resolved: ['sam.park@client.example'] },
  { text: 'send grace hopper the slides', resolved: ['grace@cobol.example'] },
  { text: 'Summarize my inbox', resolved: [] },
  { text: 'Schedule lunch with Hank and Peter on 2026-10-10 at 12:00', resolved: ['hank@pym.example', 'peter@partner.example'] },
  { text: 'What did Jonas send last week?', resolved: ['jonas.weber@kanzlei.example'] },
  { text: 'Draft a note to Erin saying thanks', resolved: ['erin.park@us.example'] },
  { text: 'Email the Acme team saying we are on track', resolved: [] },
  { text: 'Ping sam about the contract', resolved: [], ambiguous: ['sam'] },
  { text: 'Email carol.diaz@us.example and ivy.chen@client.example the summary', resolved: ['carol.diaz@us.example', 'ivy.chen@client.example'] },
  { text: 'Ask Alice Nguyen and Bob Stone for their availability', resolved: ['alice.nguyen@us.example', 'bob.stone@us.example'] },
  { text: 'Tell Monday standup that Dan is out', resolved: ['dan.wu@us.example'] },
];
