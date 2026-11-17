import { describe, expect, it } from 'vitest';
import { deserializeExtractedFile, serializeExtractedFile } from '../src/extract/cache.js';
import { extractFiles, extractGoFile, getGoParser } from '../src/index.js';
import type { ExtractResult } from '../src/index.js';

const MODULES = new Map([['', 'example.com/app']]);

async function extract(files: Record<string, string>): Promise<ExtractResult> {
  const sources = Object.entries(files).map(([path, source]) => ({ path, source, language: 'go' as const, isTest: false, isGenerated: false }));
  return extractFiles(sources, { goModules: MODULES });
}

/** 入口列表转成 `kind framework qualifiedName` 和 detail，便于比较 */
function entryList(r: ExtractResult): { key: string; detail: Record<string, unknown> }[] {
  const byId = new Map(r.files.flatMap((f) => f.symbols).map((s) => [s.id, s]));
  return r.entries.map((e) => ({ key: `${e.kind} ${e.framework} ${byId.get(e.symbolId)?.qualifiedName}`, detail: e.detail }));
}

const HANDLERS = `package handler

import "net/http"

type Handler struct{}

func NewHandler() *Handler { return &Handler{} }

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {}
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {}

func Health(w http.ResponseWriter, r *http.Request) {}
`;

describe('go entry recognition', () => {
  it('recognizes func main in package main only', async () => {
    const r = await extract({
      'cmd/a/main.go': 'package main\n\nfunc main() {}\n',
      'lib/lib.go': 'package lib\n\nfunc main() {}\n',
    });
    expect(entryList(r)).toEqual([{ key: 'cli go example.com/app/cmd/a.main', detail: {} }]);
  });

  it('recognizes net/http routes with function names, pkg.Func, method values and method patterns', async () => {
    const r = await extract({
      'handler/h.go': HANDLERS,
      'server/routes.go': `package server

import (
\t"net/http"

\t"example.com/app/handler"
)

func index(w http.ResponseWriter, r *http.Request) {}

func Routes(mux *http.ServeMux) {
\th := handler.NewHandler()
\thttp.HandleFunc("/", index)
\tmux.HandleFunc("/health", handler.Health)
\tmux.HandleFunc("POST /items", h.Create)
\tmux.Handle("/list", http.HandlerFunc(h.List))
\tmux.HandleFunc("/missing", undefinedFunc)
}
`,
    });
    expect(entryList(r)).toEqual([
      { key: 'http net/http example.com/app/server.index', detail: { path: '/' } },
      { key: 'http net/http example.com/app/handler.Health', detail: { path: '/health' } },
      { key: 'http net/http example.com/app/handler.Handler.Create', detail: { method: 'POST', path: '/items' } },
      { key: 'http net/http example.com/app/handler.Handler.List', detail: { path: '/list' } },
    ]);
  });

  it('builds funcN symbols for function literal handlers and attributes their calls to them', async () => {
    const source = `package main

import "net/http"

func work() {}

func main() {
\tdefer func() {}()
\thttp.HandleFunc("/a", func(w http.ResponseWriter, r *http.Request) {
\t\twork()
\t\thttp.HandleFunc("/nested", func(w http.ResponseWriter, r *http.Request) {})
\t})
}
`;
    const r = await extract({ 'main.go': source });
    const file = r.files[0]!;
    const main = file.symbols.find((s) => s.qualifiedName === 'example.com/app.main')!;
    const lit = file.symbols.find((s) => s.qualifiedName === 'example.com/app.main.func2')!;
    expect(lit).toMatchObject({ kind: 'function', name: 'func2', parentId: main.id, startLine: 9, endLine: 12 });
    expect(lit.displaySignature).toBe('func(w http.ResponseWriter, r *http.Request)');
    const nested = file.symbols.find((s) => s.qualifiedName === 'example.com/app.main.func2.1')!;
    expect(nested).toMatchObject({ name: 'func2.1', parentId: lit.id });
    expect(file.go!.calls.find((c) => c.name === 'work')!.callerId).toBe(lit.id);
    expect(entryList(r).map((e) => e.key)).toEqual([
      'cli go example.com/app.main',
      'http net/http example.com/app.main.func2',
      'http net/http example.com/app.main.func2.1',
    ]);
    // 同样的源码再提取一次，符号 id 相同（还原时按 id 对应）
    const again = extractGoFile(await getGoParser(), 'main.go', source, { isTest: false, isGenerated: false }, MODULES);
    expect(again.symbols.map((s) => s.id)).toEqual(file.symbols.map((s) => s.id));
  });

  it('recognizes gin routes with the last argument as handler and group prefixes', async () => {
    const r = await extract({
      'handler/h.go': HANDLERS,
      'server/gin.go': `package server

import (
\t"github.com/gin-gonic/gin"

\t"example.com/app/handler"
)

func ping(c *gin.Context) {}

func Setup(r *gin.Engine, h *handler.Handler) {
\tr.GET("/ping", ping)
\tapi := r.Group("/api")
\tv1 := api.Group("/v1")
\tv1.POST("/items", auth(), h.Create)
\tr.Group("/admin").DELETE("/x", ping)
}

func auth() gin.HandlerFunc { return nil }
`,
    });
    expect(entryList(r)).toEqual([
      { key: 'http gin example.com/app/server.ping', detail: { method: 'GET', path: '/ping' } },
      { key: 'http gin example.com/app/handler.Handler.Create', detail: { method: 'POST', path: '/api/v1/items' } },
      { key: 'http gin example.com/app/server.ping', detail: { method: 'DELETE', path: '/admin/x' } },
    ]);
  });

  it('recognizes echo routes with the second argument as handler and group prefixes', async () => {
    const r = await extract({
      'server/echo.go': `package server

import "github.com/labstack/echo/v4"

func list(c echo.Context) error { return nil }

func Setup(e *echo.Echo) {
\tg := e.Group("/users")
\tg.GET("", list, mw)
\te.PUT("/x", func(c echo.Context) error { return nil })
}
`,
    });
    expect(entryList(r)).toEqual([
      { key: 'http echo example.com/app/server.list', detail: { method: 'GET', path: '/users' } },
      { key: 'http echo example.com/app/server.Setup.func1', detail: { method: 'PUT', path: '/x' } },
    ]);
  });

  it('recognizes chi routes and Route prefixes, restoring the prefix after the Route callback', async () => {
    const r = await extract({
      'server/chi.go': `package server

import (
\t"net/http"

\t"github.com/go-chi/chi/v5"
)

func get(w http.ResponseWriter, r *http.Request) {}

func Router() http.Handler {
\tr := chi.NewRouter()
\tr.Route("/api", func(r chi.Router) {
\t\tr.Get("/items", get)
\t\tr.Route("/v1", func(r chi.Router) {
\t\t\tr.Post("/x", get)
\t\t})
\t})
\tr.HandleFunc("/root", get)
\treturn r
}
`,
    });
    expect(entryList(r)).toEqual([
      { key: 'http chi example.com/app/server.get', detail: { method: 'GET', path: '/api/items' } },
      { key: 'http chi example.com/app/server.get', detail: { method: 'POST', path: '/api/v1/x' } },
      { key: 'http chi example.com/app/server.get', detail: { path: '/root' } },
    ]);
  });

  it('recognizes cobra commands with Run/RunE, including package-level literals', async () => {
    const r = await extract({
      'cmd/root.go': `package cmd

import "github.com/spf13/cobra"

var rootCmd = &cobra.Command{
\tUse: "app",
\tRun: func(cmd *cobra.Command, args []string) {},
}

func runServe(cmd *cobra.Command, args []string) error { return nil }

func newServe() *cobra.Command {
\treturn &cobra.Command{Use: "serve [flags]", RunE: runServe}
}
`,
    });
    expect(entryList(r)).toEqual([
      { key: 'cli cobra example.com/app/cmd.runServe', detail: { use: 'serve [flags]' } },
      { key: 'cli cobra example.com/app/cmd.glob..func1', detail: { use: 'app' } },
    ]);
  });

  it('keeps routes and cobra commands through the extract cache', async () => {
    const r = await extract({ 'main.go': 'package main\n\nimport "net/http"\n\nfunc h(w http.ResponseWriter, r *http.Request) {}\n\nfunc main() { http.HandleFunc("/", h) }\n' });
    const back = deserializeExtractedFile(serializeExtractedFile(r.files[0]!));
    expect(back.go!.routes).toEqual([{ framework: 'net/http', path: '/', handler: { form: 'ident', name: 'h' } }]);
    expect(back.go!.cobraCommands).toEqual([]);
  });
});
