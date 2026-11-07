// 语音指令的语法：把一句识别结果（中文、英文或混着说）变成一条指令。
//
// 先切成词：中文转成不带声调的拼音、一个音节一个词（同音字也算，“又见”= 右键），英文按单词切。
// 按整词比对，不按子串：否则英文 up 会误中拼音里的 hu·pa 这类拼接。
// 指令要单独说：整句最多比指令多 3 个词，聊天里顺口说到的不算。
//
// 支持的说法（中英文都行）：
//   鼠标   点击 / click、右键 / right click、双击 / 点两下 / 点赞 / double click、长按 / hold、松开 / release
//   滚动   上滑 / up、下滑 / down；缩放 放大 / zoom in、缩小 / zoom out
//   选文字 从这里 / from here（点一下定起点）、到这里 / to here（按住 Shift 点终点）
//   按键   空格 / space、回车 / enter、删除 / delete、tab、esc、上下左右箭头 / up arrow …
//          字母和数字前面加 key：key m、key 5；字母也可以用 NATO 字母表（key mike）
//          组合键：command c、ctrl shift delete、shift tab、fn delete
//          大小写 / caps lock（切换大小写锁定）、fn（单独按一下）、F1～F12（f5、f 5、f five）
//          长按某个键：长按空格 / hold space / hold shift，说“松开 / release”一起放开
//   快捷   全选 / select all、复制 / copy、粘贴 / paste、剪切 / cut、撤销 / undo、重做 / redo
//   窗口   关闭窗口 / close window、最小化 / minimize、全屏 / full screen（按头指的那个窗口自己的红黄绿按钮）
//   标号   标号 / show numbers：头指的地方附近的可点元素标上 1～9；说数字（三、3、three、三号、number 3）就点它；
//          隐藏标号 / hide numbers、取消 收起。数字只在标号亮着时才算指令，平时说“一”“吧”不会误触发
//   其他   暂停 / pause、继续 / resume、回中 / center

import Foundation

struct VoiceCommand: Equatable {
    var id: String
    var key: String? = nil
    var mods: [String] = []
    var hold = false

    var json: [String: Any] {
        var j: [String: Any] = ["command": id]
        if let key { j["key"] = key }
        if !mods.isEmpty { j["mods"] = mods }
        if hold { j["hold"] = true }
        return j
    }
}

enum VoiceGrammar {
    /// 一句话切成词：中文一个音节一个词，英文一个单词一个词，都是小写
    static func tokens(_ text: String) -> [String] {
        var out: [String] = []
        var latin = ""
        var han = ""
        func flushLatin() {
            if !latin.isEmpty { out.append(latin.lowercased()); latin = "" }
        }
        func flushHan() {
            guard !han.isEmpty else { return }
            let m = NSMutableString(string: han)
            CFStringTransform(m, nil, kCFStringTransformMandarinLatin, false)
            CFStringTransform(m, nil, kCFStringTransformStripDiacritics, false)
            out += (m as String).lowercased().split(whereSeparator: { !$0.isLetter }).map(String.init)
            han = ""
        }
        for ch in text {
            if ch.isASCII, ch.isLetter || ch.isNumber {
                flushHan()
                latin.append(ch)
            } else if ch.isLetter {
                flushLatin()
                han.append(ch)
            } else {
                flushLatin()
                flushHan()
            }
        }
        flushLatin()
        flushHan()
        return out
    }

    typealias Phrase = [String]
    private static func p(_ s: String) -> Phrase { s.split(separator: " ").map(String.init) }

    static let modifiers: [String: String] = [
        "command": "cmd", "cmd": "cmd", "control": "ctrl", "ctrl": "ctrl", "shift": "shift", "option": "alt", "alt": "alt",
        "fn": "fn", "function": "fn",
    ]

    /// 有名字的键：不用加 key 就能说
    static let namedKeys: [(Phrase, String)] = fnKeys + [
        (p("caps lock"), "capslock"), (p("capslock"), "capslock"), (p("caps"), "capslock"),
        (p("qie huan da xiao xie"), "capslock"), (p("da xiao xie"), "capslock"), (p("da xie suo ding"), "capslock"), (p("da xie"), "capslock"),
        (p("up arrow"), "up"), (p("arrow up"), "up"), (p("down arrow"), "down"), (p("arrow down"), "down"),
        (p("left arrow"), "left"), (p("arrow left"), "left"), (p("right arrow"), "right"), (p("arrow right"), "right"),
        (p("shang jian tou"), "up"), (p("xia jian tou"), "down"), (p("zuo jian tou"), "left"), (p("you jian tou"), "right"),
        (p("page up"), "pageup"), (p("page down"), "pagedown"), (p("forward delete"), "forwarddelete"),
        (p("space"), "space"), (p("kong ge"), "space"), (p("enter"), "return"), (p("return"), "return"), (p("hui che"), "return"),
        (p("delete"), "delete"), (p("backspace"), "delete"), (p("shan chu"), "delete"), (p("tui ge"), "delete"),
        (p("tab"), "tab"), (p("escape"), "escape"), (p("esc"), "escape"), (p("qu xiao"), "escape"),
        // home、end 不收：“end here” 会被当成按 End 键
    ]

    /// F1～F12：识别器会写成 F5、F 5 或 F five。长的写法排前面
    static let fnKeys: [(Phrase, String)] = {
        let words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"]
        var out: [(Phrase, String)] = []
        for n in stride(from: 12, through: 1, by: -1) {
            out += [([("f\(n)")], "f\(n)"), (["f", "\(n)"], "f\(n)"), (["f", words[n - 1]], "f\(n)")]
        }
        return out
    }()

    static let nato: [String: String] = [
        "alpha": "a", "alfa": "a", "bravo": "b", "charlie": "c", "delta": "d", "echo": "e", "foxtrot": "f", "golf": "g",
        "hotel": "h", "india": "i", "juliet": "j", "juliett": "j", "kilo": "k", "lima": "l", "mike": "m", "november": "n",
        "oscar": "o", "papa": "p", "quebec": "q", "romeo": "r", "sierra": "s", "tango": "t", "uniform": "u", "victor": "v",
        "whiskey": "w", "xray": "x", "yankee": "y", "zulu": "z",
        "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
    ]

    /// 快捷操作：直接对应组合键
    static let shortcuts: [(Phrase, String, [String])] = [
        (p("select all"), "a", ["cmd"]), (p("quan xuan"), "a", ["cmd"]),
        (p("copy"), "c", ["cmd"]), (p("fu zhi"), "c", ["cmd"]),
        (p("paste"), "v", ["cmd"]), (p("zhan tie"), "v", ["cmd"]),
        (p("cut"), "x", ["cmd"]), (p("jian qie"), "x", ["cmd"]),
        (p("undo"), "z", ["cmd"]), (p("che xiao"), "z", ["cmd"]),
        (p("redo"), "z", ["cmd", "shift"]), (p("zhong zuo"), "z", ["cmd", "shift"]),
    ]

    /// 窗口按钮：按头指的那个窗口的关闭、最小化、全屏（耳机桥用辅助功能接口按，找不到再发快捷键）
    static let windowActions: [(Phrase, String)] = [
        (p("close window"), "close"), (p("guan bi chuang kou"), "close"), (p("guan chuang kou"), "close"),
        (p("minimize"), "minimize"), (p("minimise"), "minimize"), (p("zui xiao hua"), "minimize"),
        (p("exit full screen"), "fullscreen"), (p("full screen"), "fullscreen"), (p("fullscreen"), "fullscreen"),
        (p("tui chu quan ping"), "fullscreen"), (p("quan ping"), "fullscreen"),
    ]

    /// 标号：亮出 / 收起。“取消标号”要先于“取消”（Esc）比
    static let labelActions: [(Phrase, String)] = [
        (p("yin cang biao hao"), "labelsOff"), (p("guan bi biao hao"), "labelsOff"), (p("qu xiao biao hao"), "labelsOff"),
        (p("tui chu biao hao"), "labelsOff"), (p("shou qi biao hao"), "labelsOff"), // “退出标号”“收起标号”：以前落到下面的“标号”，反而又亮一遍
        (p("yin cang bian hao"), "labelsOff"), (p("hide numbers"), "labelsOff"), (p("hide labels"), "labelsOff"),
        (p("xian shi biao hao"), "labels"), (p("biao hao"), "labels"), (p("xian shi bian hao"), "labels"), (p("bian hao"), "labels"),
        (p("show numbers"), "labels"), (p("show number"), "labels"), (p("show labels"), "labels"), (p("numbers"), "labels"),
    ]

    /// 标号亮着吗（网页亮出标号时耳机桥设成 true）。只有亮着时，单说一个数字才算“点这个标号”
    static var labelsActive = false
    static let digitWords: [String: Int] = [
        "yi": 1, "er": 2, "liang": 2, "san": 3, "si": 4, "wu": 5, "liu": 6, "qi": 7, "ba": 8, "jiu": 9,
        "one": 1, "two": 2, "to": 2, "too": 2, "three": 3, "four": 4, "for": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
        "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
    ]
    /// 点第几个标号：三、3、三号、第三个、点三、点击三、number three、click three
    static func label(_ t: [String]) -> VoiceCommand? {
        var w = t
        for pre in [["dian", "ji"], ["dian"], ["number"], ["click"], ["di"], ["hao"]] where w.count > pre.count && Array(w.prefix(pre.count)) == pre {
            w.removeFirst(pre.count)
            break
        }
        if w.count > 1, ["hao", "ge"].contains(w.last!) { w.removeLast() }
        guard w.count == 1, let n = digitWords[w[0]] else { return nil }
        return VoiceCommand(id: "label", key: String(n))
    }

    /// 鼠标和其他指令。同一位置先比长的（right click 先于 click，up arrow 已在按键里先比过）
    static let actions: [(Phrase, String)] = [
        (p("double click"), "double"), (p("double tap"), "double"), (p("shuang ji"), "double"),
        (p("dian zan"), "double"), (p("dian liang xia"), "double"), // 点赞、点两下：刷视频时双击画面就是点赞
        (p("right click"), "right"), (p("you jian"), "right"), (p("you ji"), "right"),
        (p("left click"), "left"), (p("click"), "left"), (p("zuo jian"), "left"), (p("zuo ji"), "left"), (p("dian ji"), "left"),
        (p("dan ji"), "left"), (p("dian yi xia"), "left"),
        (p("from here"), "selectFrom"), (p("start here"), "selectFrom"), (p("cong zhe li"), "selectFrom"), (p("cong zhe"), "selectFrom"),
        (p("to here"), "selectTo"), (p("end here"), "selectTo"), (p("dao zhe li"), "selectTo"), (p("dao zhe"), "selectTo"),
        (p("let go"), "release"), (p("release"), "release"), (p("drop"), "release"),
        (p("song kai"), "release"), (p("fang kai"), "release"), (p("song shou"), "release"),
        (p("chang an"), "hold"), (p("zhang an"), "hold"), (p("an zhu"), "hold"), (p("tuo dong"), "hold"), (p("hold"), "hold"), (p("drag"), "hold"), (p("press"), "hold"),
        (p("scroll up"), "scrollUp"), (p("up"), "scrollUp"), (p("shang hua"), "scrollUp"), (p("xiang shang"), "scrollUp"), (p("wang shang"), "scrollUp"),
        (p("scroll down"), "scrollDown"), (p("down"), "scrollDown"), (p("xia hua"), "scrollDown"), (p("xiang xia"), "scrollDown"), (p("wang xia"), "scrollDown"),
        (p("zoom in"), "zoomIn"), (p("fang da"), "zoomIn"), (p("zoom out"), "zoomOut"), (p("suo xiao"), "zoomOut"),
        (p("pause"), "pause"), (p("zan ting"), "pause"), (p("resume"), "resume"), (p("continue"), "resume"), (p("ji xu"), "resume"),
        (p("recenter"), "recenter"), (p("center"), "recenter"), (p("hui zhong"), "recenter"), (p("ju zhong"), "recenter"),
    ]

    /// 识别器的提示词，提高这些词的识别率
    static let hints = ["点击", "左键", "右键", "双击", "点赞", "点两下", "上滑", "下滑", "往上", "往下", "放大", "缩小", "长按", "按住", "拖动", "松开", "松手",
                        "暂停", "继续", "回中", "从这里", "到这里", "空格", "回车", "删除", "全选", "复制", "粘贴", "撤销", "大小写"]
    static let hintsLabels = ["关闭窗口", "最小化", "全屏", "标号", "隐藏标号", "close window", "minimize", "full screen", "show numbers"]
    static let hintsDigits = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
    static let hintsEnglish = ["click", "right click", "double click", "double tap", "up", "down", "zoom in", "zoom out", "hold", "release",
                               "from here", "to here", "space", "enter", "delete", "tab", "escape", "key", "command", "control",
                               "shift", "option", "copy", "paste", "undo", "select all", "pause", "resume", "center", "caps lock", "fn"]

    /// “长”是多音字，拼音转换常给成 zhang
    static let holdWords = [p("chang an"), p("zhang an"), p("an zhu"), p("hold"), p("press and hold")]

    private static func starts(_ t: [String], _ i: Int, _ ph: Phrase) -> Bool {
        i + ph.count <= t.count && Array(t[i..<i + ph.count]) == ph
    }

    /// 从第 i 个词开始读一个键：有名字的键、key + 字母/数字、或（跟在修饰键后面时）单个字母/数字
    private static func readKey(_ t: [String], _ i: Int, bare: Bool) -> (String, Int)? {
        for (ph, k) in namedKeys where starts(t, i, ph) { return (k, ph.count) }
        func single(_ w: String) -> String? {
            if w.count == 1, let c = w.first, c.isLetter || c.isNumber { return w }
            return nato[w]
        }
        if i < t.count, t[i] == "key" || t[i] == "jian" || t[i] == "an", i + 1 < t.count, let k = single(t[i + 1]) { return (k, 2) }
        if bare, i < t.count, let k = single(t[i]) { return (k, 1) }
        return nil
    }

    /// 从第 i 个词开始读一条指令，返回指令和用掉的词数
    private static func read(_ t: [String], _ i: Int) -> (VoiceCommand, Int)? {
        for (ph, id) in labelActions where starts(t, i, ph) { return (VoiceCommand(id: id), ph.count) }
        for (ph, a) in windowActions where starts(t, i, ph) { return (VoiceCommand(id: "window", key: a), ph.count) }
        // 长按某个键：长按空格、hold shift
        for hw in holdWords where starts(t, i, hw) {
            var j = i + hw.count
            var mods: [String] = []
            while j < t.count, let m = modifiers[t[j]] { mods.append(m); j += 1 }
            if let (k, n) = readKey(t, j, bare: !mods.isEmpty) {
                return (VoiceCommand(id: "key", key: k, mods: mods, hold: true), j + n - i)
            }
            if mods.count == 1 { return (VoiceCommand(id: "key", key: mods[0], hold: true), j - i) } // hold shift
        }
        // press + 键：按一下（press 单独说是长按鼠标）
        if starts(t, i, ["press"]), let (k, n) = readKey(t, i + 1, bare: false) {
            return (VoiceCommand(id: "key", key: k), n + 1)
        }
        // 修饰键 + 键：command c、ctrl shift delete
        var j = i
        var mods: [String] = []
        while j < t.count, let m = modifiers[t[j]] { mods.append(m); j += 1 }
        if !mods.isEmpty, let (k, n) = readKey(t, j, bare: true) {
            return (VoiceCommand(id: "key", key: k, mods: mods), j + n - i)
        }
        if mods == ["fn"] { return (VoiceCommand(id: "key", key: "fn"), j - i) } // 单独说 fn
        // 单个键：空格、key m、up arrow（先于 up 滚动）；后面跟着“长按”就是按住：Space 长按
        if let (k, n) = readKey(t, i, bare: false) {
            if let hw = holdWords.first(where: { starts(t, i + n, $0) }) { return (VoiceCommand(id: "key", key: k, hold: true), n + hw.count) }
            return (VoiceCommand(id: "key", key: k), n)
        }
        for (ph, k, m) in shortcuts where starts(t, i, ph) { return (VoiceCommand(id: "key", key: k, mods: m), ph.count) }
        for (ph, id) in actions where starts(t, i, ph) { return (VoiceCommand(id: id), ph.count) }
        return nil
    }

    /// 一句话里找指令。指令要单独说：整句最多比指令多 3 个词
    /// 很短、聊天里常出现的英文词：必须单独说才算。
    /// 实测英文识别器常把中文听成“Shut up”“Find up”之类，不加这条就会误执行上滑
    static let bareOnly: Set<String> = ["up", "down", "drop", "press", "center", "continue", "caps", "cut", "hold", "drag", "release", "copy", "paste", "function"]

    /// 整句只有一个字时的补救：实测“下滑”“上滑”常常只认出第一个字
    static let solo: [String: String] = ["xia": "scrollDown", "shang": "scrollUp"]
    /// 整句就是这几个词时的同音补救（新版识别器实测：“放大”常认成“放假”，“大小写”认成“大小姐”）。
    /// 只在整句只有这个词时才算，聊天里说“明天放假”不会触发
    static let soloPhrases: [Phrase: VoiceCommand] = [
        ["fang", "jia"]: VoiceCommand(id: "zoomIn"),
        ["da", "xiao", "jie"]: VoiceCommand(id: "key", key: "capslock"),
    ]

    static func parse(_ text: String) -> VoiceCommand? {
        let t = tokens(text)
        if labelsActive, let c = label(t) { return c }
        if t.count == 1, let id = solo[t[0]] { return VoiceCommand(id: id) }
        if let c = soloPhrases[t] { return c }
        for i in t.indices {
            if let (c, n) = read(t, i) {
                if n == 1, bareOnly.contains(t[i]), t.count > 1 { return nil }
                return t.count <= n + 3 ? c : nil
            }
        }
        return nil
    }
}
