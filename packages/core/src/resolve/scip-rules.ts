import type { ScipOccurrence } from '../scip/reader.js';
import { continuedLines } from './python-lines.js';

/** SCIP 定义/引用转边时和语言有关的规则 */
export interface ScipLanguageRules {
  /** 每一行的逻辑行是否延续到下一行（判断调用时跨行查找 `(`） */
  continuedLines(source: string): boolean[];
  /** 引用后面剩下的文字是注释或续行符，不能据此判断是不是调用，要看下一行 */
  skipsRest(rest: string): boolean;
  /** 模块级定义：对应文件的 module 符号，没有 enclosing_range */
  isModuleDefinition(occ: ScipOccurrence): boolean;
}

export const pythonRules: ScipLanguageRules = {
  continuedLines,
  skipsRest: (rest) => rest[0] === '#' || rest === '\\',
  isModuleDefinition: (occ) => occ.symbol.endsWith('/__init__:') && occ.range.startLine === 0 && occ.range.startChar === 0,
};
