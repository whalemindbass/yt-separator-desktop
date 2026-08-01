// yss-engine — 실시간 오디오 사이드카 (Electron 연동용 JSON IPC)
//   stdin  : 한 줄당 JSON 명령 { "cmd": "...", ... }
//            loadStems{paths[]} play stop seek{pos} recordArm{file?} recordStop
//            scanPlugins loadFx{index} showEditor quit
//   stdout : 한 줄당 JSON 이벤트 { "ev": "..." }
//            ready device plugins fx stems pos take error
//   stderr : 사람용 진단 로그

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_gui_extra/juce_gui_extra.h>
#include <atomic>
#include <iostream>
#include <thread>
#include <vector>

using namespace juce;

// stdout = JSON 이벤트 채널 (한 줄 1객체). stderr = 진단 로그.
static void emit (const var& v) { std::cout << JSON::toString (v, true) << std::endl; }
static DynamicObject* ev (const char* name)
{
    auto* o = new DynamicObject();
    o->setProperty ("ev", name);
    return o;
}

struct Stem
{
    std::unique_ptr<AudioFormatReaderSource> src;
    String name;
    std::atomic<float> gain { 1.0f };
    std::atomic<bool>  mute { false };
    std::atomic<bool>  solo { false };
};

// 플러그인 에디터를 담는 네이티브 창
class PluginWindow : public DocumentWindow
{
public:
    PluginWindow (AudioProcessorEditor* editor, const String& title)
        : DocumentWindow (title, Colours::black, DocumentWindow::allButtons)
    {
        setUsingNativeTitleBar (true);
        setContentNonOwned (editor, true);   // 에디터는 플러그인(processor)이 소유
        setResizable (editor->isResizable(), false);
        centreWithSize (getWidth(), getHeight());
        setVisible (true);
    }
    void closeButtonPressed() override { setVisible (false); }
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
    void play()  { playing = true;  std::cerr << "[engine] play @" << playhead.load() << "\n"; }
    void stop()  { playing = false; std::cerr << "[engine] stop @" << playhead.load() << "\n"; }
    void seek0() { setPos (0); std::cerr << "[engine] seek 0\n"; }

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
        std::cerr << "[engine] armed (rec on next play block)\n";
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
        Array<var> list;
        for (int i = 0; i < scanned.size(); ++i)
        {
            auto* o = new DynamicObject();
            o->setProperty ("index", i);
            o->setProperty ("name", scanned[i].name);
            o->setProperty ("manufacturer", scanned[i].manufacturerName);
            list.add (var (o));
        }
        auto* r = ev ("plugins");
        r->setProperty ("list", var (list));
        emit (var (r));
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
        editorWindow.reset();            // 옛 에디터 닫기
        activeFx.store (nullptr);        // 콜백에서 옛 인스턴스 사용 중단
        fx = std::move (inst);
        activeFx.store (fx.get());
        auto* o = ev ("fx");
        o->setProperty ("name", scanned[index].name);
        o->setProperty ("hasEditor", fx->hasEditor());
        emit (var (o));
    }

    // ---- 스템 로드 ----
    void loadStems (const StringArray& paths)
    {
        playing = false;
        stems.clear();                       // 정지 상태에서만 (콜백이 stems 미접근)
        for (auto& p : paths) addStem (p);
        if (currentDevice != nullptr)
            for (auto& s : stems) s->src->prepareToPlay (blockSize, deviceSampleRate);
        setPos (0);
        auto* o = ev ("stems");
        o->setProperty ("count", (int) stems.size());
        emit (var (o));
    }

    bool  isPlaying()   const { return playing.load(); }
    int64 getPlayhead() const { return playhead.load(); }

    // 트랙 제어 (index = 스템 순서)
    void setTrack (int index, const var& gain, const var& mute, const var& solo)
    {
        if (index < 0 || index >= (int) stems.size()) return;
        auto& s = *stems[(size_t) index];
        if (! gain.isVoid()) s.gain = (float) (double) gain;
        if (! mute.isVoid()) s.mute = (bool) mute;
        if (! solo.isVoid()) s.solo = (bool) solo;
    }
    void setFxBypass (bool on) { fxBypass = on; }

    // 메시지 스레드에서 호출할 것
    void showEditor()
    {
        if (fx == nullptr) { std::cerr << "[engine] no FX loaded\n"; return; }
        if (! fx->hasEditor()) { std::cerr << "[engine] plugin has no editor\n"; return; }
        if (editorWindow != nullptr) { editorWindow->toFront (true); return; }
        editorWindow.reset (new PluginWindow (fx->createEditorIfNeeded(), fx->getName()));
        std::cerr << "[engine] editor opened\n";
    }

    void closeEditorWindow() { editorWindow.reset(); }

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
            std::cerr << "[engine] WARN stem SR " << stemSampleRate
                      << " != device SR " << deviceSampleRate << " (no resample yet)\n";

        auto* o = ev ("device");
        o->setProperty ("name", device->getName());
        o->setProperty ("sr", deviceSampleRate);
        o->setProperty ("block", block);
        o->setProperty ("in", numInputChans);
        o->setProperty ("out", numOutputChans);
        o->setProperty ("roundtripMs", (inLatSamp + outLatSamp) / deviceSampleRate * 1000.0);
        emit (var (o));
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

        // 스템 믹스 (재생 중) — solo 있으면 solo 만, 아니면 mute 제외
        if (playing.load())
        {
            bool anySolo = false;
            for (auto& s : stems) if (s->solo.load()) { anySolo = true; break; }

            for (auto& s : stems)
            {
                scratch.setSize (2, numSamples, false, false, true);
                scratch.clear();
                AudioSourceChannelInfo info (&scratch, 0, numSamples);
                s->src->getNextAudioBlock (info);   // 위치 유지 위해 항상 읽음

                const bool audible = anySolo ? s->solo.load() : ! s->mute.load();
                if (! audible) continue;
                const float g = s->gain.load();
                for (int c = 0; c < numOut; ++c)
                    FloatVectorOperations::addWithMultiply (
                        outputs[c], scratch.getReadPointer (jmin (c, scratch.getNumChannels() - 1)),
                        g, numSamples);
            }
            playhead.fetch_add (numSamples);
        }

        // 입력 모니터 — VST3 FX 체인 통과 (헤드폰 전제)
        if (numIn > 0)
        {
            fxBuf.setSize (jmax (2, numOutputChans), numSamples, false, false, true);
            for (int c = 0; c < fxBuf.getNumChannels(); ++c)
                fxBuf.copyFrom (c, 0, inputs[jmin (c, numIn - 1)], numSamples);

            if (auto* p = activeFx.load(); p != nullptr && ! fxBypass.load())
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
            auto* o = ev ("take");
            o->setProperty ("file", outFile.getFullPathName());
            o->setProperty ("startPlayhead", start);
            o->setProperty ("roundtripComp", comp);
            o->setProperty ("timelineStart", timelineStart);
            emit (var (o));
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
    std::atomic<bool>  fxBypass { false };
    std::atomic<bool>  recordArmed { false };
    std::atomic<int64> recordedStart { -1 };
    File outFile;

    std::unique_ptr<DocumentWindow> editorWindow;   // message 스레드에서만 접근
};

// 재생 위치를 주기적으로 emit (message 스레드)
class PosTimer : public Timer
{
public:
    explicit PosTimer (Engine& e) : engine (e) {}
    void timerCallback() override
    {
        if (! engine.isPlaying()) return;
        auto* o = ev ("pos");
        o->setProperty ("samples", engine.getPlayhead());
        emit (var (o));
    }
    Engine& engine;
};

// 한 줄 JSON 명령 처리 (message 스레드)
static void dispatch (Engine& engine, const var& c)
{
    const String cmd = c["cmd"].toString();
    if      (cmd == "loadStems")   { StringArray p; for (auto& v : *c["paths"].getArray()) p.add (v.toString()); engine.loadStems (p); }
    else if (cmd == "play")        engine.play();
    else if (cmd == "stop")        engine.stop();
    else if (cmd == "seek")        engine.setPos ((int64) (double) c["pos"]);
    else if (cmd == "recordArm")   engine.armRecord (File (c["file"].toString().isNotEmpty()
                                            ? c["file"].toString()
                                            : File::getCurrentWorkingDirectory().getChildFile ("take.wav").getFullPathName()));
    else if (cmd == "recordStop")  engine.stopRecord();
    else if (cmd == "track")       engine.setTrack ((int) c["index"], c["gain"], c["mute"], c["solo"]);
    else if (cmd == "fxBypass")    engine.setFxBypass ((bool) c["on"]);
    else if (cmd == "scanPlugins") engine.scanPlugins();
    else if (cmd == "loadFx")      engine.loadPlugin ((int) c["index"]);
    else if (cmd == "showEditor")  engine.showEditor();
    else if (cmd == "quit")        MessageManager::getInstance()->stopDispatchLoop();
}

int main (int argc, char* argv[])
{
    ScopedJuceInitialiser_GUI juceInit;

    AudioDeviceManager dm;
    const String err = dm.initialiseWithDefaultDevices (2, 2);
    if (err.isNotEmpty()) { emit (var (ev ("error"))); std::cerr << "audio init: " << err << "\n"; return 1; }

    for (auto* type : dm.getAvailableDeviceTypes())
        if (type->getTypeName() == "ASIO") { dm.setCurrentAudioDeviceType ("ASIO", true); break; }

    Engine engine;
    for (int i = 1; i < argc; ++i)
        engine.addStem (String::fromUTF8 (argv[i]));

    dm.addAudioCallback (&engine);
    PosTimer posTimer (engine);
    posTimer.startTimer (50);       // 20Hz 위치 스트림
    emit (var (ev ("ready")));

    // stdin(JSON) → message 스레드로 마셜링 (플러그인/에디터는 message 스레드 필수)
    std::thread reader ([&]
    {
        for (std::string line; std::getline (std::cin, line); )
        {
            if (line.empty()) continue;
            var c = JSON::parse (String::fromUTF8 (line.c_str()));
            if (! c.isObject()) continue;
            const bool isQuit = c["cmd"].toString() == "quit";
            MessageManager::callAsync ([&engine, c] { dispatch (engine, c); });
            if (isQuit) break;
        }
    });

    MessageManager::getInstance()->runDispatchLoop();

    posTimer.stopTimer();
    if (reader.joinable()) reader.join();
    engine.closeEditorWindow();
    dm.removeAudioCallback (&engine);
    return 0;
}
