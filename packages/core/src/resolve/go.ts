import type { ResolveInput, ResolveResult, Resolver } from './types.js';

/**
 * Go 解析器的占位实现：不出边，边来源记为名称匹配（reason=disabled），不会触发重新解析。
 * scip-go 和名称匹配接入后替换
 */
export class GoResolver implements Resolver {
  readonly name = 'go';
  readonly version = 'none';

  async resolve(_input: ResolveInput): Promise<ResolveResult> {
    return { edges: [], sources: { go: { source: 'name_match', reason: 'disabled' } }, effectiveVersion: this.version };
  }
}
