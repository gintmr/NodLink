// 指令的自定义语言模型：告诉识别器“这里说的基本都是这些短语”，让它往指令上靠。
//
// 只给提示词（contextualStrings）时，偏向很弱：实测“下滑”常被认成“下”“夏”“笑”，英文识别器把它听成 Saha、Sha Hua。
// 自定义语言模型（SFCustomLanguageModelData，macOS 14+，要求本机识别）把这些短语按次数加进语言模型里，
// macOS 26 起还能设权重：权重越高越往指令上靠，但随口聊天也越容易被认成指令。
// 第一次启动时编译，之后缓存在 ~/Library/Caches/io.github.nodlink.bridge/lm/，短语表改了才重编。

import Foundation
import Speech

enum LMDir {
    static var url: URL = {
        if let d = ProcessInfo.processInfo.environment["NODLINK_LM_DIR"] { return URL(fileURLWithPath: d) }
        return FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("io.github.nodlink.bridge/lm", isDirectory: true)
    }()
}

enum CommandModel {
    static var weight = 0.6
    static var enabled = true

    /// 中文指令短语（汉字原文，和 VoiceGrammar 里的拼音对应）
    static let zh: [String] = {
        var p = ["点击", "单击", "点一下", "左键", "右键", "双击", "点两下", "点赞", "长按", "按住", "拖动", "松开", "放开", "松手",
                 "上滑", "下滑", "往上滑", "往下滑", "向上", "向下", "往上", "往下", "放大", "缩小", "暂停", "继续", "回中", "居中",
                 "从这里", "到这里", "空格", "长按空格", "回车", "删除", "退格", "取消", "全选", "复制", "粘贴", "剪切",
                 "撤销", "重做", "上箭头", "下箭头", "左箭头", "右箭头", "大小写", "切换大小写", "大写锁定"]
        p += ["上滑", "下滑", "上滑", "下滑"] // 最常用，权重加倍
        return p
    }()

    /// 英文指令短语
    static let en: [String] = {
        var p = ["click", "left click", "right click", "double click", "double tap", "hold", "press and hold", "drag", "release", "let go", "drop",
                 "up", "down", "scroll up", "scroll down", "zoom in", "zoom out", "pause", "resume", "continue", "center", "recenter",
                 "from here", "to here", "start here", "end here", "space", "hold space", "enter", "return", "delete", "backspace",
                 "tab", "escape", "up arrow", "down arrow", "left arrow", "right arrow", "page up", "page down",
                 "select all", "copy", "paste", "cut", "undo", "redo", "caps lock", "fn", "function", "hold shift", "hold fn",
                 "shift tab", "command tab", "ctrl shift delete"]
        p += ["up", "down", "scroll up", "scroll down", "click"]
        let letters = "abcdefghijklmnopqrstuvwxyz".map(String.init)
        for l in letters { p += ["key \(l)", "command \(l)"] }
        for d in 0...9 { p.append("key \(d)") }
        for n in 1...12 { p.append("f\(n)") }
        return p
    }()

    private static var configs: [String: SFSpeechLanguageModel.Configuration] = [:]
    private static let lock = NSLock()

    static func ready(_ locales: [String]) -> Bool {
        lock.withLock { locales.allSatisfy { configs[$0] != nil } }
    }

    static func config(for locale: String) -> SFSpeechLanguageModel.Configuration? {
        lock.lock(); defer { lock.unlock() }
        return enabled ? configs[locale] : nil
    }

    private static var started = false

    /// 编译两个语言的模型（已缓存就很快），好了以后新的识别任务自动用上
    static func prepareOnce(_ locales: [String]) {
        lock.lock()
        let first = !started
        started = true
        lock.unlock()
        guard enabled, first else { return }
        for locale in locales {
            let phrases = locale.hasPrefix("zh") ? zh : en
            Task.detached {
                do {
                    let cfg = try await build(locale: locale, phrases: phrases)
                    lock.withLock { configs[locale] = cfg }
                    log("语音指令：\(locale) 指令语言模型已就绪（权重 \(weight)）")
                } catch {
                    let e = error as NSError
                    log("语音指令：\(locale) 指令语言模型编译失败（\(e.domain) \(e.code)：\(e.localizedDescription) \(e.userInfo)），只用提示词")
                }
            }
        }
    }

    private static func build(locale: String, phrases: [String]) async throws -> SFSpeechLanguageModel.Configuration {
        let dir = LMDir.url
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // 短语表变了，版本号就变，系统会重编
        // 版本号要是普通的“主.次”格式，带别的字符会编译失败（实测）。短语表变了，次版本号跟着变
        let version = "1.\(phrases.joined(separator: "|").unicodeScalars.reduce(UInt32(5381)) { ($0 &* 33) ^ $1.value } % 100000)"
        let asset = dir.appendingPathComponent("\(locale).bin")
        let lm = dir.appendingPathComponent("\(locale).lm")
        let vocab = dir.appendingPathComponent("\(locale).vocab")
        var counts: [String: Int] = [:]
        for p in phrases { counts[p, default: 0] += 100 }
        let data = SFCustomLanguageModelData(locale: Locale(identifier: locale), identifier: "io.github.nodlink.commands.\(locale)", version: version) {
            SFCustomLanguageModelData.PhraseCount(phrase: phrases[0], count: 1)
        }
        for (p, c) in counts.sorted(by: { $0.key < $1.key }) { data.insert(phraseCount: .init(phrase: p, count: c)) }
        try await data.export(to: asset)
        let cfg: SFSpeechLanguageModel.Configuration
        if #available(macOS 26.0, *) {
            cfg = SFSpeechLanguageModel.Configuration(languageModel: lm, vocabulary: vocab, weight: NSNumber(value: weight))
        } else {
            cfg = SFSpeechLanguageModel.Configuration(languageModel: lm, vocabulary: vocab)
        }
        do {
            try await SFSpeechLanguageModel.prepareCustomLanguageModel(for: asset, configuration: cfg, ignoresCache: true)
        } catch {
            log("语音指令：\(locale) 新接口编译失败（\(error)），换旧接口再试")
            try await SFSpeechLanguageModel.prepareCustomLanguageModel(for: asset, clientIdentifier: "io.github.nodlink.bridge", configuration: cfg, ignoresCache: true)
        }
        return cfg
    }
}
