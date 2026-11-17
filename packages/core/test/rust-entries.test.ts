import { describe, expect, it } from 'vitest';
import { deserializeExtractedFile, serializeExtractedFile } from '../src/extract/cache.js';
import { extractFiles, getRustParser, restoreRustFile, rustCratesFromManifests } from '../src/index.js';
import type { ExtractResult } from '../src/index.js';

/** 一个包（目录 app）：deps 为依赖名；files 为路径 → 源码 */
function crates(deps: string[], files: string[]) {
  const toml = `[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\n${deps.map((d) => `${d} = "1"`).join('\n')}\n`;
  return rustCratesFromManifests({ manifests: new Map([['Cargo.toml', toml]]), files: ['Cargo.toml', ...files] });
}

async function extract(deps: string[], files: Record<string, string>): Promise<ExtractResult> {
  const ctx = { goModules: new Map<string, string>(), rustCrates: crates(deps, Object.keys(files)) };
  const sources = Object.entries(files).map(([path, source]) => ({ path, source, language: 'rust' as const, isTest: false, isGenerated: false }));
  return extractFiles(sources, ctx);
}

/** 入口列表转成 `kind framework qualifiedName` 和 detail，便于比较 */
function entryList(r: ExtractResult): { key: string; detail: Record<string, unknown> }[] {
  const byId = new Map(r.files.flatMap((f) => f.symbols).map((s) => [s.id, s]));
  return r.entries.map((e) => ({ key: `${e.kind} ${e.framework} ${byId.get(e.symbolId)?.qualifiedName}`, detail: e.detail }));
}

const HANDLERS = `pub async fn list() {}
pub async fn create() {}
pub async fn health() {}
`;

describe('rust entry recognition', () => {
  it('recognizes fn main in bin target roots only, with #[tokio::main] and two bins', async () => {
    const r = await extract(['tokio'], {
      'src/main.rs': '#[tokio::main]\nasync fn main() {}\n',
      'src/bin/tool.rs': 'fn main() {}\n',
      'src/lib.rs': 'pub fn main() {}\n',
      'build.rs': 'fn main() {}\n',
      'examples/demo.rs': 'fn main() {}\n',
    });
    expect(entryList(r)).toEqual([
      { key: 'cli rust app::main', detail: {} },
      { key: 'cli rust tool::main', detail: {} },
    ]);
  });

  it('recognizes axum method chains, nest prefixes and closure handlers', async () => {
    const r = await extract(['axum'], {
      'src/lib.rs': 'pub mod handlers;\n',
      'src/handlers.rs': HANDLERS,
      'src/main.rs': `use axum::{routing::{get, post}, Router};
use app::handlers;

fn main() {
    let app = Router::new()
        .route("/items", get(handlers::list).layer(Trace::new()).post(handlers::create).with_state(state))
        .route("/ping", get(|| async { pong() }))
        .nest("/api", Router::new().route("/health", axum::routing::any(handlers::health)));
}

fn pong() -> &'static str { "pong" }
`,
    });
    expect(entryList(r)).toEqual([
      { key: 'cli rust app::main', detail: {} },
      { key: 'http axum app::handlers::list', detail: { method: 'GET', path: '/items' } },
      { key: 'http axum app::handlers::create', detail: { method: 'POST', path: '/items' } },
      { key: 'http axum app::main::closure1', detail: { method: 'GET', path: '/ping' } },
      { key: 'http axum app::handlers::health', detail: { path: '/api/health' } },
    ]);
    const main = r.files.find((f) => f.path === 'src/main.rs')!;
    const closure = main.symbols.find((s) => s.name === 'closure1')!;
    expect(closure).toMatchObject({ kind: 'function', parentId: main.symbols.find((s) => s.kind === 'function' && s.name === 'main')!.id });
    const calls = main.rust!.calls.filter((c) => c.segments.at(-1) === 'pong');
    expect(calls.map((c) => c.callerId)).toEqual([closure.id]);
  });

  it('resolves handlers named by a use inside the function body', async () => {
    const r = await extract(['axum'], {
      'src/lib.rs': `pub mod handlers;
pub fn app() -> axum::Router {
    use crate::handlers::list;
    use axum::routing::get;
    axum::Router::new().route("/a", get(list))
}
`,
      'src/handlers.rs': HANDLERS,
    });
    expect(entryList(r)).toEqual([{ key: 'http axum app::handlers::list', detail: { method: 'GET', path: '/a' } }]);
  });

  it('keeps closure symbol ids when restoring from stored rows', async () => {
    const source = `use axum::{routing::get, Router};
fn main() {
    let f = |x: u8| x;
    Router::new().route("/a", get(|| async {})).route("/b", get(|| async {}));
}
`;
    const r = await extract(['axum'], { 'src/main.rs': source });
    const file = r.files[0]!;
    expect(file.symbols.filter((s) => s.name.startsWith('closure')).map((s) => s.qualifiedName)).toEqual(['app::main::closure2', 'app::main::closure3']);
    const rows = file.symbols.map(({ nameLine: _l, nameCol: _c, ...row }) => row);
    const restored = restoreRustFile(await getRustParser(), 'src/main.rs', source, rows, crates(['axum'], ['src/main.rs']));
    expect(restored.symbols.map((s) => s.id)).toEqual(file.symbols.map((s) => s.id));
    const cached = deserializeExtractedFile(serializeExtractedFile(file));
    expect(cached.rust?.routes).toEqual(file.rust?.routes);
  });

  it('recognizes actix-web attributes, resources and scope prefixes', async () => {
    const r = await extract(['actix-web'], {
      'src/main.rs': `use actix_web::{get, route, web, App, HttpServer};

#[get("/hello/{name}")]
async fn hello() {}

#[route("/multi", method = "POST", method = "PUT")]
async fn multi() {}

async fn list() {}
async fn create() {}
async fn any() {}

fn main() {
    HttpServer::new(|| {
        App::new()
            .service(hello)
            .route("/items", web::get().to(list))
            .service(web::scope("/api").service(web::resource("/things").route(web::post().to(create)).to(any)))
    });
}
`,
    });
    expect(entryList(r)).toEqual([
      { key: 'cli rust app::main', detail: {} },
      { key: 'http actix-web app::hello', detail: { method: 'GET', path: '/hello/{name}' } },
      { key: 'http actix-web app::multi', detail: { method: 'POST', path: '/multi' } },
      { key: 'http actix-web app::list', detail: { method: 'GET', path: '/items' } },
      { key: 'http actix-web app::create', detail: { method: 'POST', path: '/api/things' } },
      { key: 'http actix-web app::any', detail: { path: '/api/things' } },
    ]);
  });

  it('recognizes rocket attributes with mount prefixes across files', async () => {
    const r = await extract(['rocket'], {
      'src/lib.rs': 'pub mod api;\n',
      'src/api.rs': `use rocket::{get, post};

#[get("/items/<id>")]
pub fn item(id: u32) {}

#[post("/items", data = "<body>")]
pub fn add(body: String) {}

#[rocket::route(GET, uri = "/raw")]
pub fn raw() {}
`,
      'src/main.rs': `use app::api;

#[rocket::launch]
fn rocket() -> _ {
    rocket::build().mount("/api", rocket::routes![api::item, api::add]).mount("/v2", routes![api::item])
}
`,
    });
    expect(entryList(r)).toEqual([
      { key: 'http rocket app::api::item', detail: { method: 'GET', path: '/api/items/<id>' } },
      { key: 'http rocket app::api::item', detail: { method: 'GET', path: '/v2/items/<id>' } },
      { key: 'http rocket app::api::add', detail: { method: 'POST', path: '/api/items' } },
      { key: 'http rocket app::api::raw', detail: { method: 'GET', path: '/raw' } },
    ]);
  });

  it('tells actix-web and rocket attributes apart by the file use when both are dependencies', async () => {
    const r = await extract(['actix-web', 'rocket'], {
      'src/a.rs': 'use actix_web::get;\n#[get("/a")]\npub async fn a() {}\n',
      'src/b.rs': 'use rocket::get;\n#[get("/b")]\npub fn b() {}\n',
      'src/c.rs': '#[get("/c")]\npub fn c() {}\n',
      'src/lib.rs': 'mod a;\nmod b;\nmod c;\n',
    });
    expect(entryList(r)).toEqual([
      { key: 'http actix-web app::a::a', detail: { method: 'GET', path: '/a' } },
      { key: 'http rocket app::b::b', detail: { method: 'GET', path: '/b' } },
    ]);
  });

  it('ignores route-looking code when the package does not depend on the framework', async () => {
    const r = await extract([], {
      'src/lib.rs': '#[get("/x")]\npub fn x() {}\npub fn r() { Router::new().route("/y", get(x)); }\n',
    });
    expect(r.entries).toEqual([]);
  });

  it('writes clap derive and builder subcommands into the main entry', async () => {
    const r = await extract(['clap'], {
      'src/lib.rs': 'pub mod cli;\n',
      'src/cli.rs': `use clap::Subcommand;

#[derive(Subcommand)]
pub enum Commands {
    /// Adds a user.
    AddUser { name: String },
    #[command(name = "rm")]
    Remove,
}
`,
      'src/main.rs': `use clap::Command;

fn main() {
    let _ = Command::new("app").subcommand(Command::new("serve")).subcommands([Command::new("init")]);
}
`,
    });
    expect(entryList(r)).toEqual([{ key: 'cli rust app::main', detail: { subcommands: ['serve', 'init', 'add-user', 'rm'] } }]);
  });
});
