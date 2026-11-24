// 通过真正的 MCP 协议调用，验证 server.mjs 那一层。
//
// 不依赖 MCP 客户端库：直接 spawm server.mjs，手写 JSON-RPC 行协议。
// 这样能在 DSH 之外单独验证「MCP 服务 → 桥接器 → EPLAN 宿主」整条链路。
//
// 用法: node test/mcp-e2e.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const serverPath = path.join(root, 'server', 'server.mjs');

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      console.error('BAD LINE', line.slice(0, 200));
    }
  }
});
child.stderr.on('data', (d) => console.error('[stderr]', d.toString().trim().slice(0, 300)));

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('timeout ' + method));
      }
    }, 180000);
  });
}

async function callTool(name, args) {
  const reply = await rpc('tools/call', { name, arguments: args });
  if (reply.error) throw new Error(name + ': ' + JSON.stringify(reply.error));
  const text = reply.result?.content?.[0]?.text ?? '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 非 JSON 就直接返回文本 */ }
  return { isError: reply.result?.isError === true, parsed, text };
}

await rpc('initialize', {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'mcp-e2e', version: '1' },
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const tools = await rpc('tools/list', {});
console.log('TOOLS (' + tools.result.tools.length + '): ' + tools.result.tools.map((t) => t.name).join(', '));

const status = await callTool('status', {});
console.log('\n[status] isError=' + status.isError + ' ok=' + status.parsed?.ok);
if (status.parsed?.ok) {
  console.log('  当前项目: ' + status.parsed.result.currentProject?.name);
  console.log('  已打开: ' + (status.parsed.result.openProjects || []).map((p) => p.name).join(', '));
}

const pages = await callTool('pages', { project: 'test' });
console.log('\n[pages] ok=' + pages.parsed?.ok + ' -> '
  + ((pages.parsed?.result?.pages || []).map((p) => p.name).join(', ') || pages.text.slice(0, 200)));

const symbols = await callTool('symbols', { project: 'test', library: 'GB_symbol', filter: 'FA' });
console.log('\n[symbols FA*] ok=' + symbols.parsed?.ok + ' -> '
  + ((symbols.parsed?.result?.symbols || []).map((s) => s.name).slice(0, 10).join(', ')));

child.kill();
