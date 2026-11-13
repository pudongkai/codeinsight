import { CONFIG_FILE } from '../config/index.js';
import { pathKey } from './proposal-drafts.js';

/**
 * 文件名（任意目录下，按规范化后的小写比较）：会改变本工具或 git 的行为，或会被构建、包管理、CI、
 * 编辑器等工具链自动执行的文件。卡片上特别标出，提醒用户执行前细看
 */
export const SENSITIVE_FILES: ReadonlySet<string> = new Set([
  CONFIG_FILE, '.gitignore', '.gitattributes', '.gitmodules',
  '.envrc', '.gitlab-ci.yml', '.travis.yml', 'jenkinsfile', 'azure-pipelines.yml', 'bitbucket-pipelines.yml',
  '.pre-commit-config.yaml', '.pre-commit-hooks.yaml', 'lefthook.yml', '.lefthook.yml',
  'package.json', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs',
  'makefile', 'gnumakefile', 'justfile',
  'pyproject.toml', 'setup.py', 'setup.cfg', 'tox.ini', 'noxfile.py', 'conftest.py',
  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradlew', 'pom.xml', 'mvnw', 'build.rs',
].map((n) => n.toLowerCase()));

/** 目录（任意深度，按规范化后的路径比较）：下面的文件都标出，如 CI 流水线、Claude Code 的设置和钩子 */
export const SENSITIVE_DIRS: readonly string[] = ['.github/workflows', '.github/actions', '.circleci', '.buildkite', '.claude', '.devcontainer'];

/** 目录下的特定文件：编辑器会自动执行或据此执行命令 */
export const SENSITIVE_DIR_FILES: readonly string[] = ['.vscode/tasks.json', '.vscode/settings.json', '.vscode/launch.json'];

/** 规范化后的路径 p 里是否有 segs 这一串完整的路径段；atEnd 为 true 时必须在末尾 */
function hasSegments(p: string, segs: string, atEnd: boolean): boolean {
  const wrapped = `/${p}/`;
  return atEnd ? wrapped.endsWith(`/${segs}/`) : wrapped.includes(`/${segs}/`);
}

/** 写入路径是否需要在卡片上特别标出 */
export function isSensitivePath(rel: string): boolean {
  const p = pathKey(rel);
  if (SENSITIVE_FILES.has(p.slice(p.lastIndexOf('/') + 1))) return true;
  return SENSITIVE_DIRS.some((d) => hasSegments(p, d, false)) || SENSITIVE_DIR_FILES.some((f) => hasSegments(p, f, true));
}
