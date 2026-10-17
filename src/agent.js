// A small tool-using agent. It works inside the sandbox: it reads the app's
// code, writes files, runs commands, and reads back what happened.
import OpenAI from 'openai';
import { sh, writeFile } from './sandbox.js';

const client = new OpenAI();
const MODEL = process.env.TWICE_MODEL || 'gpt-5.4';

const tools = [
  {
    type: 'function',
    function: {
      name: 'run',
      description: 'Run a bash command inside the sandbox (working directory: the app). Returns stdout, stderr and the exit code.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a whole file inside the sandbox.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Call once the task is done, with a one-paragraph summary of what you did.',
      parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    },
  },
];

export class Agent {
  constructor(sandbox, system, log, cwd = '/app') {
    this.cwd = cwd;
    this.sandbox = sandbox;
    this.log = log;
    this.messages = [{ role: 'system', content: system }];
  }

  async task(prompt, { maxSteps = 30 } = {}) {
    this.messages.push({ role: 'user', content: prompt });
    for (let step = 0; step < maxSteps; step++) {
      const res = await client.chat.completions.create({ model: MODEL, messages: this.messages, tools });
      const msg = res.choices[0].message;
      this.messages.push(msg);
      if (msg.content) this.log({ kind: 'agent_say', text: msg.content });
      if (!msg.tool_calls?.length) return msg.content ?? '';
      for (const call of msg.tool_calls) {
        const args = JSON.parse(call.function.arguments || '{}');
        let result;
        if (call.function.name === 'run') {
          this.log({ kind: 'agent_run', command: args.command });
          const b64 = Buffer.from(args.command, 'utf8').toString('base64');
          const r = await sh(this.sandbox, `cd ${this.cwd} && timeout 180 bash -c "$(echo '${b64}' | base64 -d)" < /dev/null`);
          this.log({ kind: 'agent_result', code: r.code, stdout: r.stdout.slice(-1500), stderr: r.stderr.slice(-800) });
          result = JSON.stringify(r);
        } else if (call.function.name === 'write_file') {
          this.log({ kind: 'agent_write', path: args.path, content: args.content });
          await writeFile(this.sandbox, args.path, args.content);
          result = 'written';
        } else if (call.function.name === 'finish') {
          this.log({ kind: 'agent_done', text: args.summary });
          this.messages.push({ role: 'tool', tool_call_id: call.id, content: 'ok' });
          return args.summary;
        }
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }
    throw new Error('agent ran out of steps');
  }
}
