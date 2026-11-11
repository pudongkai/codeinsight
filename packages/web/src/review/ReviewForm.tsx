import { useState, type FormEvent } from 'react';
import type { ReviewParams } from '../api/types';

interface Props {
  llmConfigured: boolean;
  busy: boolean;
  onSubmit(params: ReviewParams): void;
}

function buildParams(mode: 'working' | 'range', base: string, head: string, intent: string, noLlm: boolean): ReviewParams {
  const p: ReviewParams = mode === 'working' ? { working: true } : { head: head.trim() || 'HEAD' };
  if (base.trim()) p.base = base.trim();
  if (intent.trim()) p.intent = intent.trim();
  if (noLlm) p.noLlm = true;
  return p;
}

/** 发起审查：工作区未提交改动，或提交区间（base 不填时为 head~1） */
export function ReviewForm({ llmConfigured, busy, onSubmit }: Props) {
  const [mode, setMode] = useState<'working' | 'range'>('working');
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [intent, setIntent] = useState('');
  const [noLlm, setNoLlm] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(buildParams(mode, base, head, intent, noLlm));
  };
  return (
    <form className="panel review-form" onSubmit={submit} data-testid="review-form">
      <h3>发起审查</h3>
      <label><input type="radio" name="mode" checked={mode === 'working'} onChange={() => setMode('working')} data-testid="mode-working" /> 工作区未提交改动</label>
      <label><input type="radio" name="mode" checked={mode === 'range'} onChange={() => setMode('range')} data-testid="mode-range" /> 提交区间</label>
      <div className="row">
        <label>base <input value={base} onChange={(e) => setBase(e.target.value)} placeholder={mode === 'working' ? 'HEAD' : '<head>~1'} data-testid="review-base" /></label>
        {mode === 'range' && <label>head <input value={head} onChange={(e) => setHead(e.target.value)} placeholder="HEAD" data-testid="review-head" /></label>}
      </div>
      <label className="block">
        意图（可选，不填时提交区间用提交说明）
        <textarea value={intent} onChange={(e) => setIntent(e.target.value)} rows={3} data-testid="review-intent" />
      </label>
      {llmConfigured && <label><input type="checkbox" checked={noLlm} onChange={(e) => setNoLlm(e.target.checked)} /> 不调用 LLM（跳过意图检查）</label>}
      {!llmConfigured && <p className="muted">未配置 LLM，不做意图检查。</p>}
      <button type="submit" disabled={busy} data-testid="review-submit">{busy ? '审查中…' : '开始审查'}</button>
    </form>
  );
}
