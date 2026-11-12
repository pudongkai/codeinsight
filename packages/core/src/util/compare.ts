/**
 * 按 UTF-16 码元比较字符串，不受系统语言环境影响。
 * 进入 LLM 输入、缓存 key 或报告输出顺序的排序都用它，保证不同机器上结果相同。
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
