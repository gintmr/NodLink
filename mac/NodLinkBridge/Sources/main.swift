// NodLinkBridge：Mac 上的耳机桥。
// 输入：读取 AirPods 的头部姿态（CMHeadphoneMotionManager），按 docs/protocol.md 发给本机中继。
// 输出：执行调试台发来的指令——在每块显示器上显示全屏校准叠加层、移动系统鼠标、点击、播放提示音。
// 防误触和手势判断都在调试台（web/public/core/control.js）；这里只守两条硬规则：
// 真实键鼠一动，头控发来的移动和点击一律丢弃；任何情况下都不让左键卡在按下状态。
// 校准和光标算法都在调试台里，这里只做输入输出，保证算法只有一份。
//
// 用法：./run.sh [--url ws://localhost:8787/ws?role=source] [--silent-audio]

import AppKit
import AVFoundation
import CoreAudio
import CoreMotion
import Foundation
import IOKit.hidsystem
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

func log(_ text: String) {
    let time = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
    print("[\(time)] \(text)")
}

struct Options {
    var url = URL(string: "ws://localhost:8787/ws?role=source")!
    var silentAudio = false

    init(_ args: [String]) {
        var i = 1
        while i < args.count {
            switch args[i] {
            case "--url" where i + 1 < args.count:
                if let u = URL(string: args[i + 1]) { url = u }
                i += 1
            case "--silent-audio":
                silentAudio = true
            case "--lm-weight" where i + 1 < args.count:
                i += 1 // 在 main 里读
            case "--no-lm", "--old-post", "--voice-record":
                break
            default:
                log("忽略未知参数：\(args[i])")
            }
            i += 1
        }
    }
}

// MARK: - 静音音频

/// 循环播放一段全零的音频。macOS 上没有 AVAudioSession，直接用 AVAudioEngine。
final class SilentAudio {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()

    private(set) var playing = false

    func start() {
        guard !playing else { return }
        let format = engine.mainMixerNode.outputFormat(forBus: 0)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(format.sampleRate)) else { return }
        buffer.frameLength = buffer.frameCapacity // 缓冲区默认全零
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        do {
            try engine.start()
            player.scheduleBuffer(buffer, at: nil, options: .loops)
            player.play()
            playing = true
            log("静音音频：已开始播放")
        } catch {
            log("静音音频启动失败：\(error.localizedDescription)")
        }
    }

    func stop() {
        guard playing else { return }
        player.stop()
        engine.stop()
        playing = false
        log("静音音频：已停止")
    }
}

/// 当前的声音输出设备名。AirPods 不是声音输出时，系统通常不给头部姿态
func defaultOutputName() -> String? {
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id) == noErr else { return nil }
    var name: CFString = "" as CFString
    var ns = UInt32(MemoryLayout<CFString>.size)
    var na = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    let ok = withUnsafeMutablePointer(to: &name) { AudioObjectGetPropertyData(id, &na, 0, nil, &ns, $0) }
    return ok == noErr ? name as String : nil
}

// MARK: - 显示器

/// 一块显示器。坐标是 Quartz 全局坐标（单位：点，原点在主显示器左上角，y 向下），和 CGEvent 一致。
struct Display {
    let id: CGDirectDisplayID
    let name: String
    let bounds: CGRect
    let isMain: Bool

    static func all() -> [Display] {
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetActiveDisplayList(count, &ids, &count)
        return ids.map { id in
            let screen = NSScreen.screens.first { screenID($0) == id }
            return Display(id: id, name: screen?.localizedName ?? "显示器 \(id)", bounds: CGDisplayBounds(id), isMain: CGDisplayIsMain(id) != 0)
        }
    }

    static func screenID(_ screen: NSScreen) -> CGDirectDisplayID? {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
    }

    var json: [String: Any] {
        ["id": id, "name": name, "x": bounds.minX, "y": bounds.minY, "w": bounds.width, "h": bounds.height, "main": isMain]
    }
}

/// 把点限制在某块显示器内：已在某块显示器上就不动，否则移到最近的显示器边缘
func clampToDisplays(_ p: CGPoint, _ displays: [Display]) -> CGPoint {
    if displays.contains(where: { $0.bounds.contains(p) }) || displays.isEmpty { return p }
    var best = p
    var bestDist = CGFloat.infinity
    for d in displays {
        let b = d.bounds
        let q = CGPoint(x: min(max(p.x, b.minX), b.maxX - 1), y: min(max(p.y, b.minY), b.maxY - 1))
        let dist = hypot(q.x - p.x, q.y - p.y)
        if dist < bestDist { bestDist = dist; best = q }
    }
    return best
}

// MARK: - 全屏叠加层

/// 校准时盖在每块显示器上的半透明层：目标红点、提示文字和进度条。不接收鼠标事件。
final class OverlayView: NSView {
    var origin = CGPoint.zero      // 这块显示器在全局坐标里的左上角
    var target: CGPoint?           // 全局坐标
    var label = ""
    var progress: Double?
    var showsLabel = false
    var targetChangedAt = Date()

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        NSColor(white: 0, alpha: 0.62).setFill()
        bounds.fill()

        if showsLabel, let progress {
            let track = NSRect(x: 0, y: 0, width: bounds.width, height: 5)
            NSColor(white: 1, alpha: 0.15).setFill()
            track.fill()
            NSColor(red: 1, green: 0.22, blue: 0.37, alpha: 1).setFill()
            NSRect(x: 0, y: 0, width: bounds.width * min(max(progress, 0), 1), height: 5).fill()
        }

        if showsLabel, !label.isEmpty {
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 24, weight: .semibold),
                .foregroundColor: NSColor.white,
            ]
            let text = NSAttributedString(string: label, attributes: attrs)
            let size = text.size()
            let pill = NSRect(x: bounds.midX - size.width / 2 - 24, y: 56, width: size.width + 48, height: size.height + 20)
            NSColor(white: 0.1, alpha: 0.9).setFill()
            NSBezierPath(roundedRect: pill, xRadius: pill.height / 2, yRadius: pill.height / 2).fill()
            text.draw(at: NSPoint(x: pill.minX + 24, y: pill.minY + 10))
        }

        guard let target else { return }
        let p = NSPoint(x: target.x - origin.x, y: target.y - origin.y)
        guard bounds.insetBy(dx: -40, dy: -40).contains(p) else { return }
        let pink = NSColor(red: 1, green: 0.22, blue: 0.37, alpha: 1)

        // 新目标出现时外圈扩散一次
        let since = Date().timeIntervalSince(targetChangedAt)
        if since < 0.7 {
            let f = since / 0.7
            let r = 22 + 40 * (1 - pow(1 - f, 3))
            pink.withAlphaComponent(1 - f).setStroke()
            let ring = NSBezierPath(ovalIn: NSRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2))
            ring.lineWidth = 3
            ring.stroke()
        }
        NSColor.white.setFill()
        NSBezierPath(ovalIn: NSRect(x: p.x - 22, y: p.y - 22, width: 44, height: 44)).fill()
        pink.setFill()
        NSBezierPath(ovalIn: NSRect(x: p.x - 16, y: p.y - 16, width: 32, height: 32)).fill()
        NSColor.white.setFill()
        NSBezierPath(ovalIn: NSRect(x: p.x - 5, y: p.y - 5, width: 10, height: 10)).fill()
    }
}

final class Overlay {
    private var windows: [(Display, NSWindow, OverlayView)] = []
    private var timer: Timer?
    private var lastTarget: CGPoint?

    var isOn: Bool { !windows.isEmpty }

    func update(target: CGPoint?, label: String, progress: Double?) {
        if windows.isEmpty { show() }
        let moved = target.map { t in lastTarget.map { hypot($0.x - t.x, $0.y - t.y) > 60 } ?? true } ?? false
        lastTarget = target
        // 提示文字放在目标所在的显示器上；没有目标时放在主显示器上
        let labelDisplay = windows.first { d, _, _ in target.map { d.bounds.contains($0) } ?? false }?.0.id
            ?? windows.first { $0.0.isMain }?.0.id
        for (d, _, view) in windows {
            view.target = target
            view.label = label
            view.progress = progress
            view.showsLabel = d.id == labelDisplay
            if moved { view.targetChangedAt = Date() }
            view.needsDisplay = true
        }
    }

    func hide() {
        timer?.invalidate()
        timer = nil
        for (_, w, _) in windows { w.orderOut(nil) }
        windows = []
        lastTarget = nil
    }

    private func show() {
        for d in Display.all() {
            guard let screen = NSScreen.screens.first(where: { Display.screenID($0) == d.id }) else { continue }
            let w = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
            w.setFrame(screen.frame, display: false)
            w.level = .screenSaver
            w.isOpaque = false
            w.backgroundColor = .clear
            w.hasShadow = false
            w.ignoresMouseEvents = true
            w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
            let view = OverlayView(frame: NSRect(origin: .zero, size: screen.frame.size))
            view.origin = d.bounds.origin
            w.contentView = view
            w.orderFrontRegardless()
            windows.append((d, w, view))
        }
        // 扩散动画需要持续重绘
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            for (_, _, v) in self?.windows ?? [] { v.needsDisplay = true }
        }
    }
}

// MARK: - 系统鼠标

/// 头控发出的事件都打上这个标记，监听真实键鼠时据此排除自己
let syntheticMark: Int64 = 0x4E4F_444C // "NODL"

final class MouseControl {
    private(set) var enabled = false
    private(set) var trusted = false
    private var escMonitor: Any?
    private var inputMonitor: Any?
    var onStopped: (() -> Void)?
    /// 真实键鼠动了（已排除自己发出的事件）
    var onPhysical: ((String) -> Void)?

    /// 让位：真实键鼠最后一次活动后的这段时间里，丢弃头控的移动和点击
    var yieldSeconds: TimeInterval = 1.5
    private(set) var lastPhysical = Date.distantPast
    var yielding: Bool { Date().timeIntervalSince(lastPhysical) < yieldSeconds }

    /// 头控按下的左键；按下太久自动松开
    private(set) var leftDown = false
    private var downAt = Date.distantPast
    let maxHold: TimeInterval = 35
    /// 最近一次头控发出的事件的位置，用来辨认没带标记的回声事件
    private var lastPosted: (p: CGPoint, at: Date)?

    /// 打开控制前检查“辅助功能”权限；没有权限时系统会弹出提示
    func setEnabled(_ on: Bool) {
        if on {
            trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            enabled = true
            log(trusted ? "已接管系统鼠标（按 Esc 交还）" : "已接管系统鼠标，但没有“辅助功能”权限：光标能移动，其他 App 收不到悬停事件。到 系统设置 → 隐私与安全性 → 辅助功能 里打开 NodLinkBridge。")
            if escMonitor == nil {
                escMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] e in
                    guard e.keyCode == 53, self?.enabled == true else { return }
                    self?.setEnabled(false)
                    self?.onStopped?()
                }
            }
            if inputMonitor == nil {
                let kinds: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown,
                                                     .leftMouseDragged, .rightMouseDragged, .scrollWheel, .keyDown]
                inputMonitor = NSEvent.addGlobalMonitorForEvents(matching: kinds) { [weak self] e in self?.observe(e) }
            }
        } else if enabled {
            release()
            releaseKeys()
            flush()
            enabled = false
            log("已交还系统鼠标")
        }
    }

    /// 接管期间权限可能刚被打开或关掉：重新查一次，变了返回 true
    func refreshTrust() -> Bool {
        guard enabled else { return false }
        let now = AXIsProcessTrusted()
        guard now != trusted else { return false }
        trusted = now
        log(now ? "已获得“辅助功能”权限，可以点击了" : "“辅助功能”权限被关掉了，只能移动光标")
        return true
    }

    /// 全局监听到一个事件：是自己发的就忽略，否则算真实键鼠
    private func observe(_ e: NSEvent) {
        guard enabled else { return }
        if e.cgEvent?.getIntegerValueField(.eventSourceUserData) == syntheticMark { return }
        // 万一转发时丢了标记：鼠标事件的位置和刚发出的事件对得上，也当作自己的回声
        if ![.keyDown, .scrollWheel].contains(e.type), let lp = lastPosted,
           Date().timeIntervalSince(lp.at) < 0.15, let loc = e.cgEvent?.location, hypot(loc.x - lp.p.x, loc.y - lp.p.y) < 1.5 {
            return
        }
        let kind = e.type == .keyDown ? "key" : e.type == .scrollWheel ? "scroll" : "mouse"
        lastPhysical = Date()
        flush()
        virtual = nil
        if leftDown || !heldKeys.isEmpty || !heldMods.isEmpty {
            release()
            releaseKeys()
            log("真实键鼠动了，松开头控按住的键")
        }
        onPhysical?(kind)
    }

    var location: CGPoint { CGEvent(source: nil)?.location ?? .zero }

    /// 光标“现在”在哪：刚发过移动事件时，系统还没处理完，CGEvent(source: nil).location 读到的是旧位置
    /// （实测连发 10 次，移完马上读，10 次都差 130～240 点）。所以半秒内发过事件，就用最后发出去的那个位置
    var current: CGPoint {
        if let lp = lastPosted, Date().timeIntervalSince(lp.at) < 0.5 { return lp.p }
        return location
    }

    func move(to p: CGPoint, displays: [Display]) {
        guard enabled, !yielding else { return }
        let q = clampToDisplays(p, displays)
        // 按住左键时发 dragged，别的 App 才知道是在拖拽
        if trusted, let e = CGEvent(mouseEventSource: nil, mouseType: leftDown ? .leftMouseDragged : .mouseMoved, mouseCursorPosition: q, mouseButton: .left) {
            post(e)
        } else {
            CGWarpMouseCursorPosition(q)
        }
    }

    /// 在当前位置（或先移到 at）点击、按下或松开。没有“辅助功能”权限时系统不让发点击
    func button(_ name: String, action: String, count: Int, at: CGPoint?, mods: [String] = [], displays: [Display]) {
        guard enabled, !yielding else { return }
        guard trusted else {
            log("没有“辅助功能”权限，发不了点击")
            return
        }
        if let at {
            if !keysAreDelta { flush() }
            move(to: at, displays: displays)
        }
        // 有目标位置就直接点在那里（不能再读光标位置：刚移过去，读到的还是旧位置，标号这种一跳几十上百点的就点空了）
        let p = at.map { clampToDisplays($0, displays) } ?? current
        let right = name == "right"
        let (downType, upType): (CGEventType, CGEventType) = right ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
        let btn: CGMouseButton = right ? .right : .left
        func send(_ type: CGEventType) {
            guard let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: btn) else { return }
            e.setIntegerValueField(.mouseEventClickState, value: Int64(max(count, 1)))
            e.flags.formUnion(MouseControl.flags(mods)) // 比如 Shift + 点击：选中到这里
            post(e)
        }
        switch action {
        case "down" where !right:
            guard !leftDown else { return }
            send(downType)
            leftDown = true
            downAt = Date()
        case "up" where !right:
            release()
        default:
            if !right, leftDown { release() }
            send(downType)
            send(upType)
        }
    }

    /// 松开头控按住的左键。交还鼠标、断线、真实键鼠介入、超时都会调用
    func release() {
        guard leftDown else { return }
        leftDown = false
        if let e = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: current, mouseButton: .left) {
            post(e)
        }
    }

    /// 兜底：网页卡住或断线时，按住的左键也会在 maxHold 秒后松开
    func checkHold() {
        if leftDown, Date().timeIntervalSince(downAt) > maxHold {
            release()
            log("左键按住超过 \(Int(maxHold)) 秒，自动松开")
        }
        let oldest = min(heldKeys.values.min() ?? .distantFuture, heldMods.isEmpty ? .distantFuture : heldModsAt)
        if Date().timeIntervalSince(oldest) > maxHold {
            releaseKeys()
            log("按键按住超过 \(Int(maxHold)) 秒，自动松开")
        }
    }

    private func post(_ e: CGEvent) {
        if e.type != .flagsChanged { e.flags.formUnion(heldMods) }
        e.setIntegerValueField(.eventSourceUserData, value: syntheticMark)
        e.post(tap: .cghidEventTap)
        lastPosted = (e.location, Date())
        if [.mouseMoved, .leftMouseDragged].contains(e.type) {
            stat.moves += 1
            if let lm = lastMoved { stat.maxStep = max(stat.maxStep, hypot(e.location.x - lm.x, e.location.y - lm.y)) }
            lastMoved = e.location
        }
    }

    /// 增量移动用自己记的浮点位置累加：系统光标位置会取整，慢慢移动时每帧不到 1 点的位移会被吃掉
    private var virtual: CGPoint?
    func move(by d: CGPoint, displays: [Display]) {
        let cur = current // 不用 location：刚移过，读到的是旧位置，会把这一段当成“别人动过”吞掉
        var base = virtual ?? cur
        if hypot(base.x - cur.x, base.y - cur.y) > 2 { base = cur } // 别人动过光标，以系统为准（真实键鼠一动 virtual 就清空）
        let p = clampToDisplays(CGPoint(x: base.x + d.x, y: base.y + d.y), displays)
        virtual = p
        move(to: p, displays: displays)
    }

    // MARK: 平滑播放

    /// 网页发来的光标位置带着设备时间 ts。耳机数据是成批到的，直接执行会一顿一顿；
    /// 这里按 ts 把它们排开，以 120 Hz 插值播放。
    /// - 播放时间只进不退：延迟一变就倒着播，头转得快时光标会来回闪（实测 20 秒里倒退 8 次、共 234 点）
    /// - 延迟取最近两秒到达延迟的 90 分位：变大时很快跟上，变小时慢慢收回
    /// - 播到了最新一帧还没有新数据（缺数据），就停在最新一帧，并把延迟加上缺的那一段，下次不再缺
    private struct Key { let ts: TimeInterval; let p: CGPoint }
    private var keys: [Key] = []
    private var keysAreDelta = false
    private var deltaSum = CGPoint.zero
    private var deltaPlayed = CGPoint.zero
    private var lags: [(at: TimeInterval, lag: TimeInterval)] = []
    private(set) var playDelay: TimeInterval = 0
    private var lastPlay: TimeInterval = 0
    // 每秒统计，写进日志：发了多少次移动、最大一步多远、缺了几次数据
    private(set) var stat = (moves: 0, maxStep: 0.0, starve: 0)
    private var lastMoved: CGPoint?
    func takeStat() -> (moves: Int, maxStep: Double, starve: Int) {
        defer { stat = (0, 0, 0) }
        return stat
    }

    func queue(absolute p: CGPoint?, delta d: CGPoint?, ts: TimeInterval) {
        guard enabled, !yielding else { return }
        let now = ProcessInfo.processInfo.systemUptime
        lags.append((now, now - ts))
        lags.removeAll { now - $0.at > 2 }
        let sorted = lags.map(\.lag).sorted()
        let target = min(max(sorted[Int(Double(sorted.count - 1) * 0.9)] + 0.008, 0.015), 0.2)
        playDelay = playDelay == 0 ? target : playDelay + (target - playDelay) * (target > playDelay ? 0.2 : 0.01)
        let delta = d != nil
        if delta != keysAreDelta { flush() ; keysAreDelta = delta }
        if let d {
            deltaSum = CGPoint(x: deltaSum.x + d.x, y: deltaSum.y + d.y)
            keys.append(Key(ts: ts, p: deltaSum))
        } else if let p {
            keys.append(Key(ts: ts, p: p))
        }
        if keys.count > 400 { keys.removeFirst(keys.count - 400) }
    }

    /// 丢掉还没播的部分（真实键鼠介入、点击定位、交还时）
    func flush() {
        keys.removeAll()
        lastPlay = 0
        deltaSum = .zero
        deltaPlayed = .zero
    }

    /// 每 1/120 秒调用一次
    func tick(displays: [Display]) {
        guard enabled, !keys.isEmpty else { return }
        var play = max(ProcessInfo.processInfo.systemUptime - playDelay, lastPlay)
        if let newest = keys.last?.ts, play > newest {
            stat.starve += 1
            playDelay = min(playDelay + (play - newest), 0.25)
            play = newest
        }
        lastPlay = play
        var value = keys[keys.count - 1].p
        if play <= keys[0].ts {
            value = keys[0].p
        } else if let i = keys.firstIndex(where: { $0.ts >= play }), i > 0 {
            let a = keys[i - 1], b = keys[i]
            let f = b.ts > a.ts ? (play - a.ts) / (b.ts - a.ts) : 1
            value = CGPoint(x: a.p.x + (b.p.x - a.p.x) * f, y: a.p.y + (b.p.y - a.p.y) * f)
            if i > 1 { keys.removeFirst(i - 1) }
        }
        if keysAreDelta {
            let d = CGPoint(x: value.x - deltaPlayed.x, y: value.y - deltaPlayed.y)
            deltaPlayed = value
            if abs(d.x) + abs(d.y) > 0.01 { move(by: d, displays: displays) }
        } else if hypot(value.x - (lastAbs?.x ?? .infinity), value.y - (lastAbs?.y ?? .infinity)) > 0.05 {
            lastAbs = value
            move(to: value, displays: displays)
        }
    }
    private var lastAbs: CGPoint?

    // MARK: 滚动和快捷键

    /// 滚动 dy 点（正数 = 内容往上走，看下面的内容，像手指上滑）。分 10 次在 200 ms 内发完，滚得顺
    func scroll(_ dy: Double) {
        guard enabled, !yielding, trusted else { return }
        let steps = 10
        for i in 0..<steps {
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * 0.02) { [weak self] in
                guard let self, self.enabled, !self.yielding,
                      let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(-dy / Double(steps)), wheel2: 0, wheel3: 0) else { return }
                self.post(e)
            }
        }
    }

    // MARK: 键盘（语音按键）

    /// 美式键盘的虚拟键码
    static let keyCodes: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
        "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
        "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
        "return": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53, "forwarddelete": 117,
        "left": 123, "right": 124, "down": 125, "up": 126, "pageup": 116, "pagedown": 121,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    ]
    static let modKeys: [String: (code: CGKeyCode, flag: CGEventFlags)] = [
        "cmd": (55, .maskCommand), "shift": (56, .maskShift), "alt": (58, .maskAlternate), "ctrl": (59, .maskControl),
        "fn": (63, .maskSecondaryFn),
    ]
    /// 头控按住的键和修饰键：之后发出的所有事件（包括点击）都带着这些修饰键，按住 Shift 再点就是选中一段
    private var heldKeys: [CGKeyCode: Date] = [:]
    private(set) var heldMods: CGEventFlags = []
    private var heldModsAt = Date.distantPast

    static func flags(_ mods: [String]) -> CGEventFlags {
        mods.reduce(into: CGEventFlags()) { $0.formUnion(modKeys[$1]?.flag ?? []) }
    }

    /// action：press 按一下；down 按住不放（说“松开”才放）；up 放开这一个键（歪头按住 Fn，回正时放开）
    func sendKey(_ name: String, mods: [String], action: String) {
        // 放开不看让位和开关：按下去的键无论如何都要能放开
        if action == "up" { return releaseKey(name) }
        guard enabled, !yielding, trusted else { return }
        if name == "capslock" { return toggleCapsLock() }
        if let mk = MouseControl.modKeys[name] {
            if action != "down" {
                // 单独按一下修饰键（主要是 Fn）：按下、松开
                for down in [true, false] {
                    guard let e = CGEvent(keyboardEventSource: nil, virtualKey: mk.code, keyDown: down) else { continue }
                    e.type = .flagsChanged
                    e.flags = down ? heldMods.union(mk.flag) : heldMods
                    post(e)
                }
                return
            }
            // 按住一个修饰键（hold shift、歪头按住 Fn）
            heldMods.formUnion(mk.flag)
            heldModsAt = Date()
            if let e = CGEvent(keyboardEventSource: nil, virtualKey: mk.code, keyDown: true) {
                e.type = .flagsChanged
                e.flags = heldMods
                post(e)
            }
            log("按住 \(name)")
            return
        }
        guard let code = MouseControl.keyCodes[name] else {
            log("不认识的键：\(name)")
            return
        }
        let f = MouseControl.flags(mods)
        if action == "down" {
            guard heldKeys[code] == nil, let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true) else { return }
            e.flags.formUnion(f)
            post(e)
            heldKeys[code] = Date()
        } else {
            key(code, flags: f)
        }
    }

    /// 切换大小写锁定。用合成按键按 Caps Lock 不会改变锁定状态，要直接改系统的锁定状态
    private func toggleCapsLock() {
        var connect: io_connect_t = 0
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching(kIOHIDSystemClass))
        defer { IOObjectRelease(service) }
        guard service != 0, IOServiceOpen(service, mach_task_self_, UInt32(kIOHIDParamConnectType), &connect) == KERN_SUCCESS else {
            log("切换大小写失败：打不开键盘服务")
            return
        }
        defer { IOServiceClose(connect) }
        var on = false
        IOHIDGetModifierLockState(connect, Int32(kIOHIDCapsLockState), &on)
        let r = IOHIDSetModifierLockState(connect, Int32(kIOHIDCapsLockState), !on)
        log(r == KERN_SUCCESS ? "大小写锁定：\(on ? "关" : "开")" : "切换大小写失败（\(r)）")
    }

    /// 放开一个按住的键或修饰键
    func releaseKey(_ name: String) {
        if let mk = MouseControl.modKeys[name] {
            guard heldMods.contains(mk.flag) else { return }
            heldMods.remove(mk.flag)
            if let e = CGEvent(keyboardEventSource: nil, virtualKey: mk.code, keyDown: false) {
                e.type = .flagsChanged
                e.flags = heldMods
                post(e)
            }
            log("放开 \(name)")
        } else if let code = MouseControl.keyCodes[name], heldKeys[code] != nil {
            heldKeys[code] = nil
            if let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) { post(e) }
        }
    }

    /// 放开头控按住的所有键和修饰键
    func releaseKeys() {
        for code in heldKeys.keys {
            if let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) { post(e) }
        }
        heldKeys.removeAll()
        guard !heldMods.isEmpty else { return }
        let mods = heldMods
        heldMods = []
        for (_, mk) in MouseControl.modKeys where mods.contains(mk.flag) {
            if let e = CGEvent(keyboardEventSource: nil, virtualKey: mk.code, keyDown: false) {
                e.type = .flagsChanged
                e.flags = []
                post(e)
            }
        }
    }

    /// 发一个快捷键，比如 ⌘= 放大
    func key(_ code: CGKeyCode, flags: CGEventFlags) {
        guard enabled, !yielding, trusted else { return }
        for down in [true, false] {
            guard let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { continue }
            e.flags = flags
            post(e)
        }
    }
}

// MARK: - 吸附：读取光标附近的可点元素

/// 用辅助功能接口读出落点所在窗口（或菜单栏、程序坞）里所有可点元素的位置。
/// 选哪个元素（最近的 + 滞回）在网页里算（web/public/core/snap.js），这里只负责读。
/// 读一次窗口要几到几十毫秒，在后台线程做；落点还在上次扫过的窗口里、且不到 1 秒就不重读。
final class TargetScanner {
    static let actionable: Set<String> = [
        "AXButton", "AXLink", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton",
        "AXMenuBarItem", "AXMenuItem", "AXTextField", "AXTextArea", "AXComboBox", "AXSlider",
        "AXDisclosureTriangle", "AXIncrementor", "AXDockItem", "AXColorWell", "AXRow", "AXCell",
    ]
    /// 这些元素里面不再往下找（按钮里的图标、文字不是单独的目标）；行和单元格里还有按钮，要往下
    static let leaf: Set<String> = actionable.subtracting(["AXRow", "AXCell"])

    var onTargets: (([String: Any]) -> Void)?
    private let queue = DispatchQueue(label: "nodlink.targets", qos: .userInteractive)
    private let system = AXUIElementCreateSystemWide()
    private var busy = false
    private var container = CGRect.null
    private var scannedAt = Date.distantPast
    private var enabledPids = Set<pid_t>()
    private var warned = false

    init() {
        AXUIElementSetMessagingTimeout(system, 0.15) // 卡住的 App 不能把我们也卡住
    }

    func probe(_ p: CGPoint, displays: [Display]) {
        guard !busy else { return }
        guard AXIsProcessTrusted() else {
            if !warned { log("吸附需要“辅助功能”权限，现在读不到按钮位置"); warned = true }
            return
        }
        warned = false
        if container.contains(p), Date().timeIntervalSince(scannedAt) < 1 { return }
        busy = true
        let screens = displays.map(\.bounds)
        queue.async { [weak self] in
            guard let self else { return }
            let result = self.scan(at: p, screens: screens)
            DispatchQueue.main.async {
                self.busy = false
                self.scannedAt = Date()
                self.container = result.container
                self.onTargets?(result.json)
            }
        }
    }

    private var pointBusy = false

    /// “正在指向”：头指的那个点下面是哪个 App 的什么元素、叫什么（网页显示成“Safari · 按钮「关闭」”）。
    /// 只读一个元素和它往上几层，约 1 毫秒；网页不管接没接管鼠标，只要在用耳机数据就每 150 ms 问一次
    func point(_ p: CGPoint) {
        guard !pointBusy, AXIsProcessTrusted() else { return }
        pointBusy = true
        queue.async { [weak self] in
            guard let self else { return }
            var json: [String: Any] = ["type": "pointing", "x": p.x, "y": p.y]
            var hit: AXUIElement?
            if AXUIElementCopyElementAtPosition(self.system, Float(p.x), Float(p.y), &hit) == .success, let hit {
                var pid: pid_t = 0
                AXUIElementGetPid(hit, &pid)
                json["app"] = NSRunningApplication(processIdentifier: pid)?.localizedName ?? ""
                // 按钮里的图标、文字往上找到按钮本身；找不到可点的就用最里面那个元素
                var e = hit
                var found = false
                for _ in 0..<6 {
                    if let r: String = TargetScanner.attr(e, kAXRoleAttribute), TargetScanner.actionable.contains(r) { found = true; break }
                    guard let parent: AXUIElement = TargetScanner.attr(e, kAXParentAttribute) else { break }
                    e = parent
                }
                if !found { e = hit }
                let role: String = TargetScanner.attr(e, kAXRoleAttribute) ?? ""
                json["role"] = role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
                for name in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXHelpAttribute] {
                    if let v: String = TargetScanner.attr(e, name) {
                        let t = v.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !t.isEmpty { json["label"] = t.count > 40 ? String(t.prefix(40)) + "…" : t; break }
                    }
                }
            }
            DispatchQueue.main.async {
                self.pointBusy = false
                self.onTargets?(json)
            }
        }
    }

    /// 网页要求马上重读（比如点击之后界面变了）
    func invalidate() {
        scannedAt = .distantPast
    }

    private func scan(at p: CGPoint, screens: [CGRect]) -> (container: CGRect, json: [String: Any]) {
        let t0 = Date()
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(p.x), Float(p.y), &hit) == .success, let hit else {
            return (.null, ["type": "targets", "at": ["x": p.x, "y": p.y], "items": []])
        }
        // Electron、Chrome 平时不提供界面结构，打开后才有（读屏软件也这么做）
        var pid: pid_t = 0
        AXUIElementGetPid(hit, &pid)
        if !enabledPids.contains(pid) {
            enabledPids.insert(pid)
            AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), "AXManualAccessibility" as CFString, kCFBooleanTrue)
        }
        // 往上找到顶层：窗口、菜单栏或程序坞（父元素是 App 的那一层）
        var root = hit
        for _ in 0..<40 {
            guard let parent: AXUIElement = TargetScanner.attr(root, kAXParentAttribute) else { break }
            if (TargetScanner.attr(parent, kAXRoleAttribute) as String?) == "AXApplication" { break }
            root = parent
        }
        let rootRole: String = TargetScanner.attr(root, kAXRoleAttribute) ?? ""
        let rootFrame = TargetScanner.frame(root) ?? .null
        let title: String = TargetScanner.attr(root, kAXTitleAttribute) ?? ""

        var items: [[String: Any]] = []
        var stack: [(AXUIElement, Int)] = [(root, 0)]
        var visited = 0
        let names = [kAXRoleAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute] as CFArray
        while let (e, depth) = stack.popLast(), visited < 4000, Date().timeIntervalSince(t0) < 0.12 {
            visited += 1
            var values: CFArray?
            guard AXUIElementCopyMultipleAttributeValues(e, names, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
                  let v = values as? [AnyObject], v.count == 4 else { continue }
            let role = (v[0] as? String) ?? ""
            if TargetScanner.actionable.contains(role), let pos = TargetScanner.point(v[1]), let size = TargetScanner.size(v[2]) {
                let r = CGRect(origin: pos, size: size)
                let onScreen = screens.contains { $0.intersects(r) }
                let inRoot = rootRole == "AXMenuBar" || rootFrame.isNull || rootFrame.intersects(r)
                if r.width >= 4, r.height >= 4, onScreen, inRoot {
                    items.append(["x": r.minX, "y": r.minY, "w": r.width, "h": r.height, "r": String(role.dropFirst(2))])
                }
            }
            if TargetScanner.leaf.contains(role) || depth > 40 { continue }
            if let kids = v[3] as? [AXUIElement] { for k in kids.reversed() { stack.append((k, depth + 1)) } }
        }
        let ms = Date().timeIntervalSince(t0) * 1000
        var json: [String: Any] = ["type": "targets", "at": ["x": p.x, "y": p.y], "items": items, "role": rootRole, "title": title,
                                   "ms": (ms * 10).rounded() / 10, "visited": visited]
        if !rootFrame.isNull { json["container"] = ["x": rootFrame.minX, "y": rootFrame.minY, "w": rootFrame.width, "h": rootFrame.height] }
        return (rootFrame, json)
    }

    static func attr<T>(_ e: AXUIElement, _ name: String) -> T? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success else { return nil }
        return v as? T
    }

    static func frame(_ e: AXUIElement) -> CGRect? {
        guard let p = point(attr(e, kAXPositionAttribute) as AnyObject?), let s = size(attr(e, kAXSizeAttribute) as AnyObject?) else { return nil }
        return CGRect(origin: p, size: s)
    }

    static func point(_ v: AnyObject?) -> CGPoint? {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var p = CGPoint.zero
        return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
    }

    static func size(_ v: AnyObject?) -> CGSize? {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var s = CGSize.zero
        return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
    }
}

/// 吸附到的元素外面画一圈高亮框，告诉用户现在选中的是哪个。框跟着目标滑过去，不接收鼠标
final class Highlight {
    private var window: NSWindow?

    final class Frame: NSView {
        override func draw(_ dirtyRect: NSRect) {
            let pink = NSColor(red: 1, green: 0.31, blue: 0.64, alpha: 1)
            let r = bounds.insetBy(dx: 4, dy: 4)
            pink.withAlphaComponent(0.18).setStroke()
            let glow = NSBezierPath(roundedRect: r, xRadius: 7, yRadius: 7)
            glow.lineWidth = 7
            glow.stroke()
            pink.setStroke()
            let line = NSBezierPath(roundedRect: r, xRadius: 7, yRadius: 7)
            line.lineWidth = 2.5
            line.stroke()
        }
    }

    /// r：全局坐标（Quartz，y 向下）；nil 隐藏
    func show(_ r: CGRect?) {
        guard let r else {
            window?.orderOut(nil)
            return
        }
        // Quartz 坐标换成 AppKit 坐标（原点在主显示器左下角，y 向上）
        let mainH = NSScreen.screens.first { $0.frame.origin == .zero }?.frame.height ?? NSScreen.main?.frame.height ?? 0
        let f = NSRect(x: r.minX - 8, y: mainH - r.maxY - 8, width: r.width + 16, height: r.height + 16)
        if window == nil {
            let w = NSWindow(contentRect: f, styleMask: .borderless, backing: .buffered, defer: false)
            w.level = .screenSaver
            w.isOpaque = false
            w.backgroundColor = .clear
            w.hasShadow = false
            w.ignoresMouseEvents = true
            w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
            w.contentView = Frame(frame: NSRect(origin: .zero, size: f.size))
            w.contentView?.autoresizingMask = [.width, .height]
            window = w
        }
        guard let w = window else { return }
        if w.isVisible {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.09
                w.animator().setFrame(f, display: true)
            }
        } else {
            w.setFrame(f, display: true)
            w.orderFrontRegardless()
        }
    }
}

// MARK: - 标号：头指的地方附近的可点元素标上 1～9

/// 每个元素一圈细框 + 一枚圆形数字牌。小元素（窗口左上角的红黄绿这种）数字牌盖在正中，大元素放在左上角，不挡内容。
/// 一个透明、点不到的窗口，盖住所有标号的外接矩形
final class Labels {
    struct Item { let n: Int; let rect: CGRect } // rect：全局坐标（Quartz，y 向下）
    private var window: NSWindow?

    final class Badges: NSView {
        var items: [Item] = []
        var origin = CGPoint.zero // 窗口左上角的全局坐标
        override var isFlipped: Bool { true }
        override func draw(_ dirtyRect: NSRect) {
            let pink = NSColor(red: 1, green: 0.31, blue: 0.64, alpha: 1)
            let ink = NSColor(red: 0.07, green: 0.05, blue: 0.15, alpha: 0.92)
            for it in items {
                let r = it.rect.offsetBy(dx: -origin.x, dy: -origin.y)
                pink.withAlphaComponent(0.9).setStroke()
                let box = NSBezierPath(roundedRect: r.insetBy(dx: -2, dy: -2), xRadius: 4, yRadius: 4)
                box.lineWidth = 1.5
                box.stroke()
                let small = r.width <= 44 && r.height <= 44
                let d: CGFloat = 20
                let c = small ? CGPoint(x: r.midX, y: r.midY) : CGPoint(x: r.minX + d / 2 + 1, y: r.minY + d / 2 + 1)
                let disc = CGRect(x: c.x - d / 2, y: c.y - d / 2, width: d, height: d)
                ink.setFill()
                NSBezierPath(ovalIn: disc.insetBy(dx: -2, dy: -2)).fill()
                pink.setFill()
                NSBezierPath(ovalIn: disc).fill()
                let s = NSAttributedString(string: "\(it.n)", attributes: [.font: NSFont.systemFont(ofSize: 13, weight: .heavy), .foregroundColor: NSColor.white])
                let sz = s.size()
                s.draw(at: CGPoint(x: c.x - sz.width / 2, y: c.y - sz.height / 2))
            }
        }
    }

    func show(_ items: [Item]) {
        guard !items.isEmpty else {
            window?.orderOut(nil)
            return
        }
        let all = items.map(\.rect).reduce(CGRect.null) { $0.union($1) }.insetBy(dx: -16, dy: -16)
        let mainH = NSScreen.screens.first { $0.frame.origin == .zero }?.frame.height ?? NSScreen.main?.frame.height ?? 0
        let f = NSRect(x: all.minX, y: mainH - all.maxY, width: all.width, height: all.height)
        if window == nil {
            let w = NSWindow(contentRect: f, styleMask: .borderless, backing: .buffered, defer: false)
            w.level = .screenSaver
            w.isOpaque = false
            w.backgroundColor = .clear
            w.hasShadow = false
            w.ignoresMouseEvents = true
            w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
            w.contentView = Badges(frame: NSRect(origin: .zero, size: f.size))
            w.contentView?.autoresizingMask = [.width, .height]
            window = w
        }
        guard let w = window, let v = w.contentView as? Badges else { return }
        w.setFrame(f, display: false)
        v.items = items
        v.origin = all.origin
        v.needsDisplay = true
        w.orderFrontRegardless()
    }
}

// MARK: - 窗口按钮

/// 关闭、最小化、全屏：按窗口自己的红黄绿按钮（辅助功能接口），和用鼠标点一样，不用对准。
/// 按的是头指的位置下面那个窗口；那里没有窗口（桌面、菜单栏）就按最前面 App 的当前窗口
enum WindowAction {
    static func perform(_ action: String, at p: CGPoint?) -> Bool {
        guard let win = window(at: p) ?? focusedWindow() else { return false }
        if action == "fullscreen" {
            // 直接切换全屏属性最稳；不支持的窗口再去按绿色按钮
            var v: CFTypeRef?
            if AXUIElementCopyAttributeValue(win, "AXFullScreen" as CFString, &v) == .success, let on = v as? Bool,
               AXUIElementSetAttributeValue(win, "AXFullScreen" as CFString, (!on) as CFBoolean) == .success {
                return true
            }
        }
        let attr = ["close": kAXCloseButtonAttribute, "minimize": kAXMinimizeButtonAttribute, "fullscreen": "AXFullScreenButton"][action]
        guard let attr, let button: AXUIElement = TargetScanner.attr(win, attr) else { return false }
        return AXUIElementPerformAction(button, kAXPressAction as CFString) == .success
    }

    private static func window(at p: CGPoint?) -> AXUIElement? {
        guard let p else { return nil }
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &hit) == .success, var e = hit else { return nil }
        for _ in 0..<80 {
            if (TargetScanner.attr(e, kAXRoleAttribute) as String?) == kAXWindowRole { return e }
            if let w: AXUIElement = TargetScanner.attr(e, kAXWindowAttribute) { return w }
            guard let parent: AXUIElement = TargetScanner.attr(e, kAXParentAttribute) else { return nil }
            e = parent
        }
        return nil
    }

    private static func focusedWindow() -> AXUIElement? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        return TargetScanner.attr(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedWindowAttribute)
    }
}

// MARK: - 提示音

/// 用系统自带的短音效做反馈。声音从当前输出设备出来，戴着 AirPods 时就在耳机里
enum Cue {
    static let names = ["click": "Tink", "double": "Pop", "right": "Bottle", "down": "Morse", "up": "Frog"]
    static func play(_ cue: String) {
        guard let name = names[cue], let sound = NSSound(named: NSSound.Name(name)) else { return }
        sound.stop()
        sound.play()
    }
}

// MARK: - 语音指令

/// 本机语音识别，只认一小组指令词（语法见 VoiceGrammar.swift，中文、英文都行）。
/// - 默认用 Mac 自带麦克风：用 AirPods 的麦克风会让耳机切到通话模式，音质变差
/// - 中文和英文两个识别器同时听同一路声音：中文识别器常把 up、key m 这类英文听成别的字
/// - 按拼音整词匹配，同音字也算；整句太长的不算，聊天里顺口说到“放大”不会触发
/// - 每句话一个识别任务：一开口就开新任务，并把开口前 0.3 秒的录音补进去，第一个字不会被切掉；
///   这样前面的闲聊不会和后面的指令拼成一句长话，指令也就不会因为“整句太长”被丢掉
final class Voice {
    var onSpeech: ((Bool) -> Void)?                 // 开口 / 说完
    var onUtterance: (([AVAudioPCMBuffer]) -> Void)? // 一句话说完时的整段录音（录真人语音用）
    var onCommand: ((VoiceCommand, String) -> Void)? // 指令、听到的原文
    var onText: ((String) -> Void)?                 // 识别中的文字，给界面显示
    var onState: (([String: Any]) -> Void)?

    /// 每次开始都新建：换了麦克风后，旧引擎缓存的格式和新设备对不上，装监听会直接崩溃
    private var engine = AVAudioEngine()
    static var locales = ["zh-CN", "en-US"]
    private let recognizers = Voice.locales.compactMap { SFSpeechRecognizer(locale: Locale(identifier: $0)) }
    private var requests: [SFSpeechAudioBufferRecognitionRequest] = []
    private var tasks: [SFSpeechRecognitionTask] = []
    private(set) var running = false
    private var micName = ""

    // 语音活动检测：底噪跟随，高出 12 dB 算开口
    private var floorDb: Float = -60
    private var quietSince: TimeInterval?
    private var speaking = false
    private var handled = false
    private var utteranceHandled = false // 这句话里已经认出过指令
    private var lastText = ""
    private var taskID = 0
    private var peakDb: Float = -100
    /// 最近 0.6 秒的录音，开新任务时先补进去
    private var recent: [AVAudioPCMBuffer] = []
    private let recentLock = NSLock()

    /// 正在听，或者正在后台开麦克风（还没开好）。外面判断“语音开着没有”要用这个，不能只看 running：
    /// 开麦克风的那一两秒里 running 还是 false，这时交还鼠标要能把它停掉
    var active: Bool { running || opening }
    private(set) var opening = false

    func start(builtIn: Bool) {
        guard !active else { return }
        opening = true
        let gen = openGen
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard self.opening, self.openGen == gen else { return } // 等权限的时候已经被停掉了
                guard status == .authorized else {
                    self.opening = false
                    log("没有语音识别权限：到 系统设置 → 隐私与安全性 → 语音识别 里打开 NodLinkBridge")
                    self.onState?(["on": false, "error": "speech"])
                    return
                }
                AVCaptureDevice.requestAccess(for: .audio) { ok in
                    DispatchQueue.main.async {
                        guard self.opening, self.openGen == gen else { return }
                        guard ok else {
                            self.opening = false
                            log("没有麦克风权限：到 系统设置 → 隐私与安全性 → 麦克风 里打开 NodLinkBridge")
                            self.onState?(["on": false, "error": "mic"])
                            return
                        }
                        self.begin(builtIn: builtIn)
                    }
                }
            }
        }
    }

    // 麦克风看门狗：引擎说在跑，却一块音频都没有（实测会发生，多半是音频设备切换后引擎停了），就重开
    private var builtIn = true
    private var totalBuffers = 0
    private var watchBuffers = 0
    private var watchdog: Timer?
    private var configObserver: NSObjectProtocol?
    private var lastReopen: TimeInterval = 0
    private var reopenCount = 0

    private func watch() {
        watchdog?.invalidate()
        watchBuffers = -1
        watchdog = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            guard let self, self.running, self.testing == false else { return }
            self.recentLock.lock()
            let n = self.totalBuffers
            self.recentLock.unlock()
            if n == self.watchBuffers { self.reopen("2 秒没收到麦克风的声音") }
            self.watchBuffers = n
        }
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        // queue 必须是 nil，再自己异步回主线程。用 queue: .main 时，音频引擎的内部线程发通知后会一直等主线程处理完；
        // 而主线程换新引擎时释放旧引擎，又要同步等那条内部线程 —— 两边互等，耳机桥整个卡死（实测：耳机断开重连时发生，
        // 之后头部数据、网页指令全都不再处理）
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, ProcessInfo.processInfo.systemUptime - self.begunAt > 1.5 else { return }
                self.reopen("音频设备变了")
            }
        }
    }

    /// 开关麦克风都放在这条后台串行队列上：切换输入设备、启动和停止引擎实测会卡 1～2 秒，
    /// 放在主线程上时，同在主线程的头部数据会跟着停，网页上就像耳机断了
    private let audioQueue = DispatchQueue(label: "nodlink.mic", qos: .userInitiated)
    /// 每开一次麦克风加一：后台还没开完时又停了或重开了，开完的那个引擎就作废
    private var openGen = 0

    /// 停掉旧引擎，在后台线程停、拆监听、释放：这几步都会同步等引擎的内部线程，不能让主线程去等
    private var tapped = false // 只给装过监听的引擎拆监听：没用过的引擎一碰 inputNode 就会去打开麦克风
    private func retire(_ old: AVAudioEngine) {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        let hadTap = tapped
        tapped = false
        audioQueue.async {
            old.stop()
            if hadTap { old.inputNode.removeTap(onBus: 0) }
        }
    }

    /// 关掉麦克风再打开，识别任务也重开
    private func reopen(_ why: String) {
        guard running else { return }
        let now = ProcessInfo.processInfo.systemUptime
        // 连着重开不见效时放慢，别刷屏
        if now - lastReopen < 10 { reopenCount += 1 } else { reopenCount = 0 }
        if reopenCount > 3, now - lastReopen < 30 { return }
        lastReopen = now
        log("语音指令：\(why)，重新打开麦克风")
        running = false
        retire(engine)
        tasks.forEach { $0.cancel() }
        requests.forEach { $0.endAudio() }
        tasks = []
        requests = []
        if speaking { speaking = false; onSpeech?(false) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self, !self.stopped else { return }
            self.begin(builtIn: self.builtIn)
        }
    }

    private var stopped = false
    private var testing = false

    private var begunAt: TimeInterval = 0

    private func begin(builtIn: Bool) {
        self.builtIn = builtIn
        stopped = false
        begunAt = ProcessInfo.processInfo.systemUptime
        floorDb = -50
        levels = []
        levelsDur = 0
        speaking = false
        loudDur = 0
        postBusy = false
        recording = false
        utterBuf = []
        guard recognizers.contains(where: \.isAvailable) else {
            opening = false
            log("这台 Mac 上没有可用的语音识别")
            onState?(["on": false, "error": "unavailable"])
            return
        }
        retire(engine)
        engine = AVAudioEngine() // 占位：真正的引擎在后台开好后再换上
        openGen += 1
        opening = true
        let gen = openGen
        audioQueue.async { [weak self] in
            // 排在前面的那次开了好几秒，这期间已经停掉或又重开了：这次就不用开了
            let current = DispatchQueue.main.sync { self.map { gen == $0.openGen && !$0.stopped } ?? false }
            guard current else { return }
            let result = Voice.openMic(builtIn: builtIn) { buffer in self?.feed(buffer) }
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .failure(let fail):
                    guard gen == self.openGen, !self.stopped else { return }
                    self.opening = false
                    log(fail.why)
                    self.onState?(["on": false, "error": "engine"])
                case .success(let opened):
                    // 开的过程中被停掉或又重开了：这个引擎不要了
                    guard gen == self.openGen, !self.stopped else {
                        self.audioQueue.async { opened.engine.stop(); opened.engine.inputNode.removeTap(onBus: 0) }
                        return
                    }
                    self.opening = false
                    self.engine = opened.engine
                    self.micName = opened.name
                    self.tapped = true
                    self.started()
                }
            }
        }
    }

    private struct OpenedMic { let engine: AVAudioEngine; let name: String }
    private struct MicFail: Error { let why: String; init(_ why: String) { self.why = why } }

    /// 在后台线程上开麦克风：选设备、装监听、启动引擎。不碰 Voice 的任何状态
    private static func openMic(builtIn: Bool, feed: @escaping (AVAudioPCMBuffer) -> Void) -> Result<OpenedMic, MicFail> {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        var name = "系统默认输入"
        if builtIn, let (id, devName) = Voice.builtInMic(), let unit = input.audioUnit {
            var dev = id
            if AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr {
                name = devName
            }
        }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            return .failure(MicFail("麦克风格式不对（\(format)），可能是设备刚切换，过一会儿再开一次"))
        }
        // 系统默认输入是 AirPods（24 kHz 通话麦克风）、而这里换成了 Mac 自带麦克风（48 kHz）时，节点报的还是默认设备的格式，
        // 和硬件实际的格式对不上。拿节点格式去装 tap，installTap 会抛 Objective-C 异常，Swift 接不住，整个耳机桥直接退出；
        // 等它自己对上也等不到（这个错位会一直在）。所以以硬件的实际格式为准：后面的识别都按每块录音自带的采样率转换，不挑格式
        let hw = input.inputFormat(forBus: 0)
        let tapFormat = hw.sampleRate > 0 && hw.channelCount > 0 ? hw : format
        if abs(tapFormat.sampleRate - format.sampleRate) > 1 {
            log("麦克风按硬件格式打开（硬件 \(Int(hw.sampleRate)) Hz，节点报 \(Int(format.sampleRate)) Hz）")
        }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: tapFormat) { buffer, _ in feed(buffer) }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            return .failure(MicFail("麦克风启动失败：\(error.localizedDescription)"))
        }
        return .success(OpenedMic(engine: engine, name: name))
    }

    /// 麦克风开好以后（主线程）：开识别任务、看门狗、通知网页
    private func started() {
        running = true
        begunAt = ProcessInfo.processInfo.systemUptime
        CommandModel.prepareOnce(Voice.locales)
        newTask()
        startDiag()
        watch()
        let onDevice = recognizers.allSatisfy(\.supportsOnDeviceRecognition)
        let langs = recognizers.filter(\.isAvailable).map { $0.locale.identifier }.joined(separator: " + ")
        log("语音指令：已开始听（\(micName)，\(langs)，\(onDevice ? "本机离线识别" : "部分联网识别")）")
        onState?(["on": true, "mic": micName, "onDevice": onDevice])
    }

    /// 一块录音：交给所有识别任务、存进最近 0.6 秒、做音量检测
    private func feed(_ buffer: AVAudioPCMBuffer) {
        // 每个识别任务各给一份拷贝：引擎会复用这块缓冲区，识别是异步读的，共用一块时第二个识别器常常什么都听不到
        recentLock.lock()
        for r in requests { if let c = Voice.copy(buffer) { r.append(c) } }
        if let c = Voice.copy(buffer) {
            recent.append(c)
            if recording, utterDur < 8 { utterBuf.append(c); utterDur += Double(c.frameLength) / c.format.sampleRate }
        }
        let keep = Int(0.6 * buffer.format.sampleRate / Double(max(buffer.frameLength, 1))) + 1
        if recent.count > keep { recent.removeFirst(recent.count - keep) }
        stat.buffers += 1
        totalBuffers += 1
        recentLock.unlock()
        detect(buffer)
    }

    // 诊断：每 10 秒在日志里报一次，查“说了没反应”用
    private struct Stat { var buffers = 0; var maxDb: Float = -100; var speech = 0; var results: [String: Int] = [:]; var errors: [String] = []; var tasks = 0 }
    private var stat = Stat()
    private var diagTimer: Timer?

    private func startDiag() {
        diagTimer?.invalidate()
        diagTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            guard let self, self.running else { return }
            self.recentLock.lock()
            let st = self.stat
            self.stat = Stat()
            self.recentLock.unlock()
            let res = st.results.isEmpty ? "无" : st.results.map { "\($0.key) \($0.value)" }.sorted().joined(separator: "，")
            let err = st.errors.isEmpty ? "" : "，结束/出错：" + Dictionary(grouping: st.errors, by: { $0 }).map { "\($0.key)×\($0.value.count)" }.sorted().joined(separator: " ")
            log(String(format: "语音诊断（10 秒）：音频 %d 块，最大音量 %.0f dB，底噪 %.0f dB，开口 %d 次，新任务 %d 个，识别结果 %@%@", st.buffers, st.maxDb, self.floorDb, st.speech, st.tasks, res, err))
        }
    }

    /// 自测：把一个音频文件当作麦克风，按真实速度喂进同一套识别流程
    /// 自测：把几个音频文件当作麦克风，按真实速度依次喂进同一套识别流程，每个文件之间垫 2 秒轻微的底噪。
    /// 每个文件放完后在日志里写“自测片段 文件名”，方便按文件统计认对了没有。文件要同一种格式（如 16 kHz 单声道）
    func test(files: [URL], done: @escaping () -> Void) {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else { log("自测：没有语音识别权限（\(status.rawValue)）"); done(); return }
                let opened = files.compactMap { try? AVAudioFile(forReading: $0) }
                guard let format = opened.first?.processingFormat else { log("自测：打不开文件"); done(); return }
                self.running = true
                self.testing = true
                CommandModel.prepareOnce(Voice.locales)
                // 等语言模型编好再开始（最多 20 秒）
                var waited = 0.0
                Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { wait in
                    waited += 0.25
                    guard CommandModel.ready(Voice.locales) || waited > 20 || !CommandModel.enabled else { return }
                    wait.invalidate()
                    self.newTask()
                    self.startDiag()
                    self.play(opened, format: format, done: done)
                }
            }
        }
    }

    private func play(_ files: [AVAudioFile], format: AVAudioFormat, done: @escaping () -> Void) {
        let chunk: AVAudioFrameCount = 1600
        let dt = Double(chunk) / format.sampleRate
        var index = 0
        var gap = Int(1.6 / dt)
        var rng = SystemRandomNumberGenerator()
        Timer.scheduledTimer(withTimeInterval: dt, repeats: true) { timer in
            guard let b = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunk) else { return }
            if gap > 0 || index >= files.count {
                // 底噪：约 -55 dB 的白噪声
                b.frameLength = chunk
                if let ch = b.floatChannelData?[0] { for k in 0..<Int(chunk) { ch[k] = Float.random(in: -0.003...0.003, using: &rng) } }
                self.feed(b)
                gap -= 1
                if index >= files.count, gap < -Int(3.0 / dt) { timer.invalidate(); done() }
                return
            }
            let f = files[index]
            if f.framePosition == 0 { log("自测片段 \(f.url.lastPathComponent)") }
            if (try? f.read(into: b, frameCount: chunk)) == nil || b.frameLength == 0 {
                index += 1
                gap = Int(1.6 / dt)
                return
            }
            self.feed(b)
        }
    }

    func stop() {
        stopped = true
        openGen += 1 // 后台还没开好的麦克风，开好后直接作废
        let wasOpening = opening
        opening = false
        guard running else {
            if wasOpening { log("语音指令：已停止（麦克风还没开好）"); onState?(["on": false]) }
            return
        }
        running = false
        diagTimer?.invalidate()
        watchdog?.invalidate()
        retire(engine)
        tasks.forEach { $0.cancel() }
        requests.forEach { $0.endAudio() }
        tasks = []
        requests = []
        if speaking { speaking = false; onSpeech?(false) }
        log("语音指令：已停止")
        onState?(["on": false])
    }

    // 两个识别器不能同时听：实测中文和英文同时对着麦克风识别时，后开的那个几乎什么都认不出（单独开都很好）。
    // 所以中文实时听（边说边出结果，指令最快）；一句话说完，中文没认出指令时，再把这句话的录音交给英文认一遍。
    private var live: SFSpeechRecognizer? { recognizers.first(where: \.isAvailable) }
    private var post: [SFSpeechRecognizer] { Array(recognizers.filter(\.isAvailable).dropFirst()) }
    private var utterID = 0
    private var recording = false             // 正在录这句话（音频线程读，加锁）
    private var utterBuf: [AVAudioPCMBuffer] = []
    private var utterDur = 0.0
    private var postBusy = false              // 英文正在认上一句，中文先别开新任务，免得又抢

    /// preroll：把开口前 0.6 秒的录音也喂进去（开口那一下常被音量检测漏掉）。
    /// 刚执行完指令时不能喂：那 0.6 秒里正是刚说的那个词，新任务会把它再认一遍、再执行一次（实测“Click”点两下）
    private func newTask(preroll: Bool = true) {
        tasks.forEach { $0.cancel() }
        requests.forEach { $0.endAudio() }
        tasks = []
        requests = []
        guard running, let rec = live else { return }
        handled = false
        taskID += 1
        let id = taskID
        let r = SFSpeechAudioBufferRecognitionRequest()
        r.shouldReportPartialResults = true
        // 中文识别器也认得一些英文词，把英文指令也给它当提示
        r.contextualStrings = VoiceGrammar.hints + VoiceGrammar.hintsEnglish + VoiceGrammar.hintsLabels + (VoiceGrammar.labelsActive ? VoiceGrammar.hintsDigits : [])
        if let cfg = CommandModel.config(for: Voice.key(rec)) { r.customizedLanguageModel = cfg }
        if rec.supportsOnDeviceRecognition { r.requiresOnDeviceRecognition = true }
        recentLock.lock()
        if preroll { for b in recent { r.append(b) } }
        requests = [r]
        stat.tasks += 1
        recentLock.unlock()
        let utter = utterID
        tasks = [rec.recognitionTask(with: r) { [weak self] result, error in
            guard let self else { return }
            self.count(rec, result, error)
            // 216/301：任务被取消；1110：这段没人说话。都是正常情况，不记
            if let error, ![216, 301, 1110].contains((error as NSError).code) {
                log("语音识别出错（\(rec.locale.identifier)）：\(error.localizedDescription)")
            }
            let texts = Voice.candidates(result)
            let ended = error != nil || result?.isFinal == true
            DispatchQueue.main.async {
                if !texts.isEmpty, self.taskID == id { self.heard(texts, utter: utter, live: true) }
                // 任务自己结束了（出错、或识别器判定说完了）：接着开一轮，别断了。出错时隔 1 秒，免得刷屏
                if ended, self.taskID == id {
                    DispatchQueue.main.asyncAfter(deadline: .now() + (error != nil ? 1 : 0)) {
                        if self.running, self.taskID == id, !self.postBusy { self.newTask() }
                    }
                }
            }
        }]
    }

    private func count(_ locale: String, _ cands: [String]) {
        recentLock.lock()
        let lang = "新" + String(locale.prefix(2))
        stat.results[lang, default: 0] += cands.isEmpty ? 0 : 1
        if cands.isEmpty { stat.errors.append(lang + ":空") }
        recentLock.unlock()
    }

    private func count(_ rec: SFSpeechRecognizer, _ result: SFSpeechRecognitionResult?, _ error: Error?) {
        recentLock.lock()
        let lang = String(rec.locale.identifier.prefix(2))
        if let error { stat.errors.append("\(lang):\((error as NSError).code)") }
        if let result { stat.results[lang, default: 0] += 1; if result.isFinal { stat.results[lang + "完", default: 0] += 1 } }
        recentLock.unlock()
    }

    /// 新版识别器能用的语言（第一次用时查一次）
    static var useDictation = true
    private var dictationLocales: [String]?

    /// 一句话说完，实时的中文没认出指令：用苹果的新版识别器按中文、英文各认一遍（macOS 26+）；更老的系统用旧识别器按英文认一遍
    private func runPost(_ utter: Int, _ buffers: [AVAudioPCMBuffer]) {
        var dictation = false
        if #available(macOS 26.0, *), Voice.useDictation { dictation = true }
        if dictation, !buffers.isEmpty {
            postBusy = true
            let locales = Voice.locales
            Task { @MainActor in
                var texts: [String] = []
                if utter == self.utterID, !self.utteranceHandled, #available(macOS 26.0, *) {
                    if self.dictationLocales == nil {
                        self.dictationLocales = await Dictation.installed(locales)
                        log("语音指令：说完后用苹果新版识别器补认（\(self.dictationLocales!.joined(separator: " + "))）")
                    }
                    for loc in self.dictationLocales ?? [] {
                        let hints = (loc.hasPrefix("zh") ? VoiceGrammar.hints : VoiceGrammar.hintsEnglish) + VoiceGrammar.hintsLabels + (VoiceGrammar.labelsActive ? VoiceGrammar.hintsDigits : [])
                        let cands = await Dictation.transcribe(buffers, locale: loc, hints: hints)
                        self.count(loc, cands)
                        if let f = cands.first { texts.append(f) }
                        self.heard(cands, utter: utter, live: false)
                        if utter != self.utterID || self.utteranceHandled { break }
                    }
                }
                self.postBusy = false
                self.finish(utter, english: texts.joined(separator: " / "))
                // 补认是在说完之后，开口前那 0.6 秒只剩这句话的尾巴，不再喂给实时任务
                if self.running, !self.speaking { self.newTask(preroll: false) }
            }
            return
        }
        let recs = post
        guard !recs.isEmpty, !buffers.isEmpty else { return finish(utter, english: nil) }
        postBusy = true
        var pending = recs.count
        var texts: [String] = []
        var done = false
        let complete = { [weak self] in
            guard let self, !done else { return }
            done = true
            self.postBusy = false
            self.finish(utter, english: texts.joined(separator: " / "))
            if self.running, !self.speaking { self.newTask(preroll: false) }
        }
        for rec in recs {
            let r = SFSpeechAudioBufferRecognitionRequest()
            r.shouldReportPartialResults = false
            r.contextualStrings = VoiceGrammar.hintsEnglish
            if let cfg = CommandModel.config(for: Voice.key(rec)) { r.customizedLanguageModel = cfg }
            if rec.supportsOnDeviceRecognition { r.requiresOnDeviceRecognition = true }
            for b in buffers { r.append(b) }
            r.endAudio()
            let task = rec.recognitionTask(with: r) { [weak self] result, error in
                guard let self else { return }
                self.count(rec, result, error)
                if let error, ![216, 301, 1110].contains((error as NSError).code) {
                    log("语音识别出错（\(rec.locale.identifier)）：\(error.localizedDescription)")
                }
                guard error != nil || result?.isFinal == true else { return }
                let cands = Voice.candidates(result)
                DispatchQueue.main.async {
                    if let first = cands.first { texts.append(first); self.heard(cands, utter: utter, live: false) }
                    pending -= 1
                    if pending == 0 { complete() }
                }
            }
            // 兜底：3 秒还没结果就算了
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { task.cancel(); complete() }
        }
    }

    /// 这句话的识别都结束了：没认出指令就在日志里说一声
    private func finish(_ utter: Int, english: String?) {
        guard utter == utterID, !utteranceHandled else { return }
        let heardText = [lastText, english ?? ""].filter { !$0.isEmpty }.joined(separator: " / ")
        if heardText.isEmpty {
            log(String(format: "有人说话（%.1f 秒，%.0f dB，底噪 %.0f dB），但没识别出文字", utterDur, peakDb, floorDb))
        } else {
            log("听到“\(heardText)”，不是指令")
        }
    }

    /// live：实时中文任务的结果，只要是当前任务、还没认出过指令就算（没检测到开口也认）；
    /// 否则是说完后英文认的，只算这句话、且这句话还没认出过指令
    /// 识别器给出的几个候选（最可能的在前），去掉重复
    static func candidates(_ result: SFSpeechRecognitionResult?) -> [String] {
        guard let result else { return [] }
        var out: [String] = []
        for t in [result.bestTranscription] + result.transcriptions {
            let s = t.formattedString
            if !s.isEmpty, !out.contains(s) { out.append(s) }
        }
        return out
    }

    static func key(_ rec: SFSpeechRecognizer) -> String { rec.locale.identifier.replacingOccurrences(of: "_", with: "-") }

    /// candidates：同一段话的几个候选说法，最可能的在前。第一个能认成指令的算数
    private func heard(_ candidates: [String], utter: Int, live: Bool) {
        guard running, let text = candidates.first else { return }
        // 一句话只执行一条指令：实时结果在同一句话里认出过指令就不再算（换了新任务也一样），说完后的补认同理
        if live { guard !handled, !(speaking && utteranceHandled) else { return }; lastText = text } else { guard utter == utterID, !utteranceHandled else { return } }
        onText?(text)
        guard let (c, text) = candidates.lazy.compactMap({ t in VoiceGrammar.parse(t).map { ($0, t) } }).first else { return }
        handled = true
        utteranceHandled = true
        onCommand?(c, text)
        if !postBusy { newTask(preroll: false) } // 换个新任务，同一句话不会再触发一次
    }

    /// 音量检测在音频线程里跑，结果切回主线程
    private func detect(_ buffer: AVAudioPCMBuffer) {
        guard let ch = buffer.floatChannelData?[0] else { return }
        let n = Int(buffer.frameLength)
        var sum: Float = 0
        for i in 0..<n { sum += ch[i] * ch[i] }
        let db = 10 * log10(max(sum / Float(max(n, 1)), 1e-10))
        let dur = Double(n) / buffer.format.sampleRate
        recentLock.lock()
        stat.maxDb = max(stat.maxDb, db)
        recentLock.unlock()
        DispatchQueue.main.async { self.level(db, dur) }
    }

    private var loudDur = 0.0
    private var levels: [(Float, Double)] = []
    private var levelsDur = 0.0

    private func level(_ db: Float, _ dur: Double) {
        // 底噪：最近 4 秒里最安静的那一成。说话声不会把它抬高（话与话之间总有空隙），环境变吵了 4 秒内跟上。
        // 全零的数字静音（切换麦克风的一瞬间）不算：否则底噪掉到 -90 多，之后正常的环境声都被当成有人说话
        if db > -90 {
            levels.append((db, dur))
            levelsDur += dur
            while levelsDur > 4, levels.count > 1 { levelsDur -= levels.removeFirst().1 }
            let sorted = levels.map(\.0).sorted()
            floorDb = sorted[min(sorted.count - 1, sorted.count / 10)]
        }
        let loud = db > floorDb + 10 && db > -55
        let now = ProcessInfo.processInfo.systemUptime
        if loud {
            peakDb = speaking ? max(peakDb, db) : db
            loudDur += dur
            quietSince = nil
            if !speaking, loudDur >= 0.12 { beginUtterance() }
        } else {
            loudDur = 0
            if speaking {
                quietSince = quietSince ?? now
                if now - quietSince! > 0.6 { endUtterance() }
            }
        }
        // 指令都很短：一句话超过 6 秒就当说完了，别让一直有声音的环境卡住
        if speaking, utterDur > 6 { endUtterance() }
    }

    private func beginUtterance() {
        speaking = true
        stat.speech += 1
        utterID += 1
        utteranceHandled = false
        lastText = ""
        recentLock.lock()
        utterBuf = recent
        utterDur = recent.reduce(0) { $0 + Double($1.frameLength) / $1.format.sampleRate }
        recording = true
        recentLock.unlock()
        newTask() // 每句话一个新任务
        onSpeech?(true)
    }

    private func endUtterance() {
        speaking = false
        quietSince = nil
        loudDur = 0
        recentLock.lock()
        recording = false
        let buffers = utterBuf
        utterBuf = []
        recentLock.unlock()
        onSpeech?(false)
        onUtterance?(buffers)
        guard !utteranceHandled else { return }
        // 中文这句先收尾（给出最终结果），再让英文认
        requests.forEach { $0.endAudio() }
        let utter = utterID
        if post.isEmpty {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in self?.finish(utter, english: nil) }
        } else {
            runPost(utter, buffers)
        }
    }

    static func copy(_ b: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let c = AVAudioPCMBuffer(pcmFormat: b.format, frameCapacity: b.frameLength) else { return nil }
        c.frameLength = b.frameLength
        let n = Int(b.frameLength)
        if let src = b.floatChannelData, let dst = c.floatChannelData {
            for ch in 0..<Int(b.format.channelCount) { dst[ch].update(from: src[ch], count: n) }
        } else if let src = b.int16ChannelData, let dst = c.int16ChannelData {
            for ch in 0..<Int(b.format.channelCount) { dst[ch].update(from: src[ch], count: n) }
        } else { return nil }
        return c
    }

    /// Mac 自带的麦克风
    static func builtInMic() -> (AudioDeviceID, String)? {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return nil }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return nil }
        for id in ids {
            var t: UInt32 = 0
            var ts = UInt32(MemoryLayout<UInt32>.size)
            var ta = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyTransportType, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            guard AudioObjectGetPropertyData(id, &ta, 0, nil, &ts, &t) == noErr, t == kAudioDeviceTransportTypeBuiltIn else { continue }
            var sa = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
            var ss: UInt32 = 0
            guard AudioObjectGetPropertyDataSize(id, &sa, 0, nil, &ss) == noErr, ss > 0 else { continue }
            var name: CFString = "" as CFString
            var ns = UInt32(MemoryLayout<CFString>.size)
            var na = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            _ = withUnsafeMutablePointer(to: &name) { AudioObjectGetPropertyData(id, &na, 0, nil, &ns, $0) }
            return (id, name as String)
        }
        return nil
    }
}

// MARK: - 桥

final class Bridge: NSObject, CMHeadphoneMotionManagerDelegate {
    private let options: Options
    private let motion = CMHeadphoneMotionManager()
    private let session = URLSession(configuration: .default)
    private var socket: URLSessionWebSocketTask?
    private var connected = false
    private var reconnecting = false
    private var silent: SilentAudio?
    private var headphonesConnected = false
    private var lastRestart = Date.distantPast
    private var lastRate: Double = 0
    /// 正在控制鼠标的网页。好几个网页同时开着时，只听它的，否则几个网页各算各的光标，光标会在它们之间来回跳
    private var controlOwner: String?
    private let overlay = Overlay()
    private let mouse = MouseControl()
    private let voice = Voice()
    private let targets = TargetScanner()
    private let highlight = Highlight()
    private let labels = Labels()
    private var voiceWanted = false
    private var voiceBuiltIn = true
    private var displays = Display.all()
    private var lastOverlayAt = Date.distantPast

    // 头部数据在自己的线程上收、在自己的线程上发，不经过主线程。主线程要和 WindowServer 同步打交道
    // （收系统事件、叠加层、移动光标），系统负载高时 WindowServer 很忙，主线程一卡就是一两秒甚至更久；
    // 头部数据以前也排在主线程上，跟着一起卡，网页上就是光标不动、耳机像断了一样
    private let motionQueue: OperationQueue = {
        let q = OperationQueue()
        q.name = "nodlink.motion"
        q.maxConcurrentOperationCount = 1
        q.qualityOfService = .userInteractive
        return q
    }()
    /// 下面这些统计和 outSocket 两个线程都会碰，读写都要拿这把锁
    private let statLock = NSLock()
    /// 连上中继后才有；姿态线程直接用它发数据
    private var outSocket: URLSessionWebSocketTask?
    private var sawMotion = false

    // 每秒统计一次
    private var samples = 0
    private var sent = 0
    private var firstT: TimeInterval?
    private var lastT: TimeInterval?
    private var last: CMDeviceMotion?
    private var quietSeconds = 0

    init(options: Options) {
        self.options = options
    }

    func start() {
        log("NodLinkBridge 启动，中继地址：\(options.url.absoluteString)")
        log("显示器：" + displays.map { "\($0.name) \(Int($0.bounds.width))×\(Int($0.bounds.height)) @(\(Int($0.bounds.minX)),\(Int($0.bounds.minY)))\($0.isMain ? " 主" : "")" }.joined(separator: "；"))
        log("运动权限状态：\(describe(CMHeadphoneMotionManager.authorizationStatus()))")
        guard motion.isDeviceMotionAvailable else {
            log("这台 Mac 不支持读取耳机姿态（isDeviceMotionAvailable = false），需要 macOS 14 或更新版本。")
            exit(1)
        }
        if options.silentAudio {
            silent = SilentAudio()
            silent?.start()
        }
        motion.delegate = self
        mouse.onStopped = { [weak self] in
            self?.highlight.show(nil)
            self?.hideLabels()
            self?.sendControlState()
            self?.syncVoice()
        }
        mouse.onPhysical = { [weak self] kind in self?.reportPhysical(kind) }
        targets.onTargets = { [weak self] json in self?.sendJSON(json) }
        voice.onSpeech = { [weak self] on in self?.sendJSON(["type": "voice", "phase": on ? "start" : "end"]) }
        voice.onCommand = { [weak self] c, text in
            log("语音指令：\(text) → \(c.id)\(c.key.map { " \($0)" } ?? "")\(c.mods.isEmpty ? "" : " +" + c.mods.joined(separator: "+"))\(c.hold ? "（按住）" : "")")
            self?.sendJSON(c.json.merging(["type": "voice", "phase": "command", "text": text]) { a, _ in a })
        }
        voice.onText = { [weak self] text in self?.sendJSON(["type": "voice", "phase": "text", "text": text]) }
        voice.onState = { [weak self] st in self?.sendJSON(st.merging(["type": "voice", "phase": "state"]) { a, _ in a }) }
        // 120 Hz 平滑播放光标
        let glide = Timer(timeInterval: 1.0 / 120, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.mouse.tick(displays: self.displays)
        }
        RunLoop.main.add(glide, forMode: .common)
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.displays = Display.all()
            log("显示器布局已变化")
            self.sendDisplays()
        }
        connect()
        startMotion()
        log("已开始读取。戴上 AirPods 并把它设为这台 Mac 的声音输出；如果一直没有数据，试试播放音乐，或加 --silent-audio。")
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.report() }
        // 接管鼠标时，把系统光标位置回报给调试台
        Timer.scheduledTimer(withTimeInterval: 1.0 / 20, repeats: true) { [weak self] _ in
            guard let self, self.mouse.enabled else { return }
            let p = self.mouse.location
            self.send(String(format: "{\"type\":\"cursorPos\",\"x\":%.1f,\"y\":%.1f}", p.x, p.y))
        }
        // 调试台断开或卡住时，叠加层不能一直挡着屏幕，按住的左键也不能一直不松
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.mouse.checkHold()
            if self.mouse.refreshTrust() { self.sendControlState() }
            guard self.overlay.isOn, Date().timeIntervalSince(self.lastOverlayAt) > 3 else { return }
            log("3 秒没有收到叠加层指令，自动关闭叠加层")
            self.overlay.hide()
        }
    }

    // MARK: 姿态

    private func startMotion() {
        motion.startDeviceMotionUpdates(to: motionQueue) { [weak self] m, error in
            if let error {
                log("读取姿态出错：\(error.localizedDescription)")
                return
            }
            if let m { self?.handle(m) }
        }
    }

    /// 重新开始读取：耳机连着却一直没数据时，重开一次常常就好了
    private func restartMotion(_ why: String) {
        lastRestart = Date()
        motion.stopDeviceMotionUpdates()
        startMotion()
        log("重新开始读取耳机姿态（\(why)）")
    }

    /// 每秒告诉网页耳机的状况：连没连上、有没有数据、声音从哪儿出
    private func sendHeadphones(streaming: Bool) {
        var j: [String: Any] = ["type": "headphones", "connected": headphonesConnected, "streaming": streaming,
                                "rate": (lastRate * 10).rounded() / 10, "quiet": quietSeconds, "silentAudio": silent?.playing ?? false]
        if let out = defaultOutputName() { j["output"] = out }
        sendJSON(j)
    }

    /// 在姿态线程上运行，别碰主线程的状态
    private func handle(_ m: CMDeviceMotion) {
        statLock.lock()
        let first = !sawMotion
        sawMotion = true
        samples += 1
        if firstT == nil { firstT = m.timestamp }
        lastT = m.timestamp
        last = m
        let sock = outSocket
        if sock != nil { sent += 1 }
        statLock.unlock()
        // 有数据就是连着的（启动时已经连着，可能收不到“连上”通知）
        if first { DispatchQueue.main.async { self.headphonesConnected = true } }
        let a = m.attitude
        let q = a.quaternion
        let r = m.rotationRate
        let u = m.userAcceleration
        let json = String(
            format: "{\"type\":\"motion\",\"t\":%.6f,\"yaw\":%.6f,\"pitch\":%.6f,\"roll\":%.6f,\"q\":[%.6f,%.6f,%.6f,%.6f],\"rr\":[%.5f,%.5f,%.5f],\"acc\":[%.5f,%.5f,%.5f]}",
            m.timestamp, a.yaw, a.pitch, a.roll, q.w, q.x, q.y, q.z, r.x, r.y, r.z, u.x, u.y, u.z
        )
        sock?.send(.string(json)) { [weak self] error in
            guard error != nil else { return }
            DispatchQueue.main.async { self?.scheduleReconnect() }
        }
    }

    private func report() {
        statLock.lock()
        let samples = self.samples, firstT = self.firstT, lastT = self.lastT, last = self.last, sent = self.sent
        self.samples = 0
        self.firstT = nil
        self.sent = 0
        sawMotion = false
        statLock.unlock()
        sendHeadphones(streaming: quietSeconds == 0 && samples > 0)
        let deviceRate: String
        if let f = firstT, let l = lastT, samples > 1, l > f {
            lastRate = Double(samples - 1) / (l - f)
            deviceRate = String(format: "%.1f Hz", lastRate)
        } else {
            deviceRate = "– Hz"
        }
        if samples == 0 {
            quietSeconds += 1
            lastRate = 0
            // 耳机连着却 5 秒没数据：自动重开一次读取（每 30 秒最多一次）
            if headphonesConnected, quietSeconds >= 5, Date().timeIntervalSince(lastRestart) > 30 { restartMotion("连着却没有数据") }
            if quietSeconds == 3 || quietSeconds % 10 == 0 {
                log("\(quietSeconds) 秒没有收到姿态数据。检查：AirPods 是否戴好、是否是这台 Mac 的声音输出；是否已允许运动权限。")
            }
        } else {
            quietSeconds = 0
            let a = last!.attitude
            let deg = 180 / Double.pi
            let st = mouse.takeStat()
            let ctl = mouse.enabled
                ? String(format: " · 正在控制鼠标：移动 %d 次，最大一步 %.0f 点，播放延迟 %.0f ms%@", st.moves, st.maxStep, mouse.playDelay * 1000, st.starve > 0 ? "，缺数据 \(st.starve) 次" : "")
                : ""
            log(String(format: "%@ · yaw %6.1f° pitch %6.1f° roll %6.1f° · 中继%@ · 已发送 %d%@",
                       deviceRate, a.yaw * deg, a.pitch * deg, a.roll * deg, connected ? "已连接" : "未连接", sent, ctl))
        }
    }

    func headphoneMotionManagerDidConnect(_ manager: CMHeadphoneMotionManager) {
        headphonesConnected = true
        log("耳机已连接")
        send(#"{"type":"event","name":"headphonesConnected"}"#)
    }

    func headphoneMotionManagerDidDisconnect(_ manager: CMHeadphoneMotionManager) {
        headphonesConnected = false
        log("耳机已断开")
        send(#"{"type":"event","name":"headphonesDisconnected"}"#)
    }

    // MARK: 调试台指令

    private func handleCommand(_ text: String) {
        guard let data = text.data(using: .utf8),
              let m = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = m["type"] as? String else { return }
        // 控制类指令只听正在控制的那个网页
        let page = m["page"] as? String
        if ["cursor", "button", "key", "scroll", "zoom", "probe", "highlight", "cue", "voice", "window", "labels"].contains(type),
           mouse.enabled, let owner = controlOwner, page != owner { return }
        switch type {
        case "overlay":
            lastOverlayAt = Date()
            if m["on"] as? Bool == false {
                overlay.hide()
            } else {
                let t = (m["target"] as? [String: Double]).flatMap { d in d["x"].flatMap { x in d["y"].map { CGPoint(x: x, y: $0) } } }
                overlay.update(target: t, label: m["label"] as? String ?? "", progress: m["progress"] as? Double)
            }
        case "cursor":
            let ts = m["ts"] as? Double
            if let x = m["x"] as? Double, let y = m["y"] as? Double {
                if let ts { mouse.queue(absolute: CGPoint(x: x, y: y), delta: nil, ts: ts) } else {
                    // 不带 ts 的是“跳到这里”（歪头确认时拉回起点）：没播完的先丢掉
                    mouse.flush()
                    mouse.move(to: CGPoint(x: x, y: y), displays: displays)
                }
            } else if let dx = m["dx"] as? Double, let dy = m["dy"] as? Double {
                if let ts { mouse.queue(absolute: nil, delta: CGPoint(x: dx, y: dy), ts: ts) } else { mouse.move(by: CGPoint(x: dx, y: dy), displays: displays) }
            }
        case "scroll":
            mouse.scroll(m["dy"] as? Double ?? 0)
        case "zoom":
            // ⌘= 放大、⌘- 缩小：浏览器、预览、大多数文档 App 都认
            mouse.key(m["dir"] as? String == "out" ? 27 : 24, flags: .maskCommand)
        case "voice":
            voiceWanted = m["enabled"] as? Bool ?? false
            voiceBuiltIn = m["mic"] as? String != "default"
            if voice.active { voice.stop() }
            syncVoice()
        case "button":
            let at = (m["x"] as? Double).flatMap { x in (m["y"] as? Double).map { CGPoint(x: x, y: $0) } }
            mouse.button(m["button"] as? String ?? "left", action: m["action"] as? String ?? "click",
                         count: m["count"] as? Int ?? 1, at: at, mods: m["mods"] as? [String] ?? [], displays: displays)
        case "key":
            if m["action"] as? String == "releaseAll" {
                mouse.releaseKeys()
            } else if let name = m["key"] as? String {
                mouse.sendKey(name, mods: m["mods"] as? [String] ?? [], action: m["action"] as? String ?? "press")
            }
        case "probe":
            // 网页每 100 ms 报一次头部落点（全局坐标），这里读出附近的可点元素
            if mouse.enabled, let x = m["x"] as? Double, let y = m["y"] as? Double {
                if m["fresh"] as? Bool == true { targets.invalidate() }
                targets.probe(CGPoint(x: x, y: y), displays: displays)
            }
        case "point":
            // “正在指向”：只读，不动鼠标，所以不限于正在控制的那个网页
            if let x = m["x"] as? Double, let y = m["y"] as? Double { targets.point(CGPoint(x: x, y: y)) }
        case "highlight":
            if mouse.enabled, let x = m["x"] as? Double, let y = m["y"] as? Double, let w = m["w"] as? Double, let h = m["h"] as? Double {
                highlight.show(CGRect(x: x, y: y, width: w, height: h))
            } else {
                highlight.show(nil)
            }
        case "cue":
            if mouse.enabled, let name = m["name"] as? String { Cue.play(name) }
        case "window":
            guard mouse.enabled, mouse.trusted, let action = m["action"] as? String else { return }
            let at = (m["x"] as? Double).flatMap { x in (m["y"] as? Double).map { CGPoint(x: x, y: $0) } }
            if !WindowAction.perform(action, at: at), let (k, mods) = ["close": ("w", ["cmd"]), "minimize": ("m", ["cmd"]), "fullscreen": ("f", ["ctrl", "cmd"])][action] {
                log("没找到窗口按钮，改按快捷键（\(action)）")
                mouse.sendKey(k, mods: mods, action: "press")
            }
        case "labels":
            let items = (m["items"] as? [[String: Any]] ?? []).compactMap { d -> Labels.Item? in
                guard let n = d["n"] as? Int, let x = d["x"] as? Double, let y = d["y"] as? Double, let w = d["w"] as? Double, let h = d["h"] as? Double else { return nil }
                return Labels.Item(n: n, rect: CGRect(x: x, y: y, width: w, height: h))
            }
            if mouse.enabled, !items.isEmpty {
                labels.show(items)
                VoiceGrammar.labelsActive = true
            } else {
                hideLabels()
            }
        case "control":
            let on = m["enabled"] as? Bool ?? false
            // 交还只认正在控制的网页；接管谁都可以（新网页接管后，旧网页就不再能动光标）
            if !on, mouse.enabled, let owner = controlOwner, page != owner { sendControlState(); return }
            if on {
                if controlOwner != page, mouse.enabled { log("换成另一个网页控制鼠标") }
                controlOwner = page
            }
            if let ms = m["yieldMs"] as? Double { mouse.yieldSeconds = ms / 1000 }
            mouse.setEnabled(on)
            if !mouse.enabled {
                highlight.show(nil)
                hideLabels()
            }
            sendControlState()
            syncVoice()
        case "motionRestart":
            restartMotion("网页要求")
        case "silentAudio":
            if m["on"] as? Bool == true {
                silent = silent ?? SilentAudio()
                silent?.start()
            } else {
                silent?.stop()
            }
            sendHeadphones(streaming: quietSeconds == 0 && lastRate > 0)
        case "openSettings":
            // 打开系统设置里对应的页面，方便连耳机、切声音输出
            let pane = m["pane"] as? String == "sound" ? "com.apple.Sound-Settings.extension" : "com.apple.BluetoothSettings"
            if let url = URL(string: "x-apple.systempreferences:\(pane)") { NSWorkspace.shared.open(url) }
        case "hello":
            // 调试台刚连上：把显示器和控制状态告诉它
            sendDisplays()
            sendControlState()
            sendHeadphones(streaming: quietSeconds == 0 && lastRate > 0)
        default:
            break
        }
    }

    private func sendDisplays() {
        let payload: [String: Any] = ["type": "displays", "displays": displays.map(\.json)]
        if let data = try? JSONSerialization.data(withJSONObject: payload), let text = String(data: data, encoding: .utf8) {
            send(text)
        }
    }

    /// 告诉网页真实键鼠动了。鼠标移动很密，同一类每 100 ms 最多报一次
    private var lastReported: [String: Date] = [:]
    private func reportPhysical(_ kind: String) {
        let now = Date()
        if let t = lastReported[kind], now.timeIntervalSince(t) < 0.1 { return }
        lastReported[kind] = now
        send("{\"type\":\"input\",\"kind\":\"\(kind)\"}")
    }

    /// 只在接管鼠标、并且网页打开了语音指令时听
    private func hideLabels() {
        labels.show([])
        VoiceGrammar.labelsActive = false
    }

    private func syncVoice() {
        let want = voiceWanted && mouse.enabled
        if want, !voice.active { voice.start(builtIn: voiceBuiltIn) }
        if !want, voice.active { voice.stop() }
    }

    private func sendJSON(_ obj: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: obj), let text = String(data: data, encoding: .utf8) { send(text) }
    }

    private func sendControlState() {
        var j: [String: Any] = ["type": "control", "enabled": mouse.enabled, "trusted": mouse.trusted]
        if mouse.enabled, let owner = controlOwner { j["owner"] = owner }
        sendJSON(j)
    }

    // MARK: 中继连接

    private func connect() {
        reconnecting = false
        let task = session.webSocketTask(with: options.url)
        socket = task
        task.resume()
        let host = "Mac" // 不发电脑的名字（常带着用户名），中继对局域网开放
        let os = ProcessInfo.processInfo.operatingSystemVersionString
        let hello = "{\"type\":\"hello\",\"device\":\"\(escape(host))\",\"os\":\"macOS \(escape(os))\",\"app\":\"NodLinkBridge\",\"silentAudio\":\(options.silentAudio)}"
        task.send(.string(hello)) { [weak self] error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let error {
                    log("连不上中继：\(error.localizedDescription)。中继启动了吗？（web 目录下 npm start）2 秒后重试")
                    self.scheduleReconnect()
                } else {
                    log("已连接中继")
                    self.connected = true
                    self.statLock.withLock { self.outSocket = task }
                    self.sendDisplays()
                    self.sendControlState()
                    if self.options.silentAudio { self.send(#"{"type":"event","name":"silentAudioOn"}"#) }
                    self.receive(task)
                }
            }
        }
    }

    /// 接收调试台经中继转发来的指令；收不到时说明连接断了
    private func receive(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, task === self.socket else { return }
                switch result {
                case .failure:
                    log("与中继的连接断开，2 秒后重连")
                    self.overlay.hide()
                    self.highlight.show(nil)
                    self.mouse.release()
                    self.mouse.releaseKeys()
                    self.scheduleReconnect()
                case .success(let message):
                    if case .string(let text) = message { self.handleCommand(text) }
                    self.receive(task)
                }
            }
        }
    }

    private func send(_ text: String, counted: Bool = false) {
        guard connected, let socket else { return }
        socket.send(.string(text)) { [weak self] error in
            guard error != nil else { return }
            DispatchQueue.main.async { self?.scheduleReconnect() }
        }
    }

    private func scheduleReconnect() {
        connected = false
        statLock.withLock { outSocket = nil }
        guard !reconnecting else { return }
        reconnecting = true
        socket?.cancel(with: .goingAway, reason: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.connect() }
    }

    private func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    }

    private func describe(_ status: CMAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "尚未询问（开始读取时系统会弹窗）"
        case .restricted: return "受限制"
        case .denied: return "已拒绝（到 系统设置 → 隐私与安全性 → 运动与健身 里打开）"
        case .authorized: return "已允许"
        @unknown default: return "未知"
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // 不在程序坞显示图标
if let i = CommandLine.arguments.firstIndex(of: "--lm-weight"), i + 1 < CommandLine.arguments.count, let w = Double(CommandLine.arguments[i + 1]) { CommandModel.weight = w }
if CommandLine.arguments.contains("--no-lm") { CommandModel.enabled = false }
if CommandLine.arguments.contains("--old-post") { Voice.useDictation = false }
var voiceTester: Voice?
let bridge: Bridge?
if let i = CommandLine.arguments.firstIndex(of: "--voice-test"), i + 1 < CommandLine.arguments.count {
    // 自测语音识别：./run.sh --voice-test 录音.aiff，只跑识别，不连中继、不读耳机
    bridge = nil
    let v = Voice()
    voiceTester = v
    v.onCommand = { c, text in log("自测：\(text) → \(c.id)\(c.key.map { " \($0)" } ?? "")\(c.mods.isEmpty ? "" : " +" + c.mods.joined(separator: "+"))\(c.hold ? "（按住）" : "")") }
    let files = CommandLine.arguments[(i + 1)...].prefix { !$0.hasPrefix("--") }.map { URL(fileURLWithPath: $0) }
    v.test(files: files) { log("自测结束"); exit(0) }
} else if CommandLine.arguments.contains("--voice-record") {
    // 录真人语音做基准：./run.sh --voice-record，按终端里的提示一句一句念，每句存成一个 WAV，
    // 文件名带上应该认成的指令，之后用 --voice-test 喂回去打分。录音只存在本机
    bridge = nil
    let prompts: [(String, String)] = [
        ("下滑", "scrollDown"), ("上滑", "scrollUp"), ("放大", "zoomIn"), ("缩小", "zoomOut"), ("点击", "left"), ("双击", "double"),
        ("大小写", "key-capslock"), ("关闭窗口", "window-close"), ("标号", "labels"),
        ("down", "scrollDown"), ("up", "scrollUp"), ("scroll down", "scrollDown"), ("scroll up", "scrollUp"), ("click", "left"),
        ("caps lock", "key-capslock"), ("delete", "key-delete"),
    ]
    let rounds = 3
    let list = (0..<rounds).flatMap { _ in prompts }
    let stamp = ISO8601DateFormatter().string(from: Date()).prefix(19).replacingOccurrences(of: ":", with: "")
    let dir = URL(fileURLWithPath: NSHomeDirectory() + "/Library/Application Support/NodLink/recordings/" + stamp)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    var k = 0
    func ask() {
        guard k < list.count else {
            log("录完了，共 \(list.count) 句，存在：\(dir.path)")
            exit(0)
        }
        log("【\(k + 1)/\(list.count)】请说：\(list[k].0)")
    }
    let v = Voice()
    voiceTester = v
    v.onUtterance = { buffers in
        let dur = buffers.reduce(0) { $0 + Double($1.frameLength) / $1.format.sampleRate }
        guard dur > 1.4, k < list.count else { return } // 前后各带 0.6 秒静音，再短就是噪声
        let (word, expect) = list[k]
        let name = String(format: "%02d__%@__%@.wav", k, expect, word.replacingOccurrences(of: " ", with: "-"))
        do { try Audio.writeWav(buffers, to: dir.appendingPathComponent(name)) } catch { log("存不了：\(error.localizedDescription)") }
        k += 1
        ask()
    }
    v.start(builtIn: !CommandLine.arguments.contains("--default-mic"))
    log("录真人语音：每句念完停一下，听到下一句提示再念。说错了不要紧，录完把那个文件删掉就行")
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { ask() }
} else if let i = CommandLine.arguments.firstIndex(of: "--voice-listen"), i + 1 < CommandLine.arguments.count, let secs = Double(CommandLine.arguments[i + 1]) {
    // 自测麦克风：./run.sh --voice-listen 20，用 Mac 自带麦克风听 20 秒，日志里看能不能听到、认出什么
    bridge = nil
    if let j = CommandLine.arguments.firstIndex(of: "--langs"), j + 1 < CommandLine.arguments.count { Voice.locales = CommandLine.arguments[j + 1].split(separator: ",").map(String.init) }
    let v = Voice()
    voiceTester = v
    v.onCommand = { c, text in log("自测：\(text) → \(c.id)\(c.key.map { " \($0)" } ?? "")") }
    v.onText = { text in log("  识别中：\(text)") }
    v.start(builtIn: !CommandLine.arguments.contains("--default-mic"))
    DispatchQueue.main.asyncAfter(deadline: .now() + secs) { v.stop(); log("自测结束"); exit(0) }
} else {
    bridge = Bridge(options: Options(CommandLine.arguments))
    bridge?.start()
}
signal(SIGINT) { _ in exit(0) }
signal(SIGTERM) { _ in exit(0) }
app.run()
