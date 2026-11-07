// 录音格式转换：录下的语音指令存成 16 kHz 单声道 WAV（./run.sh --voice-record 采集测试样本时用）

import AVFoundation
import Foundation

enum Audio {
    static let format16k = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!

    static func mono16k(_ buffers: [AVAudioPCMBuffer]) -> AVAudioPCMBuffer? {
        guard let src = buffers.first?.format, let converter = AVAudioConverter(from: src, to: format16k) else { return nil }
        let total = buffers.reduce(0) { $0 + Int($1.frameLength) }
        guard let dst = AVAudioPCMBuffer(pcmFormat: format16k, frameCapacity: AVAudioFrameCount(Double(total) * 16000 / src.sampleRate) + 1024) else { return nil }
        var i = 0
        var err: NSError?
        let status = converter.convert(to: dst, error: &err) { _, st in
            guard i < buffers.count else {
                st.pointee = .endOfStream
                return nil
            }
            st.pointee = .haveData
            defer { i += 1 }
            return buffers[i]
        }
        return status == .error ? nil : dst
    }

    /// 存成 16 kHz 单声道 32 位 float 的 WAV（和自测用的合成语音同一种格式）
    static func writeWav(_ buffers: [AVAudioPCMBuffer], to url: URL) throws {
        guard let b = mono16k(buffers) else { return }
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1,
                                       AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false]
        let f = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        try f.write(from: b)
    }
}
