# 数据源协议（耳机桥 ↔ Mac 中继 ↔ 调试台）

数据源（Mac 上的 [`mac/NodLinkBridge`](../mac/NodLinkBridge/README.md)）用 WebSocket 连接 `ws://<Mac 的局域网地址>:8787/ws?role=source`，每条消息是一个 JSON 文本帧。中继把数据源的消息原样转发给所有调试网页（`role=view`），也把网页的消息原样转发给所有数据源。中继启动时会打印 Mac 的局域网地址。

> 中继监听所有网卡，同一局域网内的任何设备都能连上。只在可信网络里使用。

## 消息类型

### `motion`：一帧头部姿态

```json
{ "type": "motion", "t": 1234.567, "yaw": 0.12, "pitch": -0.05, "roll": 0.01 }
```

| 字段 | 单位 | 说明 |
|---|---|---|
| `t` | 秒 | 设备时间戳，直接用 `CMDeviceMotion.timestamp`。网页用它计算设备端采样率 |
| `yaw` `pitch` `roll` | 弧度 | `CMDeviceMotion.attitude` 的三个欧拉角 |
| `q` | — | 可选，四元数 `[w, x, y, z]` |
| `rr` | 弧度/秒 | 可选，`rotationRate` 的 `[x, y, z]` |
| `acc` | g | 可选，`userAcceleration` 的 `[x, y, z]` |

可选字段网页目前不使用，但会原样记录进导出数据，供离线分析使用。

### `hello`：连接后发一次

```json
{ "type": "hello", "device": "Mac", "headphones": "AirPods Pro" }
```

### `event`：状态变化

```json
{ "type": "event", "name": "background", "t": 1250.0 }
```

建议的 `name`：`foreground`、`background`、`headphonesConnected`、`headphonesDisconnected`、`silentAudioOn`、`silentAudioOff`。可以和 `motion` 的时间戳对照，分析数据在什么时候中断。

### `displays`：显示器排列（耳机桥 → 网页）

连接后、收到网页的 `hello` 后、显示器布局变化时发送。坐标是 Quartz 全局坐标（单位：点，原点在主显示器左上角，y 向下），和 macOS 的“显示器”设置里的排列一致。

```json
{ "type": "displays", "displays": [
  { "id": 1, "name": "Built-in Retina Display", "x": 0, "y": 0, "w": 1440, "h": 900, "main": true },
  { "id": 2, "name": "External Display", "x": 0, "y": -1080, "w": 1920, "h": 1080, "main": false }
] }
```

### `control` / `cursorPos`：鼠标控制状态（耳机桥 → 网页）

```json
{ "type": "control", "enabled": true, "trusted": true, "owner": "k3f9a2xq" }
{ "type": "cursorPos", "x": 812.5, "y": 433.0 }
```

`trusted` 表示是否有“辅助功能”权限。`owner` 是正在控制鼠标的网页编号：每条网页指令都带着 `page`（网页打开时随机生成），同时开着几个网页时，耳机桥只执行 `owner` 发来的控制类指令（`cursor` `button` `key` `scroll` `zoom` `probe` `highlight` `cue` `voice` `window` `labels`），交还也只认它；别的网页发 `control` 打开就是接管。否则几个网页各算各的光标，光标会在它们之间来回跳。接管鼠标时每 50 ms 回报一次系统光标位置（全局坐标）。

### `headphones`：耳机状况（耳机桥 → 网页，每秒一次）

```json
{ "type": "headphones", "connected": true, "streaming": true, "rate": 50, "quiet": 0, "output": "AirPods", "silentAudio": false }
```

`quiet` 是连续多少秒没收到姿态；`output` 是当前的声音输出设备，不是 AirPods 时系统通常不给姿态。耳机连着却 5 秒没数据时，耳机桥自动重开一次读取（每 30 秒最多一次）。

### `input`：真实键鼠动了（耳机桥 → 网页）

```json
{ "type": "input", "kind": "mouse" }
```

`kind` 是 `mouse`（移动、点击、拖拽）、`scroll` 或 `key`。只在接管鼠标期间发送，同一类每 100 ms 最多一条。耳机桥自己发出的事件都带标记（`eventSourceUserData = 0x4E4F444C`），不算在内。网页收到后让头控让位，停手 `yieldMs` 后恢复。

### `voice`：语音指令（耳机桥 → 网页）

```json
{ "type": "voice", "phase": "start" }
{ "type": "voice", "phase": "command", "command": "left", "text": "左键" }
```

`phase`：`start` 开口（音量高出底噪 12 dB），`end` 说完（静音 0.7 秒），`command` 认出指令，`text` 识别中的文字，`state` 开始或停止听（带 `on` `mic` `onDevice`，出错时带 `error`）。
中文（zh-CN）和英文（en-US）两个识别器同时听。指令按词匹配（中文转成拼音，同音字也算），整句最多比指令多 3 个词；语法见 `mac/NodLinkBridge/Sources/VoiceGrammar.swift`。
`command` 的取值：`left` `double` `right` `scrollUp` `scrollDown` `zoomIn` `zoomOut` `hold` `release` `pause` `resume` `recenter` `selectFrom` `selectTo` `key`。
`key` 指令另带 `key`（键名：字母、数字、`space` `return` `delete` `tab` `escape` `up` `down` `left` `right` `pageup` `pagedown` `forwarddelete`，或修饰键 `cmd` `shift` `ctrl` `alt`）、`mods`（同时按的修饰键）、`hold`（按住不放）。

```json
{ "type": "voice", "phase": "command", "command": "key", "key": "delete", "mods": ["ctrl", "shift"], "text": "Ctrl Shift Delete" }
```

### `targets`：落点附近的可点元素（耳机桥 → 网页）

```json
{ "type": "targets", "at": {"x": 812, "y": 433}, "role": "AXWindow", "title": "访达",
  "container": {"x": 0, "y": 25, "w": 900, "h": 600}, "ms": 12.4, "visited": 310,
  "items": [ {"x": 20, "y": 60, "w": 24, "h": 24, "r": "Button"} ] }
```

收到 `probe` 后，用辅助功能接口读出落点所在的窗口（或菜单栏、程序坞）里所有可点元素（按钮、链接、输入框、菜单项、列表行……）的位置，全局坐标。落点还在上次读过的窗口里、且不到 1 秒时不重读。需要“辅助功能”权限。Electron、Chrome 这类 App 会被设置 `AXManualAccessibility`，让它们提供界面结构。

## 网页 → 耳机桥的指令

| 消息 | 作用 |
|---|---|
| `{ "type": "hello" }` | 网页连上后发送，耳机桥回报 `displays` 和 `control` |
| `{ "type": "overlay", "target": {"x":..,"y":..}, "label": "…", "progress": 0.4 }` | 在每块显示器上显示全屏叠加层，目标红点在全局坐标 `target` 处；`target` 可为 `null`。网页在校准和测试期间每 30 ms 左右发一次，耳机桥 3 秒收不到就自动关闭叠加层 |
| `{ "type": "overlay", "on": false }` | 关闭叠加层 |
| `{ "type": "control", "enabled": true, "yieldMs": 1500 }` | 接管 / 交还系统鼠标。打开时检查“辅助功能”权限，没有时系统会弹出提示；按 Esc 也会交还。`yieldMs`：真实键鼠最后一次活动后，这么久之内丢弃头控的移动和点击 |
| `{ "type": "cursor", "x": .., "y": .., "ts": .. }` | 把系统光标移到全局坐标（绝对、摇杆模式） |
| `{ "type": "cursor", "dx": .., "dy": .., "ts": .. }` | 在当前系统光标位置上移动（增量模式，和真实鼠标一样跨显示器） |
| `{ "type": "scroll", "dy": 300 }` | 滚动 `dy` 点，正数像手指上滑（内容往上走）。分 10 次在 200 ms 内发完 |
| `{ "type": "key", "key": "m", "mods": ["cmd"], "action": "press" }` | 按键。`action`：`press` 按一下，`down` 按住不放（修饰键按住后，之后的点击和按键都带着它，比如 Shift + 点击选中一段）；`{ "type": "key", "action": "releaseAll" }` 放开全部。按住的键在交还、断线、真实键鼠介入时立刻放开，最长 35 秒 |
| `{ "type": "zoom", "dir": "in" }` | 发 ⌘= 放大（`out` 发 ⌘- 缩小） |
| `{ "type": "voice", "enabled": true, "mic": "builtin" }` | 打开 / 关闭语音指令。`mic`：`builtin` 用 Mac 自带麦克风（AirPods 不切到通话模式），`default` 用系统默认输入。只在接管鼠标期间听 |
| `{ "type": "button", "button": "left", "action": "click", "count": 1, "x": .., "y": .., "mods": ["shift"] }` | 点击。`button`：`left` / `right`；`action`：`click` / `down` / `up`；`count` 2 表示双击的第二下；带 `x` `y` 时先移到那里再点（按着左键时是拖过去）；`mods` 是点击时同时按着的修饰键。需要“辅助功能”权限 |
| `{ "type": "motionRestart" }` | 重新开始读取耳机姿态 |
| `{ "type": "silentAudio", "on": true }` | 播放 / 停止一段听不到的静音，让系统保持头部追踪 |
| `{ "type": "openSettings", "pane": "sound" }` | 打开系统设置的声音输出（`sound`）或蓝牙（`bluetooth`）页面 |
| `{ "type": "probe", "x": .., "y": .., "fresh": false }` | 吸附：报告头部落点（全局坐标），约每 100 ms 一次。`fresh` 为真时强制重读（点击后界面变了） |
| `{ "type": "point", "x": .., "y": .. }` | 正在指向：在用耳机数据时约每 150 ms 报一次光标落点（全局坐标），不限于正在控制的网页（只读）。耳机桥回 `{ "type": "pointing", "x", "y", "app", "role", "label" }`：落点下面那个元素所在的 App 名、元素种类（去掉 AX 前缀，如 `Button`）和标题 / 描述（最多 40 字）。需要“辅助功能”权限 |
| `{ "type": "highlight", "x": .., "y": .., "w": .., "h": .. }` | 在真实屏幕上框出吸附到的元素；`{ "type": "highlight", "on": false }` 隐藏 |
| `{ "type": "window", "action": "close" \| "minimize" \| "fullscreen", "x": .., "y": .. }` | 按 (x, y) 下面那个窗口自己的关闭、最小化、全屏按钮（辅助功能接口）；那里没窗口就按最前面 App 的当前窗口；都找不到时改发 ⌘W、⌘M、⌃⌘F |
| `{ "type": "labels", "items": [{ "n": 1, "x": .., "y": .., "w": .., "h": .. }, …] }` | 在真实屏幕上给这些元素标数字牌（全局坐标）；`{ "type": "labels", "on": false }` 收起。标号亮着时耳机桥才把单说的数字认成指令 `{ "command": "label", "key": "3" }` |
| `{ "type": "cue", "name": "click" }` | 播放提示音：`click` `double` `right` `down` `up`，用系统音效，从当前输出设备（AirPods）出来 |

光标位置会限制在某块显示器内。

`ts` 是这一帧姿态的设备时间（`motion.t`，秒）。耳机数据是成批到的（每 20 ms 采一帧，约每 60 ms 到一批），耳机桥按 `ts` 把位置排开，以 120 Hz 插值播放；播放延迟取最近两秒到达延迟的 90 分位。不带 `ts` 的指令立即执行。

耳机桥自己守两条硬规则，不依赖网页：真实键鼠活动后 `yieldMs` 内丢弃 `cursor` 和 `button`；头控按下的左键在交还鼠标、断线、真实键鼠介入时立刻松开，最长按住 35 秒。

## 网页端的轴映射

网页默认把 `yaw` 当水平角并反转（实测 CoreMotion 的 yaw 向左为正），`pitch` 当垂直角。pitch 和 roll 的方向尚未实测，可以用“设置”里的“自动识别轴方向”确认。
