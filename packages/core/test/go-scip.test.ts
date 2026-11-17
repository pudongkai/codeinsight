import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { completeGoFiles } from '../src/extract/go-index.js';
import { parseGoWorkUses } from '../src/extract/go-module.js';
import { buildSnapshot, extractGoFile, getGoParser, initDataDir, loadConfig, Store } from '../src/index.js';
import type { ExtractedFile } from '../src/index.js';
import { GoResolver } from '../src/resolve/go.js';
import { buildGoScipIndex, goModuleDirs, scipGoEnv, type GoModuleDir } from '../src/resolve/go-scip.js';
import { LanguageResolver } from '../src/resolve/language-resolver.js';
import { prepareGoIndex } from '../src/resolve/scip-rules-go.js';
import { decodeScipIndex, SCIP_ROLE_DEFINITION } from '../src/scip/reader.js';
import { goListError } from '../src/scip/runner.js';
import { initRepo, tempDir } from './helpers/git-repo.js';

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
}

const fileAt = (p: string): ExtractedFile => ({ path: p } as ExtractedFile);

/** 只有一个文档、文档里只有一个出现位置的 SCIP 索引 */
function scipBytes(relativePath: string, symbol: string): Uint8Array {
  const occ = new BinaryWriter();
  occ.tag(1, WireType.LengthDelimited).fork().int32(0).int32(5).int32(8).join();
  occ.tag(2, WireType.LengthDelimited).string(symbol);
  occ.tag(3, WireType.Varint).int32(SCIP_ROLE_DEFINITION);
  const doc = new BinaryWriter();
  doc.tag(1, WireType.LengthDelimited).string(relativePath);
  doc.tag(2, WireType.LengthDelimited).bytes(occ.finish());
  const index = new BinaryWriter();
  index.tag(1, WireType.LengthDelimited).bytes(new Uint8Array());
  index.tag(2, WireType.LengthDelimited).bytes(doc.finish());
  return index.finish();
}

/** 假的 go / scip-go：go list 什么也不输出；scip-go index 把环境变量写进 module 目录的 env.txt，把 index.bin 复制到 -o 指定的路径 */
function fakeTool(): string {
  const bin = path.join(tempDir('ci-fake-scip-go-'), 'fake');
  writeFileSync(bin, '#!/bin/sh\nif [ "$1" = list ]; then exit 0; fi\nif [ "$1" = --version ]; then echo 1.0; exit 0; fi\nenv > env.txt\ncp index.bin "$3"\n');
  chmodSync(bin, 0o755);
  return bin;
}

describe('go list output', () => {
  it('parses the concatenated JSON stream and reports the first load error', () => {
    const ok = '{\n\t"ImportPath": "a",\n\t"GoFiles": ["a.go"]\n}\n{\n\t"ImportPath": "b"\n}\n';
    expect(goListError(ok)).toBeUndefined();
    const own = `${ok}{\n\t"ImportPath": "c",\n\t"Error": {\n\t\t"Err": "bad {brace} \\"quoted\\""\n\t}\n}\n`;
    expect(goListError(own)).toBe('bad {brace} "quoted"');
  });

  it('ignores packages excluded by build constraints', () => {
    const cgo = '{\n\t"ImportPath": "a/cgo",\n\t"Error": {\n\t\t"Err": "build constraints exclude all Go files in /x/cgo"\n\t}\n}\n';
    const dep = '{\n\t"ImportPath": "a",\n\t"DepsErrors": [\n\t\t{\n\t\t\t"Err": "build constraints exclude all Go files in /x/cgo"\n\t\t}\n\t]\n}\n';
    expect(goListError(cgo + dep)).toBeUndefined();
    const later = '{\n\t"ImportPath": "b",\n\t"DepsErrors": [\n\t\t{"Err": "build constraints exclude all Go files in /x/cgo"},\n\t\t{"Err": "missing x/y"}\n\t]\n}\n';
    expect(goListError(cgo + later)).toBe('missing x/y');
  });
});

describe('go.work and module discovery', () => {
  it('parses single-line and block use directives', () => {
    const text = 'go 1.22\n\nuse ./a // first\nuse (\n\t./b\n\t"./c d"\n\t// ./skipped\n)\nuse (./e)\nreplace x => ./y\n';
    expect(parseGoWorkUses(text)).toEqual(['./a', './b', './c d', './e']);
  });

  it('finds each file module, uses go.work only for listed modules, and skips go.mod under vendor or testdata', async () => {
    const root = tempDir('ci-go-modules-');
    writeTree(root, {
      'go.work': 'go 1.22\n\nuse (\n\t./a\n)\n',
      'a/go.mod': 'module example.com/a\n',
      'a/vendor/v/go.mod': 'module example.com/vendored\n',
      'a/testdata/t/go.mod': 'module example.com/testdata\n',
      'b/go.mod': 'module example.com/b\n',
      'loose/x.go': 'package loose\n',
    });
    const files = ['a/x.go', 'a/vendor/v/y.go', 'a/testdata/t/z.go', 'b/sub/w.go', 'loose/x.go'].map(fileAt);
    expect(await goModuleDirs(root, files)).toEqual([
      { dir: 'a', module: 'example.com/a', workDir: '' },
      { dir: 'b', module: 'example.com/b', workOff: true },
    ]);
  });
});

describe('scip-go environment', () => {
  const root = tempDir('ci-go-env-');
  writeTree(root, { 'a/vendor/modules.txt': '', 'w/vendor/modules.txt': '' });
  const env = (mod: GoModuleDir) => scipGoEnv(root, mod, '/opt/go/bin/go', { PATH: '/usr/bin', GOPROXY: 'https://proxy', GOWORK: 'x' });

  it('uses the vendor directory of the module or the workspace, otherwise forbids go.mod changes', () => {
    expect(env({ dir: 'a', module: 'a' }).GOFLAGS).toBe('-mod=vendor');
    expect(env({ dir: 'b', module: 'b', workDir: 'w' }).GOFLAGS).toBe('-mod=vendor');
    expect(env({ dir: 'b', module: 'b' }).GOFLAGS).toBe('-mod=readonly');
  });

  it('turns off cgo, toolchain downloads and prompts, keeps user settings, and turns off go.work only when asked', () => {
    expect(env({ dir: 'b', module: 'b' })).toMatchObject({
      CGO_ENABLED: '0', GOTOOLCHAIN: 'local', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
      GOPROXY: 'https://proxy', GOWORK: 'x', PATH: `/opt/go/bin${path.delimiter}/usr/bin`,
    });
    expect(env({ dir: 'b', module: 'b', workOff: true }).GOWORK).toBe('off');
  });
});

describe('scip-go index merging', () => {
  it('runs each module with its own environment and prefixes document paths with the module directory', async () => {
    const root = tempDir('ci-go-merge-');
    writeTree(root, { 'vendor/modules.txt': '' });
    for (const d of ['a', 'b']) mkdirSync(path.join(root, d), { recursive: true });
    writeFileSync(path.join(root, 'a', 'index.bin'), scipBytes('x.go', 'scip-go gomod example.com/a v0.0.0 `example.com/a`/F().'));
    writeFileSync(path.join(root, 'b', 'index.bin'), scipBytes('sub/y.go', 'scip-go gomod example.com/b v0.0.0 `example.com/b/sub`/G().'));
    const fake = fakeTool();
    const output = path.join(tempDir('ci-go-merge-out-'), 'go.scip');
    const modules: GoModuleDir[] = [{ dir: 'a', module: 'example.com/a', workDir: '' }, { dir: 'b', module: 'example.com/b', workOff: true }];
    await buildGoScipIndex({ root, modules, bin: fake, goBin: fake, output, timeoutMs: 30_000 });
    const docs = decodeScipIndex(readFileSync(output)).documents;
    expect(docs.map((d) => [d.relativePath, d.occurrences[0]!.symbol])).toEqual([
      ['a/x.go', 'scip-go gomod example.com/a v0.0.0 `example.com/a`/F().'],
      ['b/sub/y.go', 'scip-go gomod example.com/b v0.0.0 `example.com/b/sub`/G().'],
    ]);
    const envA = readFileSync(path.join(root, 'a', 'env.txt'), 'utf8');
    const envB = readFileSync(path.join(root, 'b', 'env.txt'), 'utf8');
    expect(envA).toMatch(/^GOFLAGS=-mod=vendor$/m);
    expect(envA).not.toMatch(/^GOWORK=off$/m);
    expect(envB).toMatch(/^GOFLAGS=-mod=readonly$/m);
    expect(envB).toMatch(/^GOWORK=off$/m);
    expect(envB).toMatch(/^CGO_ENABLED=0$/m);
  });
});

describe('cross-module symbol versions', () => {
  it('rewrites the version of project modules referenced through go.work or replace to v0.0.0', async () => {
    const parser = await getGoParser();
    const modules = new Map([['a', 'example.com/a'], ['b', 'example.com/b']]);
    const sources: Record<string, string> = {
      'a/a.go': 'package a\n\nfunc F() {}\n',
      'b/b.go': 'package b\n\nimport "example.com/a"\n\nfunc G() { a.F() }\n',
    };
    const files = Object.entries(sources).map(([p, s]) => extractGoFile(parser, p, s, { isTest: false, isGenerated: false }, modules));
    const index = completeGoFiles(files);
    const ref = (symbol: string) => ({ range: { startLine: 4, startChar: 13, endLine: 4, endChar: 14 }, symbol, roles: 0 });
    const raw = {
      documents: [{
        relativePath: 'b/b.go',
        occurrences: [ref('scip-go gomod example.com/a . `example.com/a`/F().'), ref('scip-go gomod github.com/x/y v1.2.3 `github.com/x/y`/H().')],
      }],
    };
    const prepared = prepareGoIndex(raw, files, index, modules.values());
    expect(prepared.index.documents[0]!.occurrences.map((o) => o.symbol)).toEqual([
      'scip-go gomod example.com/a v0.0.0 `example.com/a`/F().',
      'scip-go gomod github.com/x/y v1.2.3 `github.com/x/y`/H().',
    ]);
  });
});

describe('Go resolver without go.mod', () => {
  const saved = { scipGo: process.env.CODEINSIGHT_SCIP_GO, go: process.env.CODEINSIGHT_GO };
  afterEach(() => {
    for (const [name, value] of [['CODEINSIGHT_SCIP_GO', saved.scipGo], ['CODEINSIGHT_GO', saved.go]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('records no_module and does not re-resolve on later opens even though scip-go is installed', async () => {
    const fake = fakeTool();
    process.env.CODEINSIGHT_SCIP_GO = fake;
    process.env.CODEINSIGHT_GO = fake;
    const repo = initRepo({ 'main.go': 'package main\n\nfunc helper() {}\n\nfunc main() { helper() }\n' });
    const config = await loadConfig(repo, { dataDir: tempDir('ci-go-nomod-data-') });
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    const build = () => buildSnapshot({ repo, store, layout, config, resolver: new LanguageResolver({ go: new GoResolver() }) });
    const first = await build();
    expect(first.snapshot.edgeSources?.go).toMatchObject({ source: 'name_match', reason: 'no_module' });
    const second = await build();
    expect(second.resolveRetried).toBeFalsy();
    expect(second.snapshot.id).toBe(first.snapshot.id);
  }, 60_000);
});
