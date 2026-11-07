// 一句话说完后，用新版识别器（macOS 26 的 SpeechAnalyzer + DictationTranscriber）把这句录音认一遍。
//
// 为什么要它：旧的 SFSpeechRecognizer 认孤立的两字指令很弱，实测“下滑”常常只认出“下”“小”“笑”。
// 用 9 种系统语音、快慢两种语速合成的 54 条指令测：
//   旧识别器（中文实时 + 英文补认）认对 34 条；DictationTranscriber 直接认对 37 条，加上语法里的同音补救约 41 条，
//   每条只要 0.1 秒左右。中英文模型都是系统自带、本机离线的。
// 新版的 SpeechTranscriber 中文模型系统默认没装（要另外下载），所以用 DictationTranscriber。

import AVFoundation
import Foundation
import Speech

@available(macOS 26.0, *)
enum Dictation {
    /// 这台 Mac 上能用的语言（已安装的）
    static func installed(_ locales: [String]) async -> [String] {
        let have = Set(await DictationTranscriber.installedLocales.map { $0.identifier.replacingOccurrences(of: "_", with: "-") })
        return locales.filter { have.contains($0) }
    }

    /// 认一段录音。返回几个候选说法（最可能的在前），没认出就是空
    static func transcribe(_ buffers: [AVAudioPCMBuffer], locale: String, hints: [String]) async -> [String] {
        guard let first = buffers.first else { return [] }
        let module = DictationTranscriber(locale: Locale(identifier: locale), contentHints: [.shortForm],
                                          transcriptionOptions: [], reportingOptions: [.alternativeTranscriptions], attributeOptions: [])
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module], considering: first.format) else { return [] }
        let analyzer = SpeechAnalyzer(modules: [module])
        let ctx = AnalysisContext()
        ctx.contextualStrings[.general] = hints
        try? await analyzer.setContext(ctx)

        let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
        let converter = first.format == format ? nil : AVAudioConverter(from: first.format, to: format)
        for b in buffers {
            if let converter {
                let cap = AVAudioFrameCount(Double(b.frameLength) * format.sampleRate / b.format.sampleRate) + 32
                guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: cap) else { continue }
                var fed = false
                var err: NSError?
                converter.convert(to: out, error: &err) { _, status in
                    if fed { status.pointee = .noDataNow; return nil }
                    fed = true
                    status.pointee = .haveData
                    return b
                }
                if out.frameLength > 0 { input.yield(AnalyzerInput(buffer: out)) }
            } else {
                input.yield(AnalyzerInput(buffer: b))
            }
        }
        input.finish()

        let reader = Task { () -> [String] in
            var best = ""
            var alts: [String] = []
            for try await r in module.results {
                best += String(r.text.characters)
                alts += r.alternatives.map { String($0.characters) }
            }
            var out: [String] = []
            for s in [best] + alts where !s.isEmpty && !out.contains(s) { out.append(s) }
            return out
        }
        do {
            if let end = try await analyzer.analyzeSequence(stream) {
                try await analyzer.finalizeAndFinish(through: end)
            } else {
                await analyzer.cancelAndFinishNow()
            }
        } catch {
            log("语音识别出错（新版 \(locale)）：\(error.localizedDescription)")
            await analyzer.cancelAndFinishNow()
        }
        return (try? await reader.value) ?? []
    }
}
