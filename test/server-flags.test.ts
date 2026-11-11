/**
 * The start flags that narrow what the server touches: --projects serves only
 * named top-level folders and writes nothing anywhere else.
 *
 * Every git and ssh-keygen the server runs goes through a logging wrapper
 * put first on PATH, so the tests can check which commands ran. The wrapper
 * must be on PATH before git.ts is loaded, hence the dynamic import.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';

const scratch = await mkdtemp(join(tmpdir(), 'texwerk-flags-'));
const binDir = join(scratch, 'bin');
const callLog = join(scratch, 'calls.log');
await mkdir(binDir);
const which = (tool: string) => execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
/** The real git, for the fixtures, so that only the server's own calls are logged. */
const realGit = which('git');
for (const tool of ['git', 'ssh-keygen']) {
  const real = which(tool);
  await writeFile(join(binDir, tool), `#!/bin/sh\nprintf '%s\\t%s\\t%s\\n' ${tool} "$PWD" "$*" >> '${callLog}'\nexec '${real}' "$@"\n`);
  await chmod(join(binDir, tool), 0o755);
}
process.env.PATH = `${binDir}:${process.env.PATH}`;
const { startServer, FIXED_PROJECTS_REFUSAL } = await import('../src/server/server.ts');
test.after(() => rm(scratch, { recursive: true, force: true }));

const run = (cwd: string, ...args: string[]) => execFileSync(realGit, ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

async function calls(): Promise<Array<{ tool: string; cwd: string; args: string }>> {
  const text = await readFile(callLog, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((l) => { const [tool, cwd, args] = l.split('\t'); return { tool, cwd, args }; });
}

/** Every path under `dir` with its size and modification time, to see that nothing changed. */
async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, rel: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const info = await stat(p);
      out.push(`${rel}${e.name}${e.isDirectory() ? '/' : ''} ${info.size} ${info.mtimeMs}`);
      if (e.isDirectory()) await walk(p, `${rel}${e.name}/`);
    }
  };
  out.push(`. ${(await stat(dir)).mtimeMs}`);
  await walk(dir, '');
  return out.sort();
}

async function serve(t: { after: (fn: () => Promise<void>) => void }, rootDir: string, extra: { projects?: string[] }) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const s = await startServer({ rootDir, clientDir: null, bridgeFile: null, port, host: '127.0.0.1', access: null, ...extra });
  t.after(() => s.close());
  const origin = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(`${origin}${path}${sep}name=Ann`, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await r.text();
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
    return { status: r.status, data };
  };
  /** The close code of a socket to `project`, or 'open' once the server says hello. */
  const socket = (project: string, bridge = false) => new Promise<string | number>((done, fail) => {
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws?project=${encodeURIComponent(project)}&name=Ann${bridge ? '&bridge=1' : ''}`);
    ws.on('message', (data, isBinary) => {
      if (!isBinary && JSON.parse(String(data)).t === 'hello') { ws.close(); done('open'); }
    });
    ws.on('close', (code) => done(code));
    ws.on('error', fail);
  });
  return { origin, call, socket };
}

async function fixture(name: string) {
  const root = join(scratch, name);
  const bare = join(scratch, `${name}-remote.git`);
  execFileSync(realGit, ['init', '-q', '--bare', '-b', 'main', bare]);
  // The served project: a repository with a remote, as a clone of Overleaf's git bridge is.
  const repo = join(root, 'my-paper');
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, 'main.tex'), '\\documentclass{article}\\begin{document}Hi\\end{document}\n');
  await writeFile(join(repo, '.gitignore'), '*.pdf\n');
  await writeFile(join(repo, 'figure.pdf'), '%PDF-1.4 a figure\n');
  run(repo, 'init', '-q', '-b', 'main');
  run(repo, 'add', '-A');
  run(repo, 'commit', '-q', '-m', 'from Overleaf');
  run(repo, 'remote', 'add', 'origin', bare);
  run(repo, 'push', '-q', '-u', 'origin', 'main');
  // Unrelated neighbours: a plain folder, a git repository, a TeXWerk folder with a project inside.
  await mkdir(join(root, 'Notes'));
  await writeFile(join(root, 'Notes', 'notes.tex'), 'SECRETTEXT\n');
  await mkdir(join(root, 'Code'));
  await writeFile(join(root, 'Code', 'x.tex'), 'x\n');
  run(join(root, 'Code'), 'init', '-q', '-b', 'main');
  await mkdir(join(root, 'Group', 'Inner'), { recursive: true });
  await writeFile(join(root, 'Group', '.texwerk-folder.json'), '{"owner":""}\n');
  await writeFile(join(root, 'Group', 'Inner', 'main.tex'), 'inner\n');
  await writeFile(join(root, 'README.md'), 'not a project\n');
  return { root, repo, bare };
}

test('--projects: names that are not project folders stop the server from starting', async () => {
  const { root } = await fixture('start');
  const start = (projects: string[]) => startServer({ rootDir: root, clientDir: null, bridgeFile: null, port: 0, host: '127.0.0.1', access: null, projects });
  await assert.rejects(start(['my-papers']), /"my-papers" is not a folder/);
  await assert.rejects(start(['README.md']), /is not a folder/);
  await assert.rejects(start(['Group/Inner']), /is not a folder/);
  await assert.rejects(start(['Group']), /folder of projects/);
  await assert.rejects(start([]), /at least one/);
  await assert.rejects(startServer({ rootDir: join(scratch, 'missing'), clientDir: null, bridgeFile: null, port: 0, host: '127.0.0.1', access: null, projects: ['P'] }), /is not a folder/);
  assert.ok(!existsSync(join(scratch, 'missing')), 'a missing root is not created');
});

test('--projects: only the named folders are listed and open, and nothing else is written', async (t) => {
  const { root, repo } = await fixture('only');
  const before = (await snapshot(root)).filter((l) => !l.startsWith('my-paper'));
  const { call, socket } = await serve(t, root, { projects: ['my-paper'] });

  const me = await call('GET', '/api/me');
  assert.equal(me.data.fixedProjects, true);
  const listed = await call('GET', '/api/projects');
  assert.deepEqual((listed.data.projects as Array<{ id: string }>).map((p) => p.id), ['my-paper']);
  assert.deepEqual(listed.data.folders, []);

  assert.equal(await socket('my-paper'), 'open');
  for (const other of ['Notes', 'Code', 'Group', 'Group/Inner', '.trash']) {
    assert.equal(await socket(other), 4404, `socket to ${other}`);
    assert.equal(await socket(other, true), 4404, `mirror bridge to ${other}`);
    assert.equal((await call('GET', `/api/history?project=${encodeURIComponent(other)}`)).status, 404, `history of ${other}`);
    assert.equal((await call('PUT', `/api/file?project=${encodeURIComponent(other)}&path=x.tex`, 'x')).status, 404, `write into ${other}`);
    assert.equal((await call('GET', `/raw/${encodeURIComponent(other)}/notes.tex`)).status, 404, `raw file of ${other}`);
    assert.equal((await call('GET', `/api/access?project=${encodeURIComponent(other)}`)).status, 404, `access of ${other}`);
  }
  assert.equal((await call('GET', '/raw/Notes/notes.tex')).status, 404);

  // Nothing may add, rename, move or remove a folder in the root.
  const refused: Array<[string, string, unknown?]> = [
    ['POST', '/api/projects', { name: 'New' }],
    ['POST', '/api/projects', { name: 'Notes' }],
    ['POST', '/api/projects/import?newName=Zipped', 'PK'],
    ['POST', '/api/projects/clone', { url: 'https://example.org/x.git', name: 'Cloned' }],
    ['POST', '/api/projects/rename?project=my-paper&newName=Notes'],
    ['POST', '/api/projects/rename?project=my-paper&newName=Renamed'],
    ['POST', '/api/projects/move?project=my-paper&folder=Group'],
    ['POST', '/api/projects/delete?project=my-paper'],
    ['POST', '/api/folders?path=NewFolder'],
    ['POST', '/api/folders/rename?path=Group&newName=G2'],
    ['DELETE', '/api/folders?path=Group'],
    ['POST', '/api/projects/trash/restore?id=0123456789abcdef'],
  ];
  for (const [method, path, body] of refused) {
    const r = await call(method, path, body);
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.data.error, FIXED_PROJECTS_REFUSAL);
  }
  assert.deepEqual((await call('GET', '/api/projects/trash')).data.items, []);

  // The served project itself still works, its own trash included.
  assert.equal((await call('PUT', '/api/file?project=my-paper&path=extra.tex', 'extra\n')).status, 200);
  assert.equal((await call('POST', '/api/fs?project=my-paper', { op: 'delete', path: 'extra.tex' })).status, 200);
  assert.ok(existsSync(join(repo, '.texwerk')));

  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual((await snapshot(root)).filter((l) => !l.startsWith('my-paper')), before, 'nothing outside the served project changed');
  assert.ok(!(await calls()).some((c) => c.cwd !== repo && c.cwd.startsWith(root)), 'git ran only in the served project');
});

test('without the flag every folder is a project and a repository', async (t) => {
  const { root } = await fixture('default');
  const { call, socket } = await serve(t, root, {});
  const me = await call('GET', '/api/me');
  assert.equal(me.data.fixedProjects, false);
  const ids = ((await call('GET', '/api/projects')).data.projects as Array<{ id: string }>).map((p) => p.id).sort();
  assert.deepEqual(ids, ['Code', 'Group/Inner', 'Notes', 'my-paper']);
  assert.equal(await socket('Notes'), 'open');
  assert.ok(existsSync(join(root, 'Notes', '.git')), 'opening a folder makes it a repository');
});

test('--projects with --access: the directory of known people is kept in memory, not in the root', async (t) => {
  const { root } = await fixture('people');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const s = await startServer({ rootDir: root, clientDir: null, bridgeFile: null, port, host: '127.0.0.1', access: { admin: 'admin@example.org' }, projects: ['my-paper'] });
  t.after(() => s.close());
  const r = await fetch(`http://127.0.0.1:${port}/api/users`, { headers: { 'tailscale-user-login': 'ann@example.org', 'tailscale-user-name': 'Ann' } });
  assert.deepEqual(((await r.json()) as Array<{ login: string }>).map((u) => u.login), ['ann@example.org']);
  await new Promise((done) => setTimeout(done, 200));
  assert.ok(!existsSync(join(root, '.texwerk-users.json')));
});
