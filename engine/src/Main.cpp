// yss-engine — 실시간 오디오 사이드카 (Milestone 1)
//   목표: 오디오 디바이스 목록 출력 + 스템 WAV 재생 + 입력 모니터 + 왕복 지연 표시
//   IPC/녹음/VST 는 이후 마일스톤.
//
//   실행: yss-engine.exe [stem.wav]

#include <juce_audio_utils/juce_audio_utils.h>
#include <iostream>

using namespace juce;

// 오디오 콜백: (스템 재생) + (입력 모니터) 를 출력에 믹스
class Engine : public AudioIODeviceCallback
{
public:
    Engine() { formatManager.registerBasicFormats(); }

    bool loadFile (const String& path)
    {
        File f (path);
        if (! f.existsAsFile()) { std::cerr << "[engine] file not found: " << path << "\n"; return false; }
        auto* reader = formatManager.createReaderFor (f);
        if (reader == nullptr) { std::cerr << "[engine] cannot read: " << path << "\n"; return false; }
        readerSource.reset (new AudioFormatReaderSource (reader, true));
        transport.setSource (readerSource.get(), 0, nullptr, reader->sampleRate);
        fileSampleRate = reader->sampleRate;
        return true;
    }

    void play() { transport.setPosition (0.0); transport.setLooping (true); transport.start(); }

    void audioDeviceAboutToStart (AudioIODevice* device) override
    {
        sampleRate = device->getCurrentSampleRate();
        const int block = device->getCurrentBufferSizeSamples();
        transport.prepareToPlay (block, sampleRate);
        temp.setSize (2, block);

        const int inLat  = device->getInputLatencyInSamples();
        const int outLat = device->getOutputLatencyInSamples();
        std::cout << "[engine] device=\"" << device->getName() << "\""
                  << " sr=" << sampleRate << " block=" << block
                  << " inLat=" << inLat << " outLat=" << outLat
                  << " roundtrip=" << String ((inLat + outLat) / sampleRate * 1000.0, 2) << "ms\n";
    }

    void audioDeviceStopped() override { transport.releaseResources(); }

    void audioDeviceIOCallbackWithContext (const float* const* inputs, int numIn,
                                           float* const* outputs, int numOut,
                                           int numSamples,
                                           const AudioIODeviceCallbackContext&) override
    {
        for (int c = 0; c < numOut; ++c)
            FloatVectorOperations::clear (outputs[c], numSamples);

        // 스템 재생
        temp.setSize (2, numSamples, false, false, true);
        temp.clear();
        AudioSourceChannelInfo info (&temp, 0, numSamples);
        transport.getNextAudioBlock (info);
        for (int c = 0; c < numOut; ++c)
            FloatVectorOperations::add (outputs[c],
                                        temp.getReadPointer (jmin (c, temp.getNumChannels() - 1)),
                                        numSamples);

        // 입력 모니터 (헤드폰 전제 — 스피커면 피드백 주의)
        for (int c = 0; c < numOut && numIn > 0; ++c)
        {
            const float* src = inputs[jmin (c, numIn - 1)];
            if (src != nullptr)
                FloatVectorOperations::addWithMultiply (outputs[c], src, monitorGain, numSamples);
        }
    }

    AudioFormatManager formatManager;
    std::unique_ptr<AudioFormatReaderSource> readerSource;
    AudioTransportSource transport;
    AudioBuffer<float> temp;
    double sampleRate = 44100.0, fileSampleRate = 44100.0;
    float monitorGain = 1.0f;
};

int main (int argc, char* argv[])
{
    ScopedJuceInitialiser_GUI juceInit;   // MessageManager (디바이스 관리에 필요)

    AudioDeviceManager dm;
    const String err = dm.initialiseWithDefaultDevices (2, 2);
    if (err.isNotEmpty()) { std::cerr << "[engine] audio init error: " << err << "\n"; return 1; }

    for (auto* type : dm.getAvailableDeviceTypes())
    {
        type->scanForDevices();
        std::cout << "== " << type->getTypeName() << " ==\n"
                  << "  outputs: " << type->getDeviceNames (false).joinIntoString (", ") << "\n"
                  << "  inputs : " << type->getDeviceNames (true).joinIntoString (", ") << "\n";
    }

    Engine engine;
    if (argc > 1 && engine.loadFile (String::fromUTF8 (argv[1])))
        engine.play();

    dm.addAudioCallback (&engine);
    std::cout << "[engine] running — stem playing + input monitored. Press Enter to quit.\n";
    std::cin.get();

    dm.removeAudioCallback (&engine);
    return 0;
}
