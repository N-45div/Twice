import { Sandbox } from '@nodeops-createos/sandbox';

const options = () => ({
  apiKey: process.env.CREATEOS_SANDBOX_API_KEY || process.env.CREATEOS_PROJECT_API_KEY,
  baseUrl: process.env.CREATEOS_SANDBOX_BASE_URL || 'https://api-eu.sb.createos.sh',
  timeoutMs: 600_000,
});

export const connect = (id) => Sandbox.connect(id, options());
export const create = (request) => Sandbox.create(request, options());

const clip = (s, n = 6000) => (s.length > n ? `${s.slice(0, n / 2)}\n…[cut]…\n${s.slice(-n / 2)}` : s);

export async function sh(sandbox, script) {
  const r = await sandbox.runCommand('bash', ['-lc', script]);
  return {
    stdout: clip(r.result.stdout ?? ''),
    stderr: clip(r.result.stderr ?? ''),
    code: r.result.exit_code,
    ms: r.exec_ms,
  };
}

export async function writeFile(sandbox, path, content) {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const dir = path.replace(/\/[^/]*$/, '') || '/';
  const r = await sh(sandbox, `mkdir -p '${dir}' && echo '${b64}' | base64 -d > '${path}'`);
  if (r.code !== 0) throw new Error(`write ${path} failed: ${r.stderr}`);
}
