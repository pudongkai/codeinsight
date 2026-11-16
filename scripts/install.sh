#!/usr/bin/env bash
# 安装 CodeInsight 命令行：先编译，再在 PATH 目录里建 codeinsight 链接，指向本仓库的 packages/cli/dist/main.js。
# 链接指向仓库内的文件，之后 git pull 并重新运行 scripts/build.sh 即可更新，不用重新安装。
# 用法：scripts/install.sh [--prefix DIR] [--skip-build] [--force] [--uninstall]
#   --prefix DIR   安装到 DIR/codeinsight，默认 ~/.local/bin
#   --skip-build   不编译，直接建链接（已经编译过时使用）
#   --force        DIR/codeinsight 已存在且不是本脚本建的链接时也覆盖
#   --uninstall    删除本脚本建的 codeinsight 链接
# 其余参数（如 --test、--plugin）原样传给 scripts/build.sh。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$ROOT/packages/cli/dist/main.js"

PREFIX="$HOME/.local/bin"
SKIP_BUILD=0
FORCE=0
UNINSTALL=0
BUILD_ARGS=()

usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) [ $# -ge 2 ] || { echo "--prefix 需要一个目录" >&2; exit 2; }; PREFIX="$2"; shift ;;
    --prefix=*) PREFIX="${1#--prefix=}" ;;
    --skip-build) SKIP_BUILD=1 ;;
    --force) FORCE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) BUILD_ARGS+=("$1") ;;
  esac
  shift
done

TARGET="$PREFIX/codeinsight"

fail() { printf '错误：%s\n' "$*" >&2; exit 1; }

# TARGET 是指向本仓库入口的链接时返回 0
is_our_link() {
  [ -L "$TARGET" ] && [ "$(readlink "$TARGET")" = "$ENTRY" ]
}

uninstall() {
  if is_our_link; then
    rm "$TARGET"
    echo "已删除 $TARGET"
  elif [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
    fail "$TARGET 不是本仓库安装的链接，没有删除"
  else
    echo "$TARGET 不存在，不需要卸载"
  fi
}

link_entry() {
  [ -f "$ENTRY" ] || fail "没有找到 ${ENTRY}，请先编译（去掉 --skip-build 重新运行）"
  chmod +x "$ENTRY"
  mkdir -p "$PREFIX"
  if { [ -e "$TARGET" ] || [ -L "$TARGET" ]; } && ! is_our_link && [ "$FORCE" -eq 0 ]; then
    fail "$TARGET 已存在，且不是本仓库的链接；确认要覆盖时加 --force"
  fi
  ln -sfn "$ENTRY" "$TARGET"
  echo "已安装：$TARGET -> $ENTRY"
}

# 安装目录不在 PATH 里时提示怎么加
check_path() {
  case ":$PATH:" in
    *":$PREFIX:"*) ;;
    *)
      echo
      echo "注意：$PREFIX 不在 PATH 里。在 shell 配置（如 ~/.zshrc）里加一行后重开终端："
      echo "  export PATH=\"$PREFIX:\$PATH\""
      return
      ;;
  esac
  local found
  found="$(command -v codeinsight || true)"
  if [ -n "$found" ] && [ "$found" != "$TARGET" ]; then
    echo
    echo "注意：PATH 里先找到的是 ${found}，不是刚安装的 $TARGET"
  fi
}

main() {
  if [ "$UNINSTALL" -eq 1 ]; then
    uninstall
    return
  fi
  if [ "$SKIP_BUILD" -eq 0 ]; then
    "$ROOT/scripts/build.sh" ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}
  fi
  echo
  link_entry
  check_path
  echo
  echo "使用：在要分析的仓库目录里运行 codeinsight serve，按输出的地址打开网页"
  echo "JetBrains 插件会在 PATH 里找 codeinsight；插件包用 scripts/build.sh --plugin 生成，"
  echo "在 IDE 的“设置 → 插件 → ⚙ → 从磁盘安装插件”里选择 plugins/jetbrains/build/distributions/ 下的 zip"
}

main
