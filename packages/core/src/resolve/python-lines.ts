/** 换行符的长度：`\n` 为 1，`\r\n` 为 2，不是换行为 0 */
function newlineAt(source: string, i: number): number {
  if (source[i] === '\n') return 1;
  return source[i] === '\r' && source[i + 1] === '\n' ? 2 : 0;
}

interface ScanState {
  depth: number;
  quote: string | undefined;
  /** 当前行以反斜杠续行（代码里或字符串里的反斜杠紧跟换行） */
  backslash: boolean;
}

/** 处理字符串内的一个字符，返回下一个要看的位置 */
function scanInString(source: string, i: number, st: ScanState): number {
  const quote = st.quote!;
  if (source[i] === '\\') {
    // 反斜杠后紧跟换行时换行照常处理（字符串跨行），否则跳过被转义的字符
    if (newlineAt(source, i + 1) > 0) {
      st.backslash = true;
      return i + 1;
    }
    return i + 2;
  }
  if (source.startsWith(quote, i)) {
    st.quote = undefined;
    return i + quote.length;
  }
  return i + 1;
}

/** 处理代码里的一个字符，返回下一个要看的位置 */
function scanInCode(source: string, i: number, st: ScanState): number {
  const c = source[i]!;
  if (c === '#') {
    const nl = source.indexOf('\n', i);
    return nl < 0 ? source.length : source[nl - 1] === '\r' ? nl - 1 : nl;
  }
  if (c === '\\' && newlineAt(source, i + 1) > 0) st.backslash = true;
  else if (c === '"' || c === "'") {
    st.quote = source.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
    return i + st.quote.length;
  } else if (c === '(' || c === '[' || c === '{') st.depth++;
  else if ((c === ')' || c === ']' || c === '}') && st.depth > 0) st.depth--;
  return i + 1;
}

/**
 * 按行标记 Python 逻辑行是否延续到下一行：行尾在括号或多行字符串内，或以反斜杠续行。
 * 简单扫描：跳过字符串（含三引号）和注释，只统计括号深度。支持 `\n` 和 `\r\n`。
 */
export function continuedLines(source: string): boolean[] {
  const out: boolean[] = [];
  const st: ScanState = { depth: 0, quote: undefined, backslash: false };
  let i = 0;
  while (i < source.length) {
    const nl = newlineAt(source, i);
    if (nl === 0) {
      i = st.quote ? scanInString(source, i, st) : scanInCode(source, i, st);
      continue;
    }
    out.push(st.quote !== undefined || st.depth > 0 || st.backslash);
    // 没有用反斜杠续行的单引号字符串到行尾结束
    if (st.quote?.length === 1 && !st.backslash) st.quote = undefined;
    st.backslash = false;
    i += nl;
  }
  out.push(false);
  return out;
}
