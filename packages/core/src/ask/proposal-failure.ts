import { GitError } from '../git/index.js';
import { gitFailureReason } from '../git/write.js';
import { ProposalError } from '../util/failure.js';
import { PathNotAllowedError } from '../util/paths.js';
import { AskToolFailure } from './tool-args.js';
import { WriteNotAllowedError } from './write-scope.js';

export interface FailureInfo {
  code: string;
  message: string;
}

/**
 * 保存、执行、查看 diff 共用：已知的异常转成失败码和原因（不含绝对路径）。git 失败按取消或 git_failed 记，
 * 原因前加上 step（哪一步）。未知异常返回 undefined，由调用方记日志并按各自的说法处理
 */
export function knownFailure(err: unknown, step = 'git'): FailureInfo | undefined {
  if (err instanceof ProposalError || err instanceof AskToolFailure) return { code: err.code, message: err.message };
  if (err instanceof WriteNotAllowedError) return { code: err.code, message: err.reason };
  if (err instanceof PathNotAllowedError) return { code: 'write_not_allowed', message: 'a directory on the path leads outside the root' };
  if (err instanceof GitError) {
    return { code: err.detail.stopped === 'aborted' ? 'cancelled' : 'git_failed', message: `${step} failed: ${gitFailureReason(err)}` };
  }
  return undefined;
}
