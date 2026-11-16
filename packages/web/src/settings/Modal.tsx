import type { ReactNode } from 'react';

/** 居中的弹窗：半透明背景加面板，内容由调用方给出 */
export function Modal({ label, testId, className, children }: { label: string; testId: string; className?: string; children: ReactNode }) {
  return (
    <div className="modal-backdrop">
      <div className={`panel modal${className ? ` ${className}` : ''}`} role="dialog" aria-label={label} data-testid={testId}>
        {children}
      </div>
    </div>
  );
}
