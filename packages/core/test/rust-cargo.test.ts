import { describe, expect, it } from 'vitest';
import {
  cargoLockDirs, collectRustCrates, parseToolchainChannel, rustCratesFromManifests, rustFileUnit, type RustPackage,
} from '../src/extract/index.js';

const WORKSPACE = `
[workspace]
members = ["crates/*", "tools/gen"]
exclude = ["crates/legacy"]

[workspace.dependencies]
serde = "1"
`;

const CORE = `
[package]
name = "shop-core"
version = "0.1.0"

[dependencies]
serde = { workspace = true }
json = { package = "serde_json", version = "1" }

[dev-dependencies]
tokio = "1"

[build-dependencies]
cc = "1"

[target.'cfg(unix)'.dependencies]
libc = "0.2"
`;

const APP = `
[package]
name = "app"
version = "0.1.0"
autobins = true

[[bin]]
name = "admin"
path = "tools/admin.rs"

[[test]]
name = "smoke"
path = "checks/smoke.rs"
`;

const FILES = [
  'Cargo.toml', 'crates/core/Cargo.toml', 'crates/core/src/lib.rs', 'crates/core/src/order/mod.rs', 'crates/core/src/order/repo.rs',
  'crates/core/tests/it.rs', 'crates/core/tests/common/mod.rs', 'crates/core/tests/common/db.rs', 'crates/core/benches/speed.rs',
  'crates/core/examples/demo.rs', 'crates/core/build.rs',
  'crates/app/Cargo.toml', 'crates/app/src/main.rs', 'crates/app/src/cli.rs', 'crates/app/src/bin/tool.rs', 'crates/app/src/bin/big/main.rs',
  'crates/app/src/bin/big/util.rs', 'crates/app/src/bin/tool/helper.rs', 'crates/app/tools/admin.rs', 'crates/app/checks/smoke.rs',
  'crates/legacy/Cargo.toml', 'crates/legacy/src/lib.rs', 'tools/gen/Cargo.toml', 'tools/gen/src/main.rs',
  'standalone/Cargo.toml', 'standalone/src/lib.rs', 'scripts/one.rs', 'top.rs', 'rust-toolchain.toml', 'standalone/rust-toolchain',
];

function pkg(name: string): string {
  return `[package]\nname = "${name}"\nversion = "0.1.0"\n`;
}

function crates(): Map<string, RustPackage> {
  return rustCratesFromManifests({
    manifests: new Map([
      ['Cargo.toml', WORKSPACE], ['crates/core/Cargo.toml', CORE], ['crates/app/Cargo.toml', APP],
      ['crates/legacy/Cargo.toml', pkg('legacy')], ['tools/gen/Cargo.toml', pkg('gen')], ['standalone/Cargo.toml', pkg('standalone')],
    ]),
    toolchains: new Map([['rust-toolchain.toml', '[toolchain]\nchannel = "1.80.0"\n'], ['standalone/rust-toolchain', 'nightly-2024-01-01\n']]),
    files: FILES,
  });
}

describe('Cargo.toml parsing', () => {
  it('reads package targets from the default layout and explicit paths', () => {
    const c = crates();
    const core = c.get('crates/core')!;
    expect(core).toMatchObject({ name: 'shop-core', libName: 'shop_core', workspaceRoot: '' });
    expect(core.targets.map((t) => `${t.kind}:${t.name}:${t.root}`)).toEqual([
      'lib:shop_core:crates/core/src/lib.rs',
      'test:it:crates/core/tests/it.rs',
      'bench:speed:crates/core/benches/speed.rs',
      'example:demo:crates/core/examples/demo.rs',
      'build:build_script_build:crates/core/build.rs',
    ]);
    const app = c.get('crates/app')!;
    expect(app.libName).toBeUndefined();
    expect(app.targets.map((t) => `${t.kind}:${t.name}:${t.root}`)).toEqual([
      'bin:app:crates/app/src/main.rs',
      'bin:big:crates/app/src/bin/big/main.rs',
      'bin:tool:crates/app/src/bin/tool.rs',
      'bin:admin:crates/app/tools/admin.rs',
      'test:smoke:crates/app/checks/smoke.rs',
    ]);
  });

  it('collects dependency keys from every dependency table', () => {
    expect(crates().get('crates/core')!.deps).toEqual(['cc', 'json', 'libc', 'serde', 'tokio']);
  });

  it('resolves workspace membership with globs and exclude', () => {
    const c = crates();
    expect(c.get('crates/app')!.workspaceRoot).toBe('');
    expect(c.get('tools/gen')!.workspaceRoot).toBe('');
    expect(c.get('crates/legacy')!.workspaceRoot).toBeUndefined();
    expect(c.get('standalone')!.workspaceRoot).toBeUndefined();
    expect(cargoLockDirs(c)).toEqual(['', 'crates/legacy', 'standalone']);
  });

  it('normalizes workspace exclude entries like members', () => {
    const c = rustCratesFromManifests({
      manifests: new Map([
        ['Cargo.toml', '[workspace]\nmembers = ["./crates/*/"]\nexclude = ["crates/legacy/", "./crates/old"]\n'],
        ['crates/a/Cargo.toml', pkg('a')], ['crates/legacy/Cargo.toml', pkg('legacy')], ['crates/old/Cargo.toml', pkg('old')],
      ]),
      files: [],
    });
    expect(c.get('crates/a')!.workspaceRoot).toBe('');
    expect(c.get('crates/legacy')!.workspaceRoot).toBeUndefined();
    expect(c.get('crates/old')!.workspaceRoot).toBeUndefined();
  });

  it('prefers the legacy rust-toolchain file over rust-toolchain.toml in the same directory, as rustup does', () => {
    const c = rustCratesFromManifests({
      manifests: new Map([['Cargo.toml', pkg('a')]]),
      toolchains: new Map([['rust-toolchain', 'nightly\n'], ['rust-toolchain.toml', '[toolchain]\nchannel = "stable"\n']]),
      files: [],
    });
    expect(c.get('')!.toolchainChannel).toBe('nightly');
  });

  it('takes the toolchain channel from the nearest rust-toolchain file', () => {
    const c = crates();
    expect(c.get('crates/core')!.toolchainChannel).toBe('1.80.0');
    expect(c.get('standalone')!.toolchainChannel).toBe('nightly-2024-01-01');
  });

  it('skips manifests that are not valid TOML and reports them', () => {
    const errors: string[] = [];
    const c = rustCratesFromManifests({
      manifests: new Map([['a/Cargo.toml', '[package\nname='], ['b/Cargo.toml', pkg('b')]]), files: ['b/src/lib.rs'],
      onParseError: (p) => errors.push(p),
    });
    expect([...c.keys()]).toEqual(['b']);
    expect(errors).toEqual(['a/Cargo.toml']);
  });

  it('reads manifests through a reader, skipping excluded directories and reporting read errors', async () => {
    const files: Record<string, string> = { 'Cargo.toml': pkg('root'), 'vendor/dep/Cargo.toml': pkg('dep'), 'src/lib.rs': '' };
    const errors: string[] = [];
    const read = async (p: string): Promise<string> => {
      if (p === 'broken/Cargo.toml') throw new Error('gone');
      return files[p]!;
    };
    const c = await collectRustCrates([...Object.keys(files), 'broken/Cargo.toml'], read, (p) => errors.push(p));
    expect([...c.keys()]).toEqual(['']);
    expect(errors).toEqual(['broken/Cargo.toml']);
  });
});

describe('rust-toolchain channel', () => {
  it('reads the channel from both formats and rejects unsafe values', () => {
    expect(parseToolchainChannel('rust-toolchain.toml', '[toolchain]\nchannel = "stable"\ncomponents = ["rustfmt"]\n')).toBe('stable');
    expect(parseToolchainChannel('rust-toolchain', '1.75.0\n')).toBe('1.75.0');
    expect(parseToolchainChannel('rust-toolchain', '[toolchain]\nchannel = "beta"\n')).toBe('beta');
    expect(parseToolchainChannel('rust-toolchain.toml', '[toolchain]\npath = "/opt/evil"\n')).toBeUndefined();
    expect(parseToolchainChannel('rust-toolchain.toml', '[toolchain]\nchannel = "../evil"\n')).toBeUndefined();
    expect(parseToolchainChannel('rust-toolchain', 'stable; rm -rf /\n')).toBeUndefined();
  });
});

describe('file to crate target and module path', () => {
  it('maps files by path and the package layout', () => {
    const c = crates();
    const unit = (p: string) => rustFileUnit(p, c);
    expect(unit('crates/core/src/lib.rs')).toEqual({ crate: 'shop_core', target: 'crates/core/src/lib.rs', kind: 'lib', modulePath: [], packageDir: 'crates/core' });
    expect(unit('crates/core/src/order/mod.rs')).toMatchObject({ crate: 'shop_core', target: 'crates/core/src/lib.rs', modulePath: ['order'] });
    expect(unit('crates/core/src/order/repo.rs').modulePath).toEqual(['order', 'repo']);
    expect(unit('crates/core/tests/it.rs')).toMatchObject({ crate: 'it', target: 'crates/core/tests/it.rs', modulePath: [] });
    expect(unit('crates/core/tests/common/mod.rs')).toMatchObject({ crate: 'common', target: 'crates/core/tests/common', modulePath: [] });
    expect(unit('crates/core/tests/common/db.rs')).toMatchObject({ crate: 'common', target: 'crates/core/tests/common', modulePath: ['db'] });
    expect(unit('crates/app/src/cli.rs')).toMatchObject({ crate: 'app', target: 'crates/app/src/main.rs', modulePath: ['cli'] });
    expect(unit('crates/app/src/bin/tool.rs')).toMatchObject({ crate: 'tool', target: 'crates/app/src/bin/tool.rs', modulePath: [] });
    expect(unit('crates/app/src/bin/big/util.rs')).toMatchObject({ crate: 'big', target: 'crates/app/src/bin/big/main.rs', modulePath: ['util'] });
    const shared = unit('crates/app/src/bin/tool/helper.rs');
    expect(shared).toMatchObject({ crate: 'tool', target: 'crates/app/src/bin/tool', modulePath: ['helper'] });
    expect(shared.kind).toBeUndefined();
    expect(unit('scripts/one.rs')).toEqual({ crate: 'scripts', target: 'scripts/one.rs', modulePath: [] });
    expect(unit('top.rs')).toEqual({ crate: 'top', target: 'top.rs', modulePath: [] });
  });
});
