import type { Node } from 'web-tree-sitter';
import {
  declareParams, exprChain, isImportName, recordDeclaration, resolveChain,
  type GoTypeContext, type GoTypeLookup, type GoVarTypes,
} from './go-types.js';
import type { GoCallSite } from './types.js';

/** 内置函数的调用不记为调用点 */
const BUILTIN_FUNCS = new Set([
  'append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make', 'max', 'min', 'new',
  'panic', 'print', 'println', 'real', 'recover',
]);

/** 一个函数（或包级变量初始化）里收集调用点的状态 */
export interface CallCollector {
  ctx: GoTypeContext;
  /** 本文件内能查到的类型信息；查不到的留给跨文件处理 */
  lookup: GoTypeLookup;
  callerId: string;
  vars: GoVarTypes;
  out: GoCallSite[];
}

function selectorCall(fn: Node, c: CallCollector, base: Pick<GoCallSite, 'callerId' | 'line' | 'col' | 'name'>): GoCallSite {
  const operand = fn.childForFieldName('operand');
  if (operand?.type === 'identifier' && isImportName(operand.text, c.ctx, c.vars)) {
    return { ...base, form: 'pkg', qualifier: c.ctx.imports[operand.text] };
  }
  const chain = exprChain(operand, c.ctx, c.vars);
  const receiverType = chain ? resolveChain(chain, c.lookup) : undefined;
  if (receiverType) return { ...base, form: 'selector', receiverType };
  return { ...base, form: 'selector', ...(chain ? { receiverChain: chain } : {}) };
}

/** 一个 call_expression 对应的调用点；内置函数、函数类型的局部变量、其他写法（如 `f()()`）为 undefined */
function callSite(call: Node, c: CallCollector): GoCallSite | undefined {
  const fn = call.childForFieldName('function');
  const nameNode = fn?.type === 'identifier' ? fn : fn?.type === 'selector_expression' ? fn.childForFieldName('field') : null;
  if (!fn || !nameNode) return undefined;
  const base = { callerId: c.callerId, line: nameNode.startPosition.row, col: nameNode.startPosition.column, name: nameNode.text };
  if (fn.type === 'selector_expression') return selectorCall(fn, c, base);
  if (BUILTIN_FUNCS.has(fn.text) || c.vars.has(fn.text)) return undefined;
  return { ...base, form: 'ident' };
}

/**
 * 按代码顺序遍历，收集调用点，同时记下变量声明的类型（先收集右边的调用，再记左边的变量）。
 * 函数字面量的参数也记进同一张变量表，里面的调用记到外层函数上
 */
export function collectCalls(node: Node, c: CallCollector): void {
  if (node.type === 'func_literal') declareParams(node.childForFieldName('parameters'), c.ctx, c.vars);
  if (node.type === 'call_expression') {
    const site = callSite(node, c);
    if (site) c.out.push(site);
  }
  for (const child of node.namedChildren) collectCalls(child, c);
  recordDeclaration(node, c.ctx, c.vars);
}
