#!/bin/sh
# 启动 NodLinkBridge，日志输出到当前终端。按 Ctrl+C 结束。
# 参数原样传给程序，例如：./run.sh --silent-audio
cd "$(dirname "$0")"
[ -d build/NodLinkBridge.app ] || ./build.sh

# 通过 open 启动，系统才会把它当作独立的 App 来申请权限。
# 日志总是追加到 bridge.log（关掉终端也不丢），在终端里运行时同时显示出来
LOG="$PWD/bridge.log"
echo "==== $(date '+%F %T') 启动 ====" >> "$LOG"
TAIL=""
if [ -t 1 ]; then tail -n 0 -f "$LOG" & TAIL=$!; else echo "日志写入 $LOG"; fi

trap 'pkill -x NodLinkBridge; [ -n "$TAIL" ] && kill $TAIL; exit 0' INT TERM HUP
open -n -W --stdout "$LOG" --stderr "$LOG" build/NodLinkBridge.app --args "$@"
[ -n "$TAIL" ] && kill $TAIL
