import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BinaryWriter } from '@bufbuild/protobuf/wire';
import { beforeAll, describe, expect, it } from 'vitest';
import { collectRustCrates, rustCratesFromManifests, type RustPackage } from '../src/extract/rust-cargo.js';
import type { ExtractedFile, RustFileFacts } from '../src/extract/types.js';
import { buildSnapshot, initDataDir, loadConfig, Store } from '../src/index.js';
import type { Resolver, ResolveInput } from '../src/index.js';
import { findRustTools, toolsForChannel, type RustTools, type ToolRunner } from '../src/resolve/rust-tools.js';
import {
  buildRustScipIndex, createRustRunDir, dependenciesMissing, readRustScipCache, rootToolchainChannel, rustAnalyzerConfig, rustCargoEnv,
  rustFileRoots, rustRunRoots, RustStderrWatch,
} from '../src/resolve/rust-scip.js';
import { scipToEdges } from '../src/resolve/scip-edges.js';
import { prepareRustIndex, rustCallRest, rustContinuedLines, rustRules } from '../src/resolve/scip-rules-rust.js';
import { appendScipDocuments } from '../src/scip/merge.js';
import { decodeScipIndex, SCIP_ROLE_DEFINITION, type ScipIndex, type ScipOccurrence } from '../src/scip/reader.js';
import { runProcess } from '../src/scip/runner.js';
import { dataDirLayout, removeStaleScipTemps } from '../src/store/data-dir.js';
import { commitAll, git, tempDir, writeFiles } from './helpers/git-repo.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'rust-basic');
const SHOP = 'rust-analyzer cargo shop-core 0.1.0 ';
const APP = 'rust-analyzer cargo app 0.1.0 ';

function facts(target: string, extra: Partial<RustFileFacts> = {}): RustFileFacts {
  return {
    crate: 'c', target, modulePath: [], useLeaves: [], modDecls: [], derives: {}, pathRoots: [], envReads: [], macroRanges: [], ...extra,
  };
}

function rsFile(p: string, target: string, extra: Partial<RustFileFacts> = {}, importRows: [number, number][] = []): ExtractedFile {
  return { path: p, language: 'rust', symbols: [], entries: [], importRows, imports: new Map(), rust: facts(target, extra) };
}

function occ(line: number, start: number, end: number, symbol: string, def = false): ScipOccurrence {
  return {
    range: { startLine: line, startChar: start, endLine: line, endChar: end }, symbol, roles: def ? SCIP_ROLE_DEFINITION : 0,
    ...(def ? { enclosingRange: { startLine: line, startChar: 0, endLine: line, endChar: end } } : {}),
  };
}

function pkg(dir: string, name: string, targets: RustPackage['targets'], extra: Partial<RustPackage> = {}): RustPackage {
  return { dir, name, targets, deps: [], ...extra };
}

describe('Rust SCIP rules', () => {
  it('tracks brackets across raw strings, lifetimes, char literals and nested comments', () => {
    const src = [
      'fn f<\'a>(x: &\'a str) -> char {', // 0: `{` opens
      '    let s = r#"(unclosed', // 1: raw string spans lines
      '    still raw ) "# ;', // 2: raw string ends, depth back to fn body
      '    /* outer /* inner ( */ still comment', // 3: nested block comment
      '    */ let c = \'(\';', // 4: comment ends; char literal '(' not counted
      '    let e = \'\\\'\';', // 5: escaped quote char literal
      '}', // 6
    ].join('\n');
    expect(rustContinuedLines(src)).toEqual([true, true, true, true, true, true, false]);
    expect(rustContinuedLines('let s = "a ( \\" b";\nx')).toEqual([false, false]);
  });

  it('strips turbofish before checking for a call and does not treat macros as calls', () => {
    expect(rustCallRest('::<Vec<u8>>(x)')).toBe('(x)');
    expect(rustCallRest('::<fn() -> u8>()')).toBe('()');
    expect(rustCallRest('(x)')).toBe('(x)');
    const file = rsFile('src/lib.rs', 'src/lib.rs');
    file.symbols = [
      { id: 'm', kind: 'module', name: 'lib', nameLine: 0, nameCol: 0, startLine: 1, endLine: 3 } as ExtractedFile['symbols'][number],
      { id: 'f', kind: 'function', name: 'f', nameLine: 0, nameCol: 3, startLine: 1, endLine: 1 } as ExtractedFile['symbols'][number],
      { id: 'g', kind: 'function', name: 'g', nameLine: 1, nameCol: 3, startLine: 2, endLine: 3 } as ExtractedFile['symbols'][number],
    ];
    const source = 'fn f<T>() {}\nfn g() { f::<u8>(); f!(); }\n';
    const index: ScipIndex = {
      documents: [{
        relativePath: 'src/lib.rs',
        occurrences: [occ(0, 3, 4, `${SHOP}f().`, true), occ(1, 3, 4, `${SHOP}g().`, true), occ(1, 9, 10, `${SHOP}f().`), occ(1, 20, 21, `${SHOP}f().`)],
      }],
    };
    const { edges } = scipToEdges(index, [file], new Map([['src/lib.rs', source]]), 1, rustRules);
    expect(edges.map((e) => [e.srcId, e.dstId, e.kind, e.col])).toEqual([['g', 'f', 'call', 9], ['g', 'f', 'reference', 20]]);
  });

  it('separates symbols defined in several crate targets and drops path prefixes, non-leaf use segments and mod lines', () => {
    const packages = new Map([['', pkg('', 'app', [
      { kind: 'lib', name: 'app', root: 'src/lib.rs' }, { kind: 'bin', name: 'app', root: 'src/main.rs' },
      { kind: 'bin', name: 'tool', root: 'src/bin/tool.rs' },
    ])]]);
    const sources = new Map([
      ['src/lib.rs', 'mod a;\nuse crate::a::*;\n'],
      ['src/main.rs', 'fn main() { helper(); }\nfn helper() {}\n'],
      ['src/bin/tool.rs', 'fn main() { app::a::greet(); }\n'],
      ['src/a.rs', 'pub fn greet() {}\nmacro_rules! m { () => { fn hidden() {} } }\nstruct S { f: u8 }\n'],
    ]);
    const files = [
      rsFile('src/lib.rs', 'src/lib.rs', { modDecls: [0], useLeaves: [{ line: 1, col: 11 }] }, [[1, 1]]),
      rsFile('src/main.rs', 'src/main.rs'),
      rsFile('src/bin/tool.rs', 'src/bin/tool.rs'),
      rsFile('src/a.rs', 'src/lib.rs', { macroRanges: [[1, 1]] }),
    ];
    const index: ScipIndex = {
      documents: [
        { relativePath: 'src/lib.rs', occurrences: [
          occ(0, 0, 0, `${APP}crate/`, true), occ(0, 4, 5, `${APP}a/`), occ(1, 4, 9, `${APP}crate/`), occ(1, 11, 12, `${APP}a/`),
        ] },
        { relativePath: 'src/main.rs', occurrences: [
          occ(0, 0, 0, `${APP}crate/`, true), occ(0, 3, 7, `${APP}main().`, true), occ(0, 12, 18, `${APP}helper().`),
          occ(1, 3, 9, `${APP}helper().`, true), occ(0, 20, 21, 'local 1'),
        ] },
        { relativePath: 'src/bin/tool.rs', occurrences: [
          occ(0, 0, 0, `${APP}crate/`, true), occ(0, 3, 7, `${APP}main().`, true), occ(0, 12, 15, `${APP}crate/`),
          occ(0, 17, 18, `${APP}a/`), occ(0, 20, 25, `${APP}a/greet().`),
        ] },
        { relativePath: 'src/a.rs', occurrences: [
          occ(0, 0, 0, `${APP}a/`, true), occ(0, 7, 12, `${APP}a/greet().`, true), occ(1, 30, 36, `${APP}a/hidden().`, true),
          occ(2, 7, 8, `${APP}a/S#`, true), occ(2, 11, 12, `${APP}a/S#f.`, true),
        ] },
        { relativePath: 'src/other.rs', occurrences: [occ(0, 0, 0, `${APP}other/`, true)] },
      ],
    };
    const { index: out, stats } = prepareRustIndex(index, files, sources, packages);
    const view = Object.fromEntries(out.documents.map((d) => [d.relativePath, d.occurrences.map((o) => `${o.range.startLine}:${o.range.startChar} ${o.symbol.replace(APP, '')}`)]));
    expect(view).toEqual({
      'src/lib.rs': ['0:0 crate/ @src/lib.rs', '1:11 a/'],
      'src/main.rs': ['0:0 crate/ @src/main.rs', '0:3 main(). @src/main.rs', '0:12 helper().', '1:3 helper().'],
      'src/bin/tool.rs': ['0:0 crate/ @src/bin/tool.rs', '0:3 main(). @src/bin/tool.rs', '0:20 a/greet().'],
      'src/a.rs': ['0:0 a/', '0:7 a/greet().', '2:7 a/S#'],
    });
    expect(stats.definitions).toBe(5);
    expect(rustRules.isModuleDefinition(out.documents[0]!.occurrences[0]!)).toBe(true);
  });

  it('keeps `use super::*` as an import of the parent module and resolves duplicate crate roots to the lib target', () => {
    const packages = new Map([['', pkg('', 'core', [{ kind: 'lib', name: 'core', root: 'src/lib.rs' }, { kind: 'test', name: 'it', root: 'tests/it.rs' }])]]);
    const sources = new Map([['src/lib.rs', ''], ['tests/it.rs', ''], ['src/order/mod.rs', 'use super::*;\nuse crate::x;\n']]);
    const files = [
      rsFile('src/lib.rs', 'src/lib.rs'), rsFile('tests/it.rs', 'tests/it.rs'),
      rsFile('src/order/mod.rs', 'src/lib.rs', { useLeaves: [{ line: 0, col: 4 }, { line: 1, col: 11 }] }, [[0, 1]]),
    ];
    const index: ScipIndex = {
      documents: [
        { relativePath: 'src/lib.rs', occurrences: [occ(0, 0, 0, `${SHOP}crate/`, true)] },
        { relativePath: 'tests/it.rs', occurrences: [occ(0, 0, 0, `${SHOP}crate/`, true)] },
        { relativePath: 'src/order/mod.rs', occurrences: [occ(0, 0, 0, `${SHOP}order/`, true), occ(0, 4, 9, `${SHOP}crate/`), occ(1, 4, 9, `${SHOP}crate/`)] },
      ],
    };
    const { index: out } = prepareRustIndex(index, files, sources, packages);
    expect(out.documents[2]!.occurrences.map((o) => o.symbol.replace(SHOP, ''))).toEqual(['order/', 'crate/ @src/lib.rs']);
  });
});

describe('Rust SCIP merge and run roots', () => {
  it('prefixes documents with the root directory and keeps only the root files', () => {
    const one = new BinaryWriter();
    const index = (paths: string[]): Uint8Array => {
      const w = new BinaryWriter();
      for (const p of paths) w.tag(2, 2).bytes(new BinaryWriter().tag(1, 2).string(p).finish());
      return w.finish();
    };
    appendScipDocuments(one, index(['src/lib.rs', 'nested/src/lib.rs']), 'ws', (p) => p !== 'ws/nested/src/lib.rs');
    appendScipDocuments(one, index(['src/main.rs']), '');
    expect(decodeScipIndex(one.finish()).documents.map((d) => d.relativePath)).toEqual(['ws/src/lib.rs', 'src/main.rs']);
  });

  it('picks workspaces and standalone packages as roots, skipping test data and excluded members', () => {
    const manifests = new Map([
      ['ws/Cargo.toml', '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/legacy"]\n'],
      ['ws/crates/a/Cargo.toml', '[package]\nname = "a"\n'],
      ['ws/crates/legacy/Cargo.toml', '[package]\nname = "legacy"\n'],
      ['tool/Cargo.toml', '[package]\nname = "tool"\n'],
      ['tests/fixtures/demo/Cargo.toml', '[package]\nname = "demo"\n'],
      ['examples/x/Cargo.toml', '[package]\nname = "x"\n'],
      ['crates/testdata/y/Cargo.toml', '[package]\nname = "y"\n'],
    ]);
    const files = ['ws/crates/a/src/lib.rs', 'ws/crates/legacy/src/lib.rs', 'tool/src/main.rs', 'tests/fixtures/demo/src/lib.rs', 'loose.rs'];
    const packages = rustCratesFromManifests({ manifests, files });
    const roots = rustRunRoots(packages);
    expect(roots.map((r) => [r.dir, r.packages.map((p) => p.name)])).toEqual([['tool', ['tool']], ['ws', ['a']], ['ws/crates/legacy', ['legacy']]]);
    const fileRoots = rustFileRoots(files.map((p) => rsFile(p, p)), packages, roots);
    expect([...fileRoots]).toEqual([['ws/crates/a/src/lib.rs', 'ws'], ['ws/crates/legacy/src/lib.rs', 'ws/crates/legacy'], ['tool/src/main.rs', 'tool']]);
  });

  it('builds the run directory with only Rust files and Cargo manifests', async () => {
    const snap = tempDir('ci-rust-snap-');
    writeFiles(snap, {
      'Cargo.toml': '[workspace]\nmembers = ["a"]\n', 'Cargo.lock': '# lock\n', 'a/Cargo.toml': '[package]\nname = "a"\n',
      'a/src/lib.rs': 'pub fn f() {}\n', '.cargo/config.toml': '[build]\nrustc-wrapper = "/bin/evil"\n', 'rust-toolchain.toml': '[toolchain]\nchannel = "stable"\n',
      'rust-analyzer.toml': '', 'a/build.rs': 'fn main() {}\n', 'README.md': '',
    });
    const packages = await collectRustCrates(['Cargo.toml', 'a/Cargo.toml', 'a/src/lib.rs', 'a/build.rs'], (p) => readFile(path.join(snap, p), 'utf8'));
    const tmp = tempDir('ci-rust-tmp-');
    const runDir = await createRustRunDir(snap, 'abcdef0123456789abcdef', ['a/src/lib.rs', 'a/build.rs'], packages, tmp);
    expect(path.basename(runDir)).toMatch(new RegExp(`^codeinsight-rust-abcdef0123456789\\.${process.pid}\\.[A-Za-z0-9]{6}$`));
    expect(statSync(runDir).mode & 0o777).toBe(0o700);
    const listed = execFileSync('find', ['.', '-type', 'f'], { cwd: runDir, encoding: 'utf8' }).trim().split('\n').sort();
    expect(listed).toEqual(['./Cargo.lock', './Cargo.toml', './a/Cargo.toml', './a/build.rs', './a/src/lib.rs']);
    expect(statSync(path.join(runDir, 'Cargo.toml')).nlink).toBe(1);
  });

  it('skips symlinks and unreadable entries instead of failing', async () => {
    const snap = tempDir('ci-rust-snap-');
    const outside = path.join(tempDir('ci-rust-outside-'), 'secret.rs');
    writeFiles(snap, { 'Cargo.toml': '[package]\nname = "a"\n', 'src/lib.rs': 'pub fn f() {}\n' });
    writeFileSync(outside, 'secret');
    symlinkSync(outside, path.join(snap, 'src/link.rs'));
    symlinkSync(path.join(snap, 'missing.rs'), path.join(snap, 'src/broken.rs'));
    const packages = await collectRustCrates(['Cargo.toml', 'src/lib.rs'], (p) => readFile(path.join(snap, p), 'utf8'));
    const runDir = await createRustRunDir(snap, 'k', ['src/lib.rs', 'src/link.rs', 'src/broken.rs', 'src/gone.rs'], packages, tempDir('ci-rust-tmp-'));
    expect(listFiles(runDir)).toEqual(['Cargo.toml', 'src/lib.rs']);
  });

  it('pins the toolchain and rustc, blanks wrappers and removes cargo build overrides from the environment', () => {
    const tools: RustTools = { cargo: '/c/cargo', rustAnalyzer: '/c/ra', rustc: '/tc/bin/rustc', toolchain: 'stable-x', version: 'v', rustSrc: true, trueBin: '/usr/bin/true' };
    const env = rustCargoEnv(tools, '/run', {
      PATH: '/bin', CARGO_HOME: '/h', HTTPS_PROXY: 'p', RUSTUP_TOOLCHAIN: 'evil', RUSTC_WRAPPER: '/evil', CARGO_BUILD_RUSTC: '/evil',
      CARGO_BUILD_RUSTC_WRAPPER: '/evil', CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: '/evil', CARGO_BUILD_RUSTDOC: '/evil', RUSTDOC: '/evil', CARGO_NET_OFFLINE: 'true',
    });
    expect(env).toEqual({
      PATH: '/bin', CARGO_HOME: '/h', HTTPS_PROXY: 'p', RUSTUP_TOOLCHAIN: 'stable-x', RUSTUP_AUTO_INSTALL: '0', CARGO: '/c/cargo', RUSTC: '/tc/bin/rustc',
      RUSTC_WRAPPER: '', RUSTC_WORKSPACE_WRAPPER: '', CARGO_TARGET_DIR: '/run/target', CARGO_TERM_COLOR: 'never',
      GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    });
    expect(path.isAbsolute(env.RUSTC!)).toBe(true);
    expect(JSON.parse(rustAnalyzerConfig('/usr/bin/true'))).toEqual({ cargo: { buildScripts: { overrideCommand: ['/usr/bin/true'] }, features: 'all' } });
  });

  it('reads the toolchain channel only from regular files, not from symlinks', async () => {
    const snap = tempDir('ci-rust-tc-');
    const outside = tempDir('ci-rust-tc-outside-');
    writeFileSync(path.join(outside, 'secret'), 'nightly\n');
    mkdirSync(path.join(snap, 'a'));
    symlinkSync(path.join(outside, 'secret'), path.join(snap, 'a/rust-toolchain'));
    expect(await rootToolchainChannel(snap, 'a')).toBeUndefined();
    writeFileSync(path.join(snap, 'rust-toolchain.toml'), '[toolchain]\nchannel = "stable"\n');
    expect(await rootToolchainChannel(snap, 'a')).toBe('stable');
  });

  it('removes run directories left by processes that no longer exist', async () => {
    const tmp = tempDir('ci-rust-stale-');
    const dead = path.join(tmp, 'codeinsight-rust-abc.999999.Ab12Cd');
    const own = path.join(tmp, `codeinsight-rust-abc.${process.pid}.Ab12Cd`);
    for (const d of [dead, own]) mkdirSync(path.join(d, 'src'), { recursive: true });
    const layout = dataDirLayout(tempDir('ci-rust-layout-'));
    expect(await removeStaleScipTemps(layout, tmp)).toEqual(['codeinsight-rust-abc.999999.Ab12Cd']);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(own)).toBe(true);
  });
});

describe('Rust tool lookup', () => {
  function fakeBins(names: string[], proxy = false): string {
    const dir = tempDir('ci-rust-bin-');
    if (proxy) {
      writeFileSync(path.join(dir, 'rustup'), '#!/bin/sh\nexit 0\n');
      chmodSync(path.join(dir, 'rustup'), 0o755);
    }
    for (const n of names) {
      if (proxy) execFileSync('ln', ['-s', 'rustup', path.join(dir, n)]);
      else {
        writeFileSync(path.join(dir, n), '#!/bin/sh\nexit 0\n');
        chmodSync(path.join(dir, n), 0o755);
      }
    }
    return dir;
  }

  function recordingRunner(answers: (bin: string, args: string[]) => { code: number; stdout?: string; stderr?: string }): { run: ToolRunner; calls: { bin: string; args: string[]; cwd: string; toolchain?: string; autoInstall?: string }[] } {
    const calls: { bin: string; args: string[]; cwd: string; toolchain?: string; autoInstall?: string }[] = [];
    const run: ToolRunner = async (bin, args, opts) => {
      calls.push({ bin: path.basename(bin), args, cwd: opts.cwd, toolchain: opts.env.RUSTUP_TOOLCHAIN, autoInstall: opts.env.RUSTUP_AUTO_INSTALL });
      const a = answers(path.basename(bin), args);
      return { code: a.code, stdout: a.stdout ?? '', stderr: a.stderr ?? '' };
    };
    return { run, calls };
  }

  it('reports not_found when rust-analyzer is a rustup proxy without the component', async () => {
    const dir = fakeBins(['cargo', 'rust-analyzer'], true);
    const sysroot = tempDir('ci-rust-sysroot-');
    const { run, calls } = recordingRunner((bin, args) => {
      if (args[0] === 'default') return { code: 0, stdout: 'stable-x (default)\n' };
      if (args.join(' ') === 'which rust-analyzer') return { code: 1, stderr: "error: 'rust-analyzer' is not installed for the toolchain 'stable-x'\n" };
      if (args.join(' ') === 'which rustc') return { code: 0, stdout: '/x/rustc\n' };
      return { code: 0, stdout: `${sysroot}\n` };
    });
    const env = { PATH: dir, RUSTUP_TOOLCHAIN: 'from-user', CODEINSIGHT_RUSTUP: path.join(dir, 'rustup') };
    const runBase = path.join(tempDir('ci-rust-base-'), 'base');
    const res = await findRustTools({ env, home: tempDir('ci-home-'), run, noCache: true, runBase });
    expect(res).toMatchObject({ ok: false, reason: 'not_found' });
    expect(!res.ok && res.detail).toContain('rustup component add rust-analyzer rust-src');
    expect(calls.map((c) => [c.bin, c.args.join(' '), c.toolchain])).toEqual([['rustup', 'default', undefined], ['rustup', 'which rust-analyzer', 'stable-x']]);
    expect(calls.every((c) => c.cwd === realpathSync(runBase) && c.autoInstall === '0')).toBe(true);
    expect(statSync(runBase).mode & 0o777).toBe(0o700);
  });

  it('uses CODEINSIGHT_RUST_ANALYZER directly when rustup is present and it is not a rustup proxy', async () => {
    const dir = fakeBins(['cargo'], true);
    const own = fakeBins(['rust-analyzer']);
    const sysroot = tempDir('ci-rust-sysroot-');
    const { run, calls } = recordingRunner((bin, args) => {
      if (args[0] === 'default') return { code: 0, stdout: 'stable-x (default)\n' };
      if (args.join(' ') === 'which rustc') return { code: 0, stdout: '/x/rustc\n' };
      if (args[0] === '--version') return { code: 0, stdout: 'rust-analyzer 7.7.7\n' };
      return { code: 0, stdout: `${sysroot}\n` };
    });
    const ra = path.join(own, 'rust-analyzer');
    const env = { PATH: dir, CODEINSIGHT_RUSTUP: path.join(dir, 'rustup'), CODEINSIGHT_RUST_ANALYZER: ra };
    const res = await findRustTools({ env, home: tempDir('ci-home-'), run, noCache: true, runBase: tempDir('ci-rust-base-') });
    expect(res.ok && res.tools).toMatchObject({ rustAnalyzer: realpathSync(ra), rustc: '/x/rustc', toolchain: 'stable-x', version: 'rust-analyzer 7.7.7', analyzerPinned: true });
    expect(calls.map((c) => c.args.join(' '))).not.toContain('which rust-analyzer');
  });

  it('reports failed without running anything when the lookup directory is unsafe', async () => {
    const dir = fakeBins(['cargo', 'rust-analyzer'], true);
    const top = tempDir('ci-rust-base-');
    writeFiles(top, { 'Cargo.toml': '[workspace]\n' });
    const { run, calls } = recordingRunner(() => ({ code: 0 }));
    const res = await findRustTools({ env: { PATH: dir, CODEINSIGHT_RUSTUP: path.join(dir, 'rustup') }, home: tempDir('ci-home-'), run, noCache: true, runBase: path.join(top, 'base') });
    expect(res).toMatchObject({ ok: false, reason: 'failed', detail: expect.stringContaining('Cargo.toml') });
    expect(calls).toEqual([]);
  });

  it('reports not_found when cargo is a rustup proxy but rustup cannot be found', async () => {
    const dir = fakeBins(['cargo', 'rust-analyzer'], true);
    const { run, calls } = recordingRunner(() => ({ code: 0 }));
    const env = { PATH: dir, CODEINSIGHT_RUSTUP: '/nonexistent/rustup' };
    const res = await findRustTools({ env, home: tempDir('ci-home-'), run, noCache: true, runBase: tempDir('ci-rust-base-') });
    expect(res).toMatchObject({ ok: false, reason: 'not_found' });
    expect(calls).toEqual([]);
  });

  it('reports not_found when `rustup default` fails', async () => {
    const dir = fakeBins(['cargo', 'rust-analyzer'], true);
    const { run } = recordingRunner(() => ({ code: 1, stderr: 'error: no default toolchain configured\n' }));
    const res = await findRustTools({ env: { PATH: dir, CODEINSIGHT_RUSTUP: path.join(dir, 'rustup') }, home: tempDir('ci-home-'), run, noCache: true, runBase: tempDir('ci-rust-base-') });
    expect(res).toMatchObject({ ok: false, reason: 'not_found' });
    expect(!res.ok && res.detail).toContain('no default toolchain');
  });

  it('stops looking up a root toolchain when cancelled', async () => {
    const ac = new AbortController();
    const { run, calls } = recordingRunner(() => {
      ac.abort();
      return { code: 1 };
    });
    const base: RustTools = { cargo: '/c', rustAnalyzer: '/ra', rustc: '/rc', toolchain: 'stable-x', version: 'v', rustSrc: true, rustup: '/rustup', trueBin: '/usr/bin/true' };
    await expect(toolsForChannel(base, 'nightly', { run, signal: ac.signal, timeoutMs: 5_000, runBase: tempDir('ci-rust-base-') })).rejects.toThrow(/cancelled/);
    expect(calls).toHaveLength(1);
  });

  it('reports not_found when a lookup command cannot be started', async () => {
    const dir = fakeBins(['cargo', 'rust-analyzer']);
    writeFileSync(path.join(dir, 'rustc'), '#!/bin/sh\nexit 0\n');
    chmodSync(path.join(dir, 'rustc'), 0o644);
    const res = await findRustTools({ env: { PATH: dir, CODEINSIGHT_RUSTUP: '/nonexistent/rustup' }, home: tempDir('ci-home-'), noCache: true, runBase: tempDir('ci-rust-base-') });
    expect(res).toMatchObject({ ok: false, reason: 'not_found', detail: expect.stringContaining('rustc failed to start') });
  });

  it('reports failed instead of throwing on an unexpected lookup error', async () => {
    const dir = fakeBins(['cargo', 'rust-analyzer', 'rustc']);
    const run: ToolRunner = async () => {
      throw new TypeError('boom\nmore');
    };
    const res = await findRustTools({ env: { PATH: dir, CODEINSIGHT_RUSTUP: '/nonexistent/rustup' }, home: tempDir('ci-home-'), run, noCache: true, runBase: tempDir('ci-rust-base-') });
    expect(res).toEqual({ ok: false, reason: 'failed', detail: 'boom' });
  });

  it('uses rustc next to cargo and pins every call to the toolchain when found', async () => {
    const dir = fakeBins(['cargo', 'rust-analyzer', 'rustc']);
    const sysroot = tempDir('ci-rust-sysroot-');
    mkdirSync(path.join(sysroot, 'lib/rustlib/src/rust/library'), { recursive: true });
    const { run, calls } = recordingRunner((bin, args) => (args[0] === '--version' ? { code: 0, stdout: 'rust-analyzer 9.9.9\n' } : { code: 0, stdout: `${sysroot}\n` }));
    const res = await findRustTools({ env: { PATH: dir, CODEINSIGHT_RUSTUP: '/nonexistent/rustup' }, home: tempDir('ci-home-'), run, noCache: true, runBase: tempDir('ci-rust-base-') });
    expect(res.ok && res.tools).toMatchObject({ rustc: path.join(realpathSync(dir), 'rustc'), version: 'rust-analyzer 9.9.9', rustSrc: true });
    expect(res.ok && res.tools.toolchain).toBeUndefined();
    expect(calls.every((c) => c.cwd.includes('ci-rust-base-') && c.toolchain === undefined && c.autoInstall === '0')).toBe(true);
  });
});

describe('Rust dependency load checks', () => {
  it('passes stderr to the caller line by line even when a line arrives in several chunks', async () => {
    const script = "process.stderr.write('x\\nwarn cargo metadata failed and returning succeeded result with `--no');"
      + "setTimeout(() => process.stderr.write('-deps` tail\\nlast'), 50);";
    const watch = new RustStderrWatch('');
    const lines: string[] = [];
    await runProcess({ bin: process.execPath, args: ['-e', script], cwd: tempDir(), timeoutMs: 10_000, onStderr: (l) => { lines.push(l); watch.onLine(l); } });
    expect(lines).toEqual(['x', 'warn cargo metadata failed and returning succeeded result with `--no-deps` tail', 'last']);
    expect(watch.noDeps).toBe(true);
  });

  it('treats a missing cross-crate reference as a load failure only when the code uses a dependency', () => {
    const root = { dir: '', packages: [pkg('', 'app', [], { deps: ['serde-json', 'shop-core'] }), pkg('core', 'shop-core', [])] };
    const local: ScipIndex = { documents: [{ relativePath: 'src/main.rs', occurrences: [occ(0, 0, 1, `${APP}main().`), occ(0, 2, 3, `${SHOP}f().`)] }] };
    const withDep: ScipIndex = { documents: [{ relativePath: 'src/main.rs', occurrences: [occ(0, 0, 1, 'rust-analyzer cargo serde_json 1.0.0 from_str().')] }] };
    const usesDep = [rsFile('src/main.rs', 'src/main.rs', { pathRoots: ['serde_json', 'std'] })];
    const usesLocal = [rsFile('src/main.rs', 'src/main.rs', { pathRoots: ['shop_core', 'std', 'crate'] })];
    expect(dependenciesMissing(local, root, usesDep)).toBe(true);
    expect(dependenciesMissing(withDep, root, usesDep)).toBe(false);
    expect(dependenciesMissing(local, root, usesLocal)).toBe(false);
  });
});

describe('Rust run directory location', () => {
  const fakeTools = (cargo: string): RustTools => ({ cargo, rustAnalyzer: cargo, rustc: cargo, version: 'v', rustSrc: true, trueBin: '/usr/bin/true' });

  async function run(cache: string, markers: string, home = path.dirname(cache)): Promise<Awaited<ReturnType<typeof buildRustScipIndex>>> {
    const snap = tempDir('ci-rust-loc-snap-');
    writeFiles(snap, { 'Cargo.toml': '[package]\nname = "a"\n', 'src/lib.rs': 'pub fn f() {}\n' });
    const cargo = markerScript(path.join(markers, 'bin'), 'cargo', markers);
    return buildRustScipIndex({
      snapshotDir: snap, contentKey: 'k', files: minimalFiles(snap), packages: await packagesIn(snap), tools: fakeTools(cargo),
      output: path.join(tempDir('ci-rust-loc-out-'), 'k.rust.scip'), timeoutMs: 30_000, env: { ...process.env, XDG_CACHE_HOME: cache, HOME: home },
    });
  }

  it('creates a private directory under the user cache directory and runs cargo there', async () => {
    const cache = path.join(tempDir('ci-rust-cache-'), 'cache');
    const markers = tempDir('ci-rust-loc-markers-');
    const result = await run(cache, markers);
    expect(result.roots).toEqual([{ dir: '', ok: false, error: expect.stringContaining('cargo metadata failed') }]);
    expect(readdirSync(markers)).toContain('cargo-ran');
    for (const d of ['codeinsight', 'codeinsight/rust-run']) expect(statSync(path.join(cache, d)).mode & 0o777).toBe(0o700);
    expect(readdirSync(path.join(cache, 'codeinsight/rust-run'))).toEqual([]);
  });

  it.each([['.cargo/config.toml', '[build]\nrustc-wrapper = "/bin/evil"\n'], ['.cargo/config', ''], ['Cargo.toml', '[workspace]\n']])(
    'fails without running cargo when %s is above the run directory', async (rel, text) => {
      const top = tempDir('ci-rust-cache-');
      writeFiles(top, { [rel]: text });
      const markers = tempDir('ci-rust-loc-markers-');
      const result = await run(path.join(top, 'cache'), markers);
      expect(result.roots).toEqual([{ dir: '', ok: false, error: expect.stringContaining(`above the rust run directory: ${realpathSync(top)}/${rel}`) }]);
      expect(readdirSync(markers)).toEqual(['bin']);
    },
  );

  it('fails without running cargo when the run directory is a symlink in every cache directory', async () => {
    const home = tempDir('ci-rust-cache-');
    const cache = path.join(home, 'cache');
    for (const c of [cache, path.join(home, '.cache')]) {
      mkdirSync(path.join(c, 'codeinsight'), { recursive: true });
      symlinkSync(tempDir('ci-rust-elsewhere-'), path.join(c, 'codeinsight/rust-run'));
    }
    const markers = tempDir('ci-rust-loc-markers-');
    const result = await run(cache, markers, home);
    expect(result.roots[0]).toMatchObject({ ok: false, error: expect.stringContaining('symlink') });
    expect(readdirSync(markers)).toEqual(['bin']);
  });
  it('falls back to ~/.cache when a directory above the XDG cache directory is writable by other users', async () => {
    const home = tempDir('ci-rust-cache-');
    const shared = path.join(home, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    const cache = path.join(shared, 'xdg');
    const markers = tempDir('ci-rust-loc-markers-');
    const result = await run(cache, markers, home);
    expect(result.roots[0]).toMatchObject({ ok: false, error: expect.stringContaining('cargo metadata failed') });
    expect(existsSync(path.join(cache, 'codeinsight'))).toBe(false);
    expect(statSync(path.join(home, '.cache/codeinsight/rust-run')).mode & 0o777).toBe(0o700);
  });

  it('fails a root when cargo configuration appears above the run directory after it was prepared', async () => {
    const top = tempDir('ci-rust-cache-');
    const bin = tempDir('ci-rust-loc-bin-');
    const calls = path.join(bin, 'calls');
    const cargo = path.join(bin, 'cargo');
    writeFileSync(cargo, `#!/bin/sh\necho run >> "${calls}"\nprintf '[workspace]\\n' > "${top}/Cargo.toml"\nexit 1\n`);
    chmodSync(cargo, 0o755);
    const snap = tempDir('ci-rust-loc-snap-');
    writeFiles(snap, { 'Cargo.toml': '[package]\nname = "a"\n', 'src/lib.rs': 'pub fn f() {}\n' });
    const result = await buildRustScipIndex({
      snapshotDir: snap, contentKey: 'k', files: minimalFiles(snap), packages: await packagesIn(snap), tools: fakeTools(cargo),
      output: path.join(tempDir('ci-rust-loc-out-'), 'k.rust.scip'), timeoutMs: 30_000, env: { ...process.env, XDG_CACHE_HOME: path.join(top, 'cache'), HOME: top },
    });
    expect(result.roots).toEqual([{ dir: '', ok: false, error: expect.stringContaining(`above the rust run directory: ${realpathSync(top)}/Cargo.toml`) }]);
    expect(result.roots[0]!.error).toContain('set XDG_CACHE_HOME');
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('falls back to ~/.cache when the XDG cache directory is writable by other users', async () => {
    const home = tempDir('ci-rust-cache-');
    const cache = path.join(home, 'xdg');
    mkdirSync(cache);
    chmodSync(cache, 0o777);
    const markers = tempDir('ci-rust-loc-markers-');
    const result = await run(cache, markers, home);
    expect(result.roots[0]).toMatchObject({ ok: false, error: expect.stringContaining('cargo metadata failed') });
    expect(readdirSync(markers)).toContain('cargo-ran');
    expect(existsSync(path.join(cache, 'codeinsight'))).toBe(false);
    expect(statSync(path.join(home, '.cache/codeinsight/rust-run')).mode & 0o777).toBe(0o700);
  });
});

describe('Rust root failures', () => {
  const fakeTools = (cargo: string): RustTools => ({ cargo, rustAnalyzer: cargo, rustc: cargo, version: 'v', rustSrc: true, trueBin: '/usr/bin/true' });

  /** 每次运行在 calls 文件里记一行，按 stderr 内容输出后睡眠，直到被结束 */
  function sleepingCargo(stderr: string): { cargo: string; calls: string } {
    const dir = tempDir('ci-rust-fake-cargo-');
    const calls = path.join(dir, 'calls');
    const cargo = path.join(dir, 'cargo');
    writeFileSync(cargo, `#!/bin/sh\necho run >> "${calls}"\necho "${stderr}" >&2\nexec sleep 30\n`);
    chmodSync(cargo, 0o755);
    return { cargo, calls };
  }

  async function runWith(snapFiles: Record<string, string>, cargo: string, timeoutMs = 30_000, prepare?: (snap: string) => void) {
    const snap = tempDir('ci-rust-rootfail-snap-');
    writeFiles(snap, snapFiles);
    prepare?.(snap);
    const outDir = tempDir('ci-rust-rootfail-out-');
    const result = await buildRustScipIndex({
      snapshotDir: snap, contentKey: 'k', files: minimalFiles(snap), packages: await packagesIn(snap), tools: fakeTools(cargo),
      output: path.join(outDir, 'k.rust.scip'), timeoutMs, tmpDir: tempDir('ci-rust-rootfail-run-'),
    });
    return { result, outDir };
  }

  const ONE = { 'Cargo.toml': '[package]\nname = "a"\n', 'src/lib.rs': 'pub fn f() {}\n' };

  it('reports a cargo lock wait when offline cargo metadata times out, without retrying online', async () => {
    const { cargo, calls } = sleepingCargo('    Blocking waiting for file lock on package cache');
    const { result } = await runWith(ONE, cargo, 1_500);
    expect(result.roots).toEqual([{ dir: '', ok: false, error: 'cargo metadata failed: timed out waiting for the cargo package cache lock' }]);
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
  }, 30_000);

  it('does not retry online after an offline timeout without a lock wait', async () => {
    const { cargo, calls } = sleepingCargo('working');
    const { result } = await runWith(ONE, cargo, 1_500);
    expect(result.roots[0]!.error).toBe('cargo metadata failed: timed out after 1500ms');
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
  }, 30_000);

  it('records a root as failed when cargo cannot be started, and leaves no temporary cache files', async () => {
    const { result, outDir } = await runWith({
      'a/Cargo.toml': '[package]\nname = "a"\n', 'a/src/lib.rs': 'pub fn f() {}\n',
      'b/Cargo.toml': '[package]\nname = "b"\n', 'b/src/lib.rs': 'pub fn g() {}\n',
    }, '/nonexistent/cargo');
    expect(result.roots.map((r) => [r.dir, r.ok])).toEqual([['a', false], ['b', false]]);
    expect(result.roots.every((r) => r.error!.includes('cargo failed to start'))).toBe(true);
    expect(readdirSync(outDir).sort()).toEqual(['k.rust.json', 'k.rust.scip']);
  });

  it('fails only the root whose Cargo.toml is a symlink', async () => {
    const markers = tempDir('ci-rust-rootfail-markers-');
    const cargo = markerScript(path.join(markers, 'bin'), 'cargo', markers);
    const { result } = await runWith({
      'a/real.toml': '[package]\nname = "a"\n', 'a/src/lib.rs': 'pub fn f() {}\n',
      'b/Cargo.toml': '[package]\nname = "b"\n', 'b/src/lib.rs': 'pub fn g() {}\n',
    }, cargo, 30_000, (snap) => symlinkSync('real.toml', path.join(snap, 'a/Cargo.toml')));
    expect(result.roots).toEqual([
      { dir: 'a', ok: false, error: expect.stringContaining('Cargo.toml was not placed') },
      { dir: 'b', ok: false, error: expect.stringContaining('cargo metadata failed') },
    ]);
  });
});

// ---- 本机有 rust-analyzer 时的集成测试 ----

const toolsLookup = await findRustTools({ runBase: tempDir('ci-rust-base-') });
const hasRust = toolsLookup.ok;
const tools = toolsLookup.ok ? toolsLookup.tools : undefined;

function listFiles(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(root, p));
    else out.push(p);
  }
  return out.sort();
}

function treeHash(root: string): string {
  const h = createHash('sha256');
  for (const f of listFiles(root)) h.update(f).update(readFileSync(path.join(root, f)));
  return h.digest('hex');
}

async function packagesIn(root: string): Promise<Map<string, RustPackage>> {
  return collectRustCrates(listFiles(root), (p) => readFile(path.join(root, p), 'utf8'));
}

function minimalFiles(root: string): ExtractedFile[] {
  return listFiles(root).filter((p) => p.endsWith('.rs')).map((p) => rsFile(p, p));
}

/** 运行时会写标记文件的脚本 */
function markerScript(dir: string, name: string, markers: string): string {
  const file = path.join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `#!/bin/sh\ntouch "${markers}/${name}-ran"\nexit 1\n`);
  chmodSync(file, 0o755);
  return file;
}

function analyzerProcesses(marker: string): string[] {
  return execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(marker) && !l.includes('ps -axo'));
}

describe.skipIf(!hasRust)('rust-analyzer scip on rust-basic', () => {
  let input: ResolveInput;
  let packages: Map<string, RustPackage>;
  let markers: string;
  let tmp: string;
  let before: string;
  let result: Awaited<ReturnType<typeof buildRustScipIndex>>;
  let output: string;

  beforeAll(async () => {
    const repo = tempDir('ci-rust-scip-repo-');
    cpSync(FIXTURE, repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    commitAll(repo, 'init');
    const config = await loadConfig(repo, { dataDir: tempDir('ci-rust-scip-data-') });
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    const capture: Resolver = { name: 'capture', version: '1', resolve: async (i) => { input = i; return { edges: [] }; } };
    await buildSnapshot({ repo, store, layout, config, ref: 'HEAD', resolver: capture });
    store.close();
    packages = await packagesIn(input.root);
    markers = tempDir('ci-rust-markers-');
    tmp = tempDir('ci-rust-run-');
    before = treeHash(input.root);
    output = path.join(tempDir('ci-rust-out-'), 'k.rust.scip');
    result = await buildRustScipIndex({
      snapshotDir: input.root, contentKey: input.contentKey, files: input.files, packages, tools: tools!, output, timeoutMs: 300_000,
      tmpDir: tmp, env: { ...process.env, CODEINSIGHT_TEST_MARKER_DIR: markers },
    });
  }, 300_000);

  it('indexes the workspace without running build scripts or proc-macros', () => {
    expect(result.roots).toEqual([{ dir: '', ok: true }]);
    expect(readdirSync(markers)).toEqual([]);
    expect(readdirSync(tmp)).toEqual([]);
    expect(treeHash(input.root)).toBe(before);
  });

  it('turns the index into call and import edges', async () => {
    const sources = new Map<string, string>();
    for (const f of input.files) sources.set(f.path, await readFile(path.join(input.root, f.path), 'utf8'));
    const prepared = prepareRustIndex(decodeScipIndex(await readFile(output)), input.files, sources, packages);
    const { edges } = scipToEdges(prepared.index, input.files, sources, 1, rustRules);
    const sym = new Map(input.files.flatMap((f) => f.symbols.map((s) => [s.id, `${f.path}#${s.qualifiedName}`] as const)));
    const named = edges.map((e) => `${e.kind} ${sym.get(e.srcId)} -> ${sym.get(e.dstId)}`);
    const ratio = prepared.stats.matchedByPosition / prepared.stats.definitions;
    console.info(`rust-analyzer ${tools!.version}: ${prepared.stats.matchedByPosition}/${prepared.stats.definitions} definitions matched by position`);
    expect(ratio).toBeGreaterThan(0.95);
    expect(named).toContain('call crates/app/src/main.rs#app::main -> crates/core/src/order/service.rs#shop_core::order::service::Service::create');
    expect(named).toContain('call crates/app/src/main.rs#app::main -> crates/app/src/cli.rs#app::cli::run');
    expect(named).toContain('call crates/app/src/bin/tool.rs#tool::main -> crates/app/src/a.rs#app::a::greet');
    expect(named).toContain('call crates/core/src/order/repo.rs#shop_core::order::repo::Repo::exists -> crates/core/src/order/repo.rs#shop_core::order::repo::Repo::find');
    expect(named).toContain('import crates/core/src/order/mod.rs#shop_core::order -> crates/core/src/lib.rs#shop_core');
    const mainImports = named.filter((n) => n.startsWith('import crates/app/src/main.rs#'));
    expect(mainImports.sort()).toEqual([
      'import crates/app/src/main.rs#app -> crates/core/src/order/repo.rs#shop_core::order::repo::MemRepo',
      'import crates/app/src/main.rs#app -> crates/core/src/order/service.rs#shop_core::order::service::Service',
    ]);
    expect(named.some((n) => n.includes('main.rs#tool::main -> ') && n.includes('crates/app/src/main.rs'))).toBe(false);
  });

  it('caches the merged index with the per-root results', async () => {
    const cached = await readRustScipCache(output);
    expect(cached?.result.roots).toEqual(result.roots);
    expect(cached?.index.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasRust)('rust-analyzer scip isolation from repository configuration', () => {
  it('runs nothing named by repository, ancestor or user configuration', async () => {
    const markers = tempDir('ci-rust-evil-markers-');
    const evilBin = path.join(tempDir('ci-rust-evil-'), 'bin');
    const wrapper = markerScript(evilBin, 'wrapper', markers);
    for (const n of ['cargo', 'rustc', 'rust-analyzer']) markerScript(evilBin, n, markers);
    const evilConfig = `[build]\nrustc-wrapper = "${wrapper}"\nrustc = "${wrapper}"\n[target.'cfg(all())']\nlinker = "${wrapper}"\n`;
    const evilToolchain = `[toolchain]\npath = "${path.dirname(evilBin)}"\n`;
    // 数据目录在一个“仓库”里，仓库根目录有恶意配置和不包含快照里的包的 [workspace]
    const fakeRepo = tempDir('ci-rust-evil-repo-');
    writeFiles(fakeRepo, { '.cargo/config.toml': evilConfig, 'rust-toolchain.toml': evilToolchain, 'Cargo.toml': '[workspace]\nmembers = ["nothing"]\n' });
    const snap = path.join(fakeRepo, '.codeinsight', 'snapshots', 'k');
    writeFiles(snap, {
      'Cargo.toml': '[package]\nname = "solo"\nversion = "0.1.0"\nedition = "2021"\n', 'src/lib.rs': 'pub fn f() -> u8 { g() }\nfn g() -> u8 { 1 }\n',
      'build.rs': `fn main() { std::fs::write("${markers}/build-rs-ran", "1").unwrap(); }\n`,
      '.cargo/config.toml': evilConfig, 'rust-toolchain.toml': evilToolchain,
    });
    const tmp = tempDir('ci-rust-evil-run-');
    const output = path.join(tempDir('ci-rust-evil-out-'), 'k.rust.scip');
    const env = { ...process.env, RUSTC_WRAPPER: wrapper, CARGO_BUILD_RUSTC_WRAPPER: wrapper, CARGO_BUILD_RUSTC: wrapper, RUSTDOC: wrapper };
    const result = await buildRustScipIndex({
      snapshotDir: snap, contentKey: 'k', files: minimalFiles(snap), packages: await packagesIn(snap), tools: tools!, output, timeoutMs: 300_000,
      tmpDir: tmp, env, keepRunDir: true,
    });
    expect(result.roots).toEqual([{ dir: '', ok: true }]);
    expect(readdirSync(markers)).toEqual([]);
    const runFiles = listFiles(result.runDir!);
    expect(runFiles.filter((f) => f.includes('/build/') || f.includes('out/'))).toEqual([]);
    expect(runFiles.filter((f) => !f.startsWith('target/'))).toEqual(['0.scip', 'Cargo.lock', 'Cargo.toml', 'build.rs', 'ra-config.json', 'src/lib.rs']);
    execFileSync('rm', ['-rf', result.runDir!]);
  }, 300_000);
});

describe.skipIf(!hasRust)('rust-analyzer scip failures', () => {
  it('records a failed root and keeps the index of the other root', async () => {
    const snap = tempDir('ci-rust-fail-snap-');
    writeFiles(snap, {
      'good/Cargo.toml': '[package]\nname = "good"\nversion = "0.1.0"\nedition = "2021"\n', 'good/src/lib.rs': 'pub fn ok() {}\n',
      'bad/Cargo.toml': '[package]\nname = "bad"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nmissing-dep = { path = "../missing" }\n',
      'bad/src/lib.rs': 'use missing_dep::X;\npub fn f() {}\n',
    });
    const output = path.join(tempDir('ci-rust-fail-out-'), 'k.rust.scip');
    const result = await buildRustScipIndex({
      snapshotDir: snap, contentKey: 'k', files: minimalFiles(snap), packages: await packagesIn(snap), tools: tools!, output, timeoutMs: 300_000, tmpDir: tempDir('ci-rust-fail-run-'),
    });
    expect(result.roots.map((r) => [r.dir, r.ok])).toEqual([['bad', false], ['good', true]]);
    expect(result.roots[0]!.error).toContain('cargo metadata failed');
    expect(decodeScipIndex(await readFile(output)).documents.map((d) => d.relativePath)).toEqual(['good/src/lib.rs']);
  }, 300_000);

  it('kills the process group and removes the run directory when cancelled', async () => {
    const snap = tempDir('ci-rust-abort-snap-');
    cpSync(FIXTURE, snap, { recursive: true });
    const tmp = tempDir('ci-rust-abort-run-');
    const ac = new AbortController();
    const started = buildRustScipIndex({
      snapshotDir: snap, contentKey: 'k', files: minimalFiles(snap), packages: await packagesIn(snap), tools: tools!,
      output: path.join(tempDir('ci-rust-abort-out-'), 'k.rust.scip'), timeoutMs: 300_000, tmpDir: tmp, signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 700);
    await expect(started).rejects.toThrow(/cancelled/);
    expect(readdirSync(tmp)).toEqual([]);
    expect(analyzerProcesses(realpathSync(tmp))).toEqual([]);
  }, 60_000);
});
