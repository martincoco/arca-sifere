import { createInterface } from 'node:readline/promises';

export async function ask(question, { hidden = false } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
  const answer = await rl.question(question);
  rl.close();
  if (hidden) process.stdout.write('\n');
  return answer.trim();
}
