#!/bin/sh
# 不需要 Xcode：用命令行工具里的 swiftc 编译，打包成 .app 并做本地签名。
# 必须是 .app，系统才会按 Info.plist 里的说明弹出“运动与健身”权限请求。
set -e
cd "$(dirname "$0")"

APP=build/NodLinkBridge.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
swiftc -O -target "$(uname -m)-apple-macos14.0" Sources/*.swift -o "$APP/Contents/MacOS/NodLinkBridge"
# 本地签名默认用二进制的哈希当身份，每次编译都变，系统的权限（辅助功能、运动、麦克风）就跟着失效。
# 改用 Bundle ID 当身份：重新编译后权限还在。代价是任何同 ID 的本地程序都能沿用这些权限，只适合开发。
codesign --force --sign - --requirements '=designated => identifier "io.github.nodlink.bridge"' "$APP"
echo "已生成 $APP"
