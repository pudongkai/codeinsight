#!/usr/bin/env bash
# 编译 CodeInsight：检查 Node / pnpm，安装依赖，构建全部包（core、server、web、cli）。
# 用法：scripts/build.sh [--test] [--plugin] [--skip-install]
#   --test          构建后运行 lint 和单元测试
#   --plugin        另外构建 JetBrains 插件（需要 JDK 21），产物在 plugins/jetbrains/build/distributions/
#   --skip-install  跳过 pnpm install（依赖已装好时加快速度）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQUIRED_NODE="22.13.0"

RUN_TESTS=0
BUILD_PLUGIN=0
SKIP_INSTALL=0

usage() { sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --test) RUN_TESTS=1 ;;
    --plugin) BUILD_PLUGIN=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$arg" >&2; usage >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }

# 版本号 a >= b 时返回 0
version_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

check_node() {
  command -v node >/dev/null 2>&1 || fail "没有找到 node，请先安装 Node.js ${REQUIRED_NODE} 或更高版本"
  local v
  v="$(node -p 'process.versions.node')"
  version_ge "$v" "$REQUIRED_NODE" || fail "Node.js 版本是 ${v}，需要 ${REQUIRED_NODE} 或更高（项目用到 node:sqlite）"
  echo "Node.js $v"
}

# 没有 pnpm 时用 Node 自带的 corepack 按 package.json 里的 packageManager 版本启用
check_pnpm() {
  if ! command -v pnpm >/dev/null 2>&1; then
    command -v corepack >/dev/null 2>&1 || fail "没有找到 pnpm，也没有 corepack；请先安装 pnpm（npm install -g pnpm）"
    echo "没有找到 pnpm，用 corepack 启用"
    corepack enable pnpm || fail "corepack 启用 pnpm 失败；请手动安装 pnpm（npm install -g pnpm）"
  fi
  echo "pnpm $(pnpm -v)"
}

# 某个 java 可执行文件的主版本号，运行不了时输出空
java_major() {
  "$1" -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -n1
}

# 可能装有 JDK 21 的目录：macOS java_home 登记的、Homebrew 的、Linux 常见路径
jdk21_candidates() {
  if [ -x /usr/libexec/java_home ]; then /usr/libexec/java_home -v 21 2>/dev/null || true; fi
  local d
  for d in /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
           /usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
           /usr/lib/jvm/java-21-openjdk* /usr/lib/jvm/temurin-21*; do
    [ -d "$d" ] && echo "$d"
  done
  return 0
}

# 当前 JDK（JAVA_HOME 优先）低于 21 时，从常见位置找一个 21 或更高版本的 JDK
ensure_jdk21() {
  local current="java" major home
  [ -n "${JAVA_HOME:-}" ] && current="$JAVA_HOME/bin/java"
  major="$(java_major "$current" || true)"
  if [ -n "$major" ] && [ "$major" -ge 21 ]; then
    echo "JDK $major"
    return
  fi
  while IFS= read -r home; do
    local m
    m="$(java_major "$home/bin/java" || true)"
    if [ -n "$m" ] && [ "$m" -ge 21 ]; then
      JAVA_HOME="$home"
      export JAVA_HOME
      echo "当前 JDK 是 ${major:-未安装}，改用 JDK ${m}：${JAVA_HOME}"
      return
    fi
  done < <(jdk21_candidates)
  fail "构建插件需要 JDK 21，当前是 ${major:-未安装}；安装 JDK 21 后设置 JAVA_HOME 再运行"
}

build_plugin() {
  step "构建 JetBrains 插件"
  ensure_jdk21
  (cd "$ROOT/plugins/jetbrains" && ./gradlew --quiet buildPlugin)
  echo "插件包："
  ls -1 "$ROOT"/plugins/jetbrains/build/distributions/*.zip
}

main() {
  cd "$ROOT"
  step "检查环境"
  check_node
  check_pnpm

  if [ "$SKIP_INSTALL" -eq 0 ]; then
    step "安装依赖"
    pnpm install --frozen-lockfile
  fi

  step "构建"
  pnpm -r build

  if [ "$RUN_TESTS" -eq 1 ]; then
    step "lint 和单元测试"
    pnpm lint
    pnpm -r test
  fi

  [ "$BUILD_PLUGIN" -eq 1 ] && build_plugin

  step "完成"
  echo "命令行入口：$ROOT/packages/cli/dist/main.js"
}

main
