/** 生成或执行待确认修改时的已知失败：code 和给用户看的原因（不含绝对路径和凭据）一起记进结果 */
export class ProposalError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
