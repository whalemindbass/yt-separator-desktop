// yss-engine — 실시간 오디오 사이드카 (Milestone 2)
//   멀티 스템 재생 + 트랜스포트 + 입력 모니터 + 1트랙 녹음 + PDC(지연 보정)
//   조작(stdin): p=play  s=stop  r=arm&record  x=stop record  z=seek0  q=quit
//   실행: yss-engine.exe stem1.wav [stem2.wav ...]
//   녹음 결과: take.wav (+ timelineStart 로그)

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <atomic>
#include <iostream>
#include <vector>

using namespace juce;

struct Stem
{
    std::unique_ptr<AudioFormatReaderSource> src;
    String name;
    float gain = 1.0f;
};

class Engine : public AudioIODeviceCallback
{
public:
    Engine() : writerThread ("rec") { fmt.registerBasicFormats(); }
    ~Engine() override { finishRecording(); }

    bool addStem (const String& path)
    {
        File f (path);
        auto* r = fmt.createReaderFor (f);
        if (r == nullptr) { std::cerr << "[engine] cannot read " << path << "\n"; return false; }
        auto s = std::make_unique<Stem>();
        s->name = f.getFileNameWithoutExtension();
        s->src  = std::make_unique<AudioFormatReaderSource> (r, true);
        stemSampleRate = r->sampleRate;
        stems.push_back (std::move (s));
        return true;
    }

    // ---- 트랜스포트 ----
    void play()  { playing = true;  std::cout << "[engine] play @" << playhead.load() << "\n"; }
    void stop()  { playing = false; std::cout << "[engine] stop @" << playhead.load() << "\n"; }
    void seek0() { setPos (0); std::cout << "[engine] seek 0\n"; }

    void setPos (int64 p)
    {
        playhead = p;
        for (auto& s : stems) s->src->setNextReadPosition (p);
    }

    // ---- 녹음 ----
    void armRecord (const File& out)
    {
        finishRecording();
        outFile = out;
        auto* dev = currentDevice;
        if (dev == nullptr) { std::cerr << "[engine] no device\n"; return; }

        std::unique_ptr<FileOutputStream> os (out.createOutputStream());
        if (os == nullptr) { std::cerr << "[engine] cannot open " << out.getFullPathName() << "\n"; return; }

        WavAudioFormat wav;
        auto* w = wav.createWriterFor (os.get(), deviceSampleRate,
                                       (unsigned int) jmax (1, numInputChans), 24, {}, 0);
        if (w == nullptr) { std::cerr << "[engine] writer create failed\n"; return; }
        os.release();

        threadedWriter.reset (new AudioFormatWriter::ThreadedWriter (w, writerThread, 32768));
        activeWriter.store (threadedWriter.get());
        recordArmed = true;
        recordedStart = -1;
        std::cout << "[engine] armed (rec on next play block)\n";
    }

    void stopRecord() { finishRecording(); }

    // ---- VST3 호스팅 ----
    void scanPlugins()
    {
        if (pluginFmt.getNumFormats() == 0) addDefaultFormatsToManager (pluginFmt);
        scanned.clear();
        VST3PluginFormat vst3;
        const auto paths = vst3.getDefaultLocationsToSearch();
        Array<File> files;
        for (int i = 0; i < paths.getNumPaths(); ++i)
            paths[i].findChildFiles (files, File::findFilesAndDirectories, true, "*.vst3");

        for (auto& f : files)
        {
            OwnedArray<PluginDescription> found;
            vst3.findAllTypesForFile (found, f.getFullPathName());
            for (auto* d : found) scanned.add (*d);
        }
        std::cout << "[engine] " << scanned.size() << " VST3 plugins:\n";
        for (int i = 0; i < scanned.size(); ++i)
            std::cout << "  [" << i << "] " << scanned[i].name << " (" << scanned[i].manufacturerName << ")\n";
    }

    void loadPlugin (int index)
    {
        if (index < 0 || index >= scanned.size()) { std::cerr << "[engine] bad index\n"; return; }
        if (pluginFmt.getNumFormats() == 0) addDefaultFormatsToManager (pluginFmt);
        String err;
        auto inst = pluginFmt.createPluginInstance (scanned[index], deviceSampleRate, blockSize, err);
        if (inst == nullptr) { std::cerr << "[engine] load failed: " << err << "\n"; return; }
        inst->setPlayConfigDetails (2, 2, deviceSampleRate, blockSize);
        inst->prepareToPlay (deviceSampleRate, blockSize);
        activeFx.store (nullptr);        // 콜백에서 옛 인스턴스 사용 중단
        fx = std::move (inst);
        activeFx.store (fx.get());
        std::cout << "[engine] loaded FX: " << scanned[index].name << "\n";
    }

    // ---- 오디오 콜백 ----
    void audioDeviceAboutToStart (AudioIODevice* device) override
    {
        currentDevice = device;
        deviceSampleRate = device->getCurrentSampleRate();
        const int block = device->getCurrentBufferSizeSamples();
        blockSize = block;
        numInputChans  = device->getActiveInputChannels().countNumberOfSetBits();
        numOutputChans = device->getActiveOutputChannels().countNumberOfSetBits();
        inLatSamp  = device->getInputLatencyInSamples();
        outLatSamp = device->getOutputLatencyInSamples();

        for (auto& s : stems) s->src->prepareToPlay (block, deviceSampleRate);
        scratch.setSize (2, block);
        writerThread.startThread();

        if (! approximatelyEqual (stemSampleRate, deviceSampleRate))
            std::cout << "[engine] WARN stem SR " << stemSampleRate
                      << " != device SR " << deviceSampleRate << " (no resample yet)\n";

        std::cout << "[engine] device=\"" << device->getName() << "\" sr=" << deviceSampleRate
                  << " block=" << block << " in=" << numInputChans << " out=" << numOutputChans
                  << " roundtrip=" << String ((inLatSamp + outLatSamp) / deviceSampleRate * 1000.0, 2) << "ms\n";
    }

    void audioDeviceStopped() override
    {
        finishRecording();
        for (auto& s : stems) s->src->releaseResources();
        writerThread.stopThread (500);
        currentDevice = nullptr;
    }

    void audioDeviceIOCallbackWithContext (const float* const* inputs, int numIn,
                                           float* const* outputs, int numOut,
                                           int numSamples,
                                           const AudioIODeviceCallbackContext&) override
    {
        for (int c = 0; c < numOut; ++c)
            FloatVectorOperations::clear (outputs[c], numSamples);

        // 스템 믹스 (재생 중)
        if (playing.load())
        {
            for (auto& s : stems)
            {
                scratch.setSize (2, numSamples, false, false, true);
                scratch.clear();
                AudioSourceChannelInfo info (&scratch, 0, numSamples);
                s->src->getNextAudioBlock (info);
                for (int c = 0; c < numOut; ++c)
                    FloatVectorOperations::addWithMultiply (
                        outputs[c], scratch.getReadPointer (jmin (c, scratch.getNumChannels() - 1)),
                        s->gain, numSamples);
            }
            playhead.fetch_add (numSamples);
        }

        // 입력 모니터 — VST3 FX 체인 통과 (헤드폰 전제)
        if (numIn > 0)
        {
            fxBuf.setSize (jmax (2, numOutputChans), numSamples, false, false, true);
            for (int c = 0; c < fxBuf.getNumChannels(); ++c)
                fxBuf.copyFrom (c, 0, inputs[jmin (c, numIn - 1)], numSamples);

            if (auto* p = activeFx.load())
            {
                MidiBuffer mm;
                p->processBlock (fxBuf, mm);
            }
            for (int c = 0; c < numOut; ++c)
                FloatVectorOperations::addWithMultiply (
                    outputs[c], fxBuf.getReadPointer (jmin (c, fxBuf.getNumChannels() - 1)), monitorGain, numSamples);
        }

        // 녹음
        if (recordArmed.load())
        {
            if (recordedStart.load() < 0 && playing.load())
                recordedStart = playhead.load();   // 첫 재생 블록에서 시작점 확정

            if (recordedStart.load() >= 0)
                if (auto* w = activeWriter.load())
                    w->write (inputs, numSamples);
        }
    }

private:
    void finishRecording()
    {
        if (! recordArmed.exchange (false) && threadedWriter == nullptr) return;
        activeWriter.store (nullptr);
        threadedWriter.reset();   // flush + close
        const int64 start = recordedStart.exchange (-1);
        if (start >= 0)
        {
            const int64 comp = inLatSamp + outLatSamp;                 // 왕복 지연 = PDC
            const int64 timelineStart = jmax<int64> (0, start - comp); // 테이크를 앞당겨 정렬
            std::cout << "[engine] take=" << outFile.getFullPathName()
                      << " startPlayhead=" << start
                      << " roundtripComp=" << comp
                      << " timelineStart=" << timelineStart << "\n";
        }
    }

    AudioFormatManager fmt;
    std::vector<std::unique_ptr<Stem>> stems;
    AudioBuffer<float> scratch;

    AudioIODevice* currentDevice = nullptr;
    double deviceSampleRate = 44100.0, stemSampleRate = 44100.0;
    int numInputChans = 0, numOutputChans = 0, blockSize = 512;
    int64 inLatSamp = 0, outLatSamp = 0;

    // VST3 FX (입력 체인)
    AudioPluginFormatManager pluginFmt;
    Array<PluginDescription> scanned;
    std::unique_ptr<AudioPluginInstance> fx;
    std::atomic<AudioPluginInstance*> activeFx { nullptr };
    AudioBuffer<float> fxBuf;

    std::atomic<bool>  playing { false };
    std::atomic<int64> playhead { 0 };
    float monitorGain = 1.0f;

    TimeSliceThread writerThread;
    std::unique_ptr<AudioFormatWriter::ThreadedWriter> threadedWriter;
    std::atomic<AudioFormatWriter::ThreadedWriter*> activeWriter { nullptr };
    std::atomic<bool>  recordArmed { false };
    std::atomic<int64> recordedStart { -1 };
    File outFile;
};

int main (int argc, char* argv[])
{
    ScopedJuceInitialiser_GUI juceInit;

    AudioDeviceManager dm;
    const String err = dm.initialiseWithDefaultDevices (2, 2);
    if (err.isNotEmpty()) { std::cerr << "[engine] audio init error: " << err << "\n"; return 1; }

    for (auto* type : dm.getAvailableDeviceTypes())
        if (type->getTypeName() == "ASIO")
        {
            std::cout << "[engine] using ASIO\n";
            dm.setCurrentAudioDeviceType ("ASIO", true);
            break;
        }

    Engine engine;
    for (int i = 1; i < argc; ++i)
        engine.addStem (String::fromUTF8 (argv[i]));

    dm.addAudioCallback (&engine);
    std::cout << "[engine] ready. cmds: p=play s=stop r=rec x=stoprec z=seek0 v=scanVST l<n>=loadFX q=quit\n";

    for (std::string line; std::getline (std::cin, line); )
    {
        if (line.empty()) continue;
        switch (line[0])
        {
            case 'p': engine.play(); break;
            case 's': engine.stop(); break;
            case 'r': engine.armRecord (File::getCurrentWorkingDirectory().getChildFile ("take.wav")); break;
            case 'x': engine.stopRecord(); break;
            case 'z': engine.seek0(); break;
            case 'v': engine.scanPlugins(); break;
            case 'l': engine.loadPlugin (line.size() > 2 ? std::atoi (line.c_str() + 2) : -1); break;
            case 'q': dm.removeAudioCallback (&engine); return 0;
            default:  break;
        }
    }
    dm.removeAudioCallback (&engine);
    return 0;
}
