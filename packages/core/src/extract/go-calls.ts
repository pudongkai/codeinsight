import type { Node } from 'web-tree-sitter';
import {
  declareParams, exprChain, isImportName, recordDeclaration, resolveChain,
  type GoTypeContext, type GoTypeLookup, type GoVarTypes,
} from './go-types.js';
import { goSelectorParts } from './go-syntax.js';
import type { GoCallSite, GoFuncRef } from './types.js';

/** 内置函数的调用不记为调用点 */
const BUILTIN_FUNCS = new Set([
  'append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make', 'max', 'min', 'new',
  'panic', 'print', 'println', 'real', 'recover',
]);

/** 遍历时的附加处理（路由收集等）：进入节点时调用，返回的函数在子节点处理完后调用；离开时变量声明已记下 */
export interface CallVisitor {
  enter(node: Node, c: CallCollector): (() => void) | undefined;
  leave(node: Node, c: CallCollector): void;
}

/** 一个函数（或包级变量初始化）里收集调用点的状态 */
export interface CallCollector {
  ctx: GoTypeContext;
  /** 本文件内能查到的类型信息；查不到的留给跨文件处理 */
  lookup: GoTypeLookup;
  callerId: string;
  vars: GoVarTypes;
  out: GoCallSite[];
  visitor?: CallVisitor;
}

function selectorRef(operand: Node, name: string, c: CallCollector): GoFuncRef {
  if (operand.type === 'identifier' && isImportName(operand.text, c.ctx, c.vars)) {
    return { form: 'pkg', name, qualifier: c.ctx.imports[operand.text] };
  }
  const chain = exprChain(operand, c.ctx, c.vars);
  const receiverType = chain ? resolveChain(chain, c.lookup) : undefined;
  if (receiverType) return { form: 'selector', name, receiverType };
  return { form: 'selector', name, ...(chain ? { receiverChain: chain } : {}) };
}

/** 按名字引用的函数：`foo`、`pkg.Foo`、`x.Foo`；内置函数、函数类型的局部变量、其他写法为 undefined */
export function funcRef(fn: Node | null | undefined, c: CallCollector): GoFuncRef | undefined {
  if (fn?.type === 'identifier') return BUILTIN_FUNCS.has(fn.text) || c.vars.has(fn.text) ? undefined : { form: 'ident', name: fn.text };
  const sel = goSelectorParts(fn);
  return sel ? selectorRef(sel.operand, sel.field, c) : undefined;
}

/** 一个 call_expression 对应的调用点；内置函数、函数类型的局部变量、其他写法（如 `f()()`）为 undefined */
function callSite(call: Node, c: CallCollector): GoCallSite | undefined {
  const fn = call.childForFieldName('function');
  const ref = funcRef(fn, c);
  const nameNode = fn?.type === 'selector_expression' ? fn.childForFieldName('field') : fn;
  if (!ref || !nameNode) return undefined;
  return { callerId: c.callerId, line: nameNode.startPosition.row, col: nameNode.startPosition.column, ...ref };
}

/**
 * 按代码顺序遍历，收集调用点，同时记下变量声明的类型（先收集右边的调用，再记左边的变量）。
 * 函数字面量的参数也记进同一张变量表，里面的调用记到外层函数上（建了符号的处理函数字面量由 visitor 改记到它自己）
 */
export function collectCalls(node: Node, c: CallCollector): void {
  if (node.type === 'func_literal') declareParams(node.childForFieldName('parameters'), c.ctx, c.vars);
  if (node.type === 'call_expression') {
    const site = callSite(node, c);
    if (site) c.out.push(site);
  }
  const restore = c.visitor?.enter(node, c);
  for (const child of node.namedChildren) collectCalls(child, c);
  restore?.();
  recordDeclaration(node, c.ctx, c.vars);
  c.visitor?.leave(node, c);
}
