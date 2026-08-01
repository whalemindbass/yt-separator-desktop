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
#include <algorithm>
#include <cmath>
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
static var strArr (const StringArray& a) { Array<var> v; for (auto& s : a) v.add (s); return var (v); }
template <typename T> static var numArr (const Array<T>& a) { Array<var> v; for (auto x : a) v.add ((double) x); return var (v); }

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
        setAlwaysOnTop (true);               // 앱 위에 떠 있도록 (플러그인 에디터 표준)
        setVisible (true);
        toFront (true);
    }
    void closeButtonPressed() override { setVisible (false); }
};

// 녹음된 테이크 재생 (타임라인 start 위치부터)
struct TakePlay
{
    std::unique_ptr<AudioFormatReaderSource> src;
    int64 id = 0;      // 안정 식별자 (이동해도 유지)
    int64 start = 0;   // 타임라인 위치 (이동 가능)
    int64 len = 0;
    int   trackId = 0; // 소속 녹음 트랙
};

// 녹음 트랙 (내 녹음 여러 개 — 각각 뮤트/솔로/게인, R 로 녹음 대상 선택)
struct RecTrack
{
    int id = 0;
    std::atomic<float> gain { 1.0f };
    std::atomic<bool>  mute { false };
    std::atomic<bool>  solo { false };
};

// FX 체인 슬롯 (입력 이펙트 여러 개 직렬)
struct FxSlot
{
    std::unique_ptr<AudioPluginInstance> plugin;
    std::unique_ptr<DocumentWindow> editor;
    std::atomic<bool> bypass { false };
    int id = 0;
    int descIndex = -1;
};

class Engine : public AudioIODeviceCallback
{
public:
    Engine() : writerThread ("rec")
    {
        fmt.registerBasicFormats();
        auto t = std::make_unique<RecTrack>();   // 기본 녹음 트랙 1개 (녹음 대상)
        t->id = nextRecId++;
        armedTrack = t->id;
        recTracks.push_back (std::move (t));
    }
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
    void removeTake (int64 id)
    {
        const ScopedLock sl (takesLock);
        takesPlay.erase (std::remove_if (takesPlay.begin(), takesPlay.end(),
                             [id] (auto& t) { return t->id == id; }), takesPlay.end());
    }
    void clearTakes() { const ScopedLock sl (takesLock); takesPlay.clear(); }
    void loadTake (const String& file, int64 start, int trackId)   // 저장된 테이크 파일을 재생 소스로 등록
    {
        File f (file);
        if (auto* reader = fmt.createReaderFor (f))
        {
            auto tp = std::make_unique<TakePlay>();
            tp->src = std::make_unique<AudioFormatReaderSource> (reader, true);
            tp->src->prepareToPlay (blockSize, deviceSampleRate);
            tp->id = start;
            tp->start = start;
            tp->len = reader->lengthInSamples;
            tp->trackId = trackId > 0 ? trackId : armedTrack.load();
            const ScopedLock sl (takesLock);
            takesPlay.push_back (std::move (tp));
        }
    }

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

        StringArray seen;   // 중복 제거 (같은 플러그인 여러 번 반환되는 것 방지)
        for (auto& f : files)
        {
            OwnedArray<PluginDescription> found;
            vst3.findAllTypesForFile (found, f.getFullPathName());
            for (auto* d : found)
            {
                const auto key = d->createIdentifierString();
                if (seen.contains (key)) continue;
                seen.add (key);
                scanned.add (*d);
            }
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

    FxSlot* findSlot (int id)
    {
        for (auto& s : chain) if (s->id == id) return s.get();
        return nullptr;
    }
    void emitChain()
    {
        Array<var> list;
        for (auto& s : chain)
        {
            auto* o = new DynamicObject();
            o->setProperty ("id", s->id);
            o->setProperty ("index", s->descIndex);
            o->setProperty ("name", s->plugin->getName());
            o->setProperty ("hasEditor", s->plugin->hasEditor());
            o->setProperty ("bypass", s->bypass.load());
            list.add (var (o));
        }
        auto* r = ev ("fxChain");
        r->setProperty ("list", var (list));
        emit (var (r));
    }
    void addFx (int index)
    {
        if (index < 0 || index >= scanned.size()) { std::cerr << "[engine] bad index\n"; return; }
        if (pluginFmt.getNumFormats() == 0) addDefaultFormatsToManager (pluginFmt);
        String err;
        auto inst = pluginFmt.createPluginInstance (scanned[index], deviceSampleRate, blockSize, err);
        if (inst == nullptr) { std::cerr << "[engine] load failed: " << err << "\n"; return; }
        inst->setPlayConfigDetails (2, 2, deviceSampleRate, blockSize);
        inst->prepareToPlay (deviceSampleRate, blockSize);
        auto slot = std::make_unique<FxSlot>();
        slot->id = nextSlotId++;
        slot->descIndex = index;
        slot->plugin = std::move (inst);
        {
            const ScopedLock sl (fxLock);
            chain.push_back (std::move (slot));
        }
        emitChain();
    }

    // ---- 스템 로드 ----
    void loadStems (const StringArray& paths)
    {
        playing = false;
        stems.clear();                       // 정지 상태에서만 (콜백이 stems 미접근)
        { const ScopedLock sl (takesLock); takesPlay.clear(); }   // 새 곡 → 이전 테이크 제거
        stemOffset = 0;
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

    // ---- 오디오 디바이스 설정 ----
    void setDeviceManager (AudioDeviceManager* d) { devmgr = d; }
    void listDevices()
    {
        if (devmgr == nullptr) return;
        auto* r = ev ("devices");
        Array<var> typeList;
        for (auto* t : devmgr->getAvailableDeviceTypes())
        {
            t->scanForDevices();
            auto* o = new DynamicObject();
            o->setProperty ("name", t->getTypeName());
            o->setProperty ("outputs", strArr (t->getDeviceNames (false)));
            o->setProperty ("inputs", strArr (t->getDeviceNames (true)));
            typeList.add (var (o));
        }
        r->setProperty ("types", var (typeList));
        r->setProperty ("currentType", devmgr->getCurrentAudioDeviceType());
        AudioDeviceManager::AudioDeviceSetup s; devmgr->getAudioDeviceSetup (s);
        r->setProperty ("output", s.outputDeviceName);
        r->setProperty ("input", s.inputDeviceName);
        r->setProperty ("sampleRate", s.sampleRate);
        r->setProperty ("bufferSize", s.bufferSize);
        if (auto* dev = devmgr->getCurrentAudioDevice())
        {
            r->setProperty ("rates", numArr (dev->getAvailableSampleRates()));
            r->setProperty ("buffers", numArr (dev->getAvailableBufferSizes()));
        }
        emit (var (r));
    }
    void setDevice (const var& c)
    {
        if (devmgr == nullptr) return;
        const String type = c["type"].toString();
        if (type.isNotEmpty() && type != devmgr->getCurrentAudioDeviceType())
            devmgr->setCurrentAudioDeviceType (type, true);
        AudioDeviceManager::AudioDeviceSetup s; devmgr->getAudioDeviceSetup (s);
        if (! c["output"].isVoid())     s.outputDeviceName = c["output"].toString();
        if (! c["input"].isVoid())      s.inputDeviceName  = c["input"].toString();
        if (! c["sampleRate"].isVoid()) s.sampleRate = (double) c["sampleRate"];
        if (! c["bufferSize"].isVoid()) s.bufferSize = (int) c["bufferSize"];
        s.useDefaultInputChannels = true;
        s.useDefaultOutputChannels = true;
        const String err = devmgr->setAudioDeviceSetup (s, true);
        if (err.isNotEmpty()) std::cerr << "[engine] setDevice: " << err << "\n";
        listDevices();
    }

    // ---- 부가: 레벨 미터 · 튜너 · 메트로놈 ----
    void setMetro (bool on, double bpm) { metroOn = on; if (bpm > 20.0) metroBpm = bpm; }
    float inputLevel() { return inPeak.exchange (0.0f); }   // 마지막 peak 읽고 리셋
    double detectPitch()
    {
        const int N = 2048;
        std::vector<float> buf (N);
        {
            const SpinLock::ScopedLockType sl (pitchLock);
            for (int i = 0; i < N; ++i) buf[i] = pitchRing[(pitchW + i) % N];
        }
        double mean = 0; for (float v : buf) mean += v; mean /= N;
        double rms = 0; for (int i = 0; i < N; ++i) { buf[i] -= (float) mean; rms += buf[i] * (double) buf[i]; }
        rms = std::sqrt (rms / N);
        if (rms < 0.004) return 0.0;   // 너무 조용
        const int minLag = (int) (deviceSampleRate / 1000.0);
        const int maxLag = std::min (N - 1, (int) (deviceSampleRate / 60.0));
        double best = 0; int bestLag = -1;
        for (int lag = minLag; lag <= maxLag; ++lag)
        {
            double c = 0; for (int i = 0; i < N - lag; ++i) c += buf[i] * (double) buf[i + lag];
            if (c > best) { best = c; bestLag = lag; }
        }
        return bestLag > 0 ? deviceSampleRate / (double) bestLag : 0.0;
    }

    // 트랙 제어 (index = 스템 순서)
    void setTrack (int index, const var& gain, const var& mute, const var& solo)
    {
        if (index < 0 || index >= (int) stems.size()) return;
        auto& s = *stems[(size_t) index];
        if (! gain.isVoid()) s.gain = (float) (double) gain;
        if (! mute.isVoid()) s.mute = (bool) mute;
        if (! solo.isVoid()) s.solo = (bool) solo;
        recomputeSolos();
    }
    void setMaster (float g)   { masterGain = g; }
    void setMonitor (float g)  { monitorGain = g; }
    void setInputMonitor (bool on) { monitorInputOn = on; }
    void setStemOffset (int64 samples) { stemOffset = samples; }

    // ---- 녹음 트랙 (여러 개) ----
    RecTrack* findRec (int id) { for (auto& t : recTracks) if (t->id == id) return t.get(); return nullptr; }
    void recomputeSolos()   // 오디오 스레드가 락 없이 읽는 솔로 캐시 갱신 (message 스레드)
    {
        bool ss = false; for (auto& s : stems)     if (s->solo.load()) { ss = true; break; }
        bool rs = false; for (auto& t : recTracks) if (t->solo.load()) { rs = true; break; }
        anyStemSolo = ss; anyRecSolo = rs;
    }
    void emitRecTracks()
    {
        Array<var> list;
        for (auto& t : recTracks)
        {
            auto* o = new DynamicObject();
            o->setProperty ("id", t->id);
            o->setProperty ("gain", t->gain.load());
            o->setProperty ("mute", t->mute.load());
            o->setProperty ("solo", t->solo.load());
            o->setProperty ("armed", t->id == armedTrack.load());
            list.add (var (o));
        }
        auto* r = ev ("recTracks");
        r->setProperty ("list", var (list));
        emit (var (r));
    }
    void addRecTrack()
    {
        auto t = std::make_unique<RecTrack>();
        t->id = nextRecId++;
        { const ScopedLock sl (takesLock); recTracks.push_back (std::move (t)); }
        emitRecTracks();
    }
    void removeRecTrack (int id)
    {
        if (recTracks.size() <= 1) return;   // 최소 1개 유지
        {
            const ScopedLock sl (takesLock);
            takesPlay.erase (std::remove_if (takesPlay.begin(), takesPlay.end(),
                                 [id] (auto& t) { return t->trackId == id; }), takesPlay.end());
            recTracks.erase (std::remove_if (recTracks.begin(), recTracks.end(),
                                 [id] (auto& t) { return t->id == id; }), recTracks.end());
        }
        if (armedTrack.load() == id && ! recTracks.empty()) armedTrack = recTracks.front()->id;
        recomputeSolos();
        emitRecTracks();
    }
    void armRec (int id) { if (findRec (id)) { armedTrack = id; emitRecTracks(); } }
    void setRecTrack (int id, const var& gain, const var& mute, const var& solo)
    {
        auto* t = findRec (id);
        if (t == nullptr) return;
        if (! gain.isVoid()) t->gain = (float) (double) gain;
        if (! mute.isVoid()) t->mute = (bool) mute;
        if (! solo.isVoid()) t->solo = (bool) solo;
        recomputeSolos();
    }
    void moveTake (int64 id, int64 newStart)
    {
        const ScopedLock sl (takesLock);
        for (auto& t : takesPlay) if (t->id == id) { t->start = newStart; break; }
    }
    void setBypass (int id, bool on) { if (auto* s = findSlot (id)) { s->bypass = on; emitChain(); } }

    void removeFx (int id)
    {
        if (auto* s = findSlot (id)) s->editor.reset();   // message 스레드
        {
            const ScopedLock sl (fxLock);
            chain.erase (std::remove_if (chain.begin(), chain.end(),
                             [id] (auto& x) { return x->id == id; }), chain.end());
        }
        emitChain();
    }
    void reorderFx (const Array<int>& order)
    {
        {
            const ScopedLock sl (fxLock);
            std::vector<std::unique_ptr<FxSlot>> next;
            for (int id : order)
            {
                auto it = std::find_if (chain.begin(), chain.end(), [id] (auto& x) { return x && x->id == id; });
                if (it != chain.end()) { next.push_back (std::move (*it)); }
            }
            for (auto& x : chain) if (x) next.push_back (std::move (x));   // 누락분 보존
            chain = std::move (next);
        }
        emitChain();
    }
    // VST 세부 설정(노브값) 직렬화 — 슬롯 단위 base64
    void fxSaveState (int id)
    {
        auto* s = findSlot (id);
        if (s == nullptr) return;
        MemoryBlock mb;
        s->plugin->getStateInformation (mb);
        auto* o = ev ("fxState");
        o->setProperty ("id", id);
        o->setProperty ("data", Base64::toBase64 (mb.getData(), mb.getSize()));
        emit (var (o));
    }
    void fxSetState (int id, const String& b64)
    {
        auto* s = findSlot (id);
        if (s == nullptr || b64.isEmpty()) return;
        MemoryOutputStream mo;
        if (Base64::convertFromBase64 (mo, b64))
        {
            const ScopedLock sl (fxLock);
            s->plugin->setStateInformation (mo.getData(), (int) mo.getDataSize());
        }
    }
    void showEditor (int id)
    {
        auto* s = findSlot (id);
        if (s == nullptr || ! s->plugin->hasEditor()) return;
        if (s->editor != nullptr) { s->editor->setVisible (true); s->editor->toFront (true); return; }
        s->editor.reset (new PluginWindow (s->plugin->createEditorIfNeeded(), s->plugin->getName()));
        s->editor->toFront (true);
    }
    void clearChain()
    {
        for (auto& s : chain) if (s) s->editor.reset();
        const ScopedLock sl (fxLock);
        chain.clear();
    }
    // 프리셋 로드 — 체인 전체를 한 번에 재구성(원자적). churn 없이 안전.
    void setChain (const var& list)
    {
        for (auto& s : chain) if (s) s->editor.reset();
        { const ScopedLock sl (fxLock); chain.clear(); }
        if (pluginFmt.getNumFormats() == 0) addDefaultFormatsToManager (pluginFmt);
        if (auto* a = list.getArray())
            for (auto& v : *a)
            {
                const int index = (int) v["index"];
                if (index < 0 || index >= scanned.size()) continue;
                String err;
                auto inst = pluginFmt.createPluginInstance (scanned[index], deviceSampleRate, blockSize, err);
                if (inst == nullptr) continue;
                inst->setPlayConfigDetails (2, 2, deviceSampleRate, blockSize);
                inst->prepareToPlay (deviceSampleRate, blockSize);
                const String data = v["data"].toString();
                if (data.isNotEmpty()) { MemoryOutputStream mo; if (Base64::convertFromBase64 (mo, data)) inst->setStateInformation (mo.getData(), (int) mo.getDataSize()); }
                auto slot = std::make_unique<FxSlot>();
                slot->id = nextSlotId++;
                slot->descIndex = index;
                slot->bypass = (bool) v["bypass"];
                slot->plugin = std::move (inst);
                const ScopedLock sl (fxLock);
                chain.push_back (std::move (slot));
            }
        emitChain();
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
        { const ScopedLock sl (fxLock); for (auto& s : chain) if (s && s->plugin) s->plugin->prepareToPlay (deviceSampleRate, block); }
        scratch.setSize (2, block);
        pitchRing.assign (2048, 0.0f); pitchW = 0;
        if (! writerThread.isThreadRunning()) writerThread.startThread();

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

        const int64 phStart = playhead.load();

        // 스템 믹스 (재생 중) — solo 있으면 solo 만, 아니면 mute 제외
        const bool anySolo = anyStemSolo.load() || anyRecSolo.load();
        if (playing.load())
        {
            const int64 stemPos = jmax<int64> (0, phStart - stemOffset.load());
            for (auto& s : stems)
            {
                scratch.setSize (2, numSamples, false, false, true);
                scratch.clear();
                s->src->setNextReadPosition (stemPos);   // 오프셋 반영
                AudioSourceChannelInfo info (&scratch, 0, numSamples);
                s->src->getNextAudioBlock (info);

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

        // 내 녹음 버스 = (녹음 트랙별) 라이브 입력 + 녹음 테이크 → FX 체인(후처리) → 출력
        {
            fxBuf.setSize (jmax (2, numOutputChans), numSamples, false, false, true);
            fxBuf.clear();

            // 레벨/튜너 분석 (원본 입력 — 모니터/트랙 무관하게 항상)
            if (numIn > 0)
            {
                float pk = 0;
                for (int i = 0; i < numSamples; ++i) { const float a = std::abs (inputs[0][i]); if (a > pk) pk = a; }
                if (pk > inPeak.load()) inPeak.store (pk);
                const SpinLock::ScopedTryLockType sl (pitchLock);
                if (sl.isLocked())
                {
                    const int R = (int) pitchRing.size();
                    for (int i = 0; i < numSamples; ++i) { pitchRing[pitchW] = inputs[0][i]; pitchW = (pitchW + 1) % R; }
                }
            }

            // 녹음 트랙별 합산 (테이크 + armed 트랙의 라이브 입력), 게인/뮤트/솔로 반영
            {
                const ScopedTryLock stl (takesLock);   // recTracks/takesPlay 보호
                if (stl.isLocked())
                {
                    const int armed = armedTrack.load();
                    const bool monOn = monitorInputOn.load();
                    for (auto& rt : recTracks)
                    {
                        const bool audible = anySolo ? rt->solo.load() : ! rt->mute.load();
                        if (! audible) continue;
                        const float g = rt->gain.load();

                        if (playing.load())
                            for (auto& t : takesPlay)
                            {
                                if (t->trackId != rt->id) continue;
                                const int64 pos = phStart - t->start;
                                if (pos < 0 || pos >= t->len) continue;
                                t->src->setNextReadPosition (pos);
                                scratch.setSize (2, numSamples, false, false, true); scratch.clear();
                                AudioSourceChannelInfo info (&scratch, 0, numSamples);
                                t->src->getNextAudioBlock (info);
                                for (int c = 0; c < fxBuf.getNumChannels(); ++c)
                                    fxBuf.addFrom (c, 0, scratch, jmin (c, scratch.getNumChannels() - 1), 0, numSamples, g);
                            }

                        if (rt->id == armed && monOn && numIn > 0)   // armed 트랙만 라이브 입력 모니터
                            for (int c = 0; c < fxBuf.getNumChannels(); ++c)
                                fxBuf.addFrom (c, 0, inputs[jmin (c, numIn - 1)], numSamples, g);
                    }
                }
            }

            // FX 체인 (입력·테이크 모두에 후처리 적용)
            {
                const ScopedTryLock stl (fxLock);
                if (stl.isLocked())
                    for (auto& s : chain)
                        if (s && s->plugin && ! s->bypass.load())
                        {
                            MidiBuffer mm;
                            s->plugin->processBlock (fxBuf, mm);
                        }
            }

            const float mg = monitorGain.load();
            for (int c = 0; c < numOut; ++c)
                FloatVectorOperations::addWithMultiply (
                    outputs[c], fxBuf.getReadPointer (jmin (c, fxBuf.getNumChannels() - 1)), mg, numSamples);
        }

        // 메트로놈 클릭
        if (metroOn.load() && numOut > 0)
        {
            const double interval = 60.0 / metroBpm.load() * deviceSampleRate;
            const int clickLen = (int) (deviceSampleRate * 0.06);
            for (int i = 0; i < numSamples; ++i)
            {
                metroCounter += 1.0;
                if (metroCounter >= interval) { metroCounter -= interval; clickPos = 0; }
                if (clickPos >= 0)
                {
                    const float env = std::exp (-(float) clickPos / ((float) deviceSampleRate * 0.012f));
                    const float s = 0.4f * env * std::sin (2.0f * 3.14159265f * 1000.0f * (float) clickPos / (float) deviceSampleRate);
                    for (int c = 0; c < numOut; ++c) outputs[c][i] += s;
                    if (++clickPos > clickLen) clickPos = -1;
                }
            }
        }

        // 마스터 볼륨 (전체 출력)
        const float master = masterGain.load();
        if (master != 1.0f)
            for (int c = 0; c < numOut; ++c)
                FloatVectorOperations::multiply (outputs[c], master, numSamples);

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

            // 저장된 테이크를 재생 소스로 등록 → 이후 재생 시 그 위치에서 들림
            if (auto* reader = fmt.createReaderFor (outFile))
            {
                auto tp = std::make_unique<TakePlay>();
                tp->src = std::make_unique<AudioFormatReaderSource> (reader, true);
                tp->src->prepareToPlay (blockSize, deviceSampleRate);
                tp->id = timelineStart;
                tp->start = timelineStart;
                tp->len = reader->lengthInSamples;
                tp->trackId = armedTrack.load();
                const ScopedLock sl (takesLock);
                takesPlay.push_back (std::move (tp));
            }

            auto* o = ev ("take");
            o->setProperty ("id", (int64) timelineStart);   // 렌더러 클립 식별용
            o->setProperty ("trackId", armedTrack.load());
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

    // VST3 FX 체인 (입력, 여러 개 직렬)
    AudioPluginFormatManager pluginFmt;
    Array<PluginDescription> scanned;
    std::vector<std::unique_ptr<FxSlot>> chain;
    int nextSlotId = 1;
    CriticalSection fxLock;   // 오디오 스레드의 processBlock 과 체인 변경/setState 를 상호배제
    AudioBuffer<float> fxBuf;

    std::atomic<bool>  playing { false };
    std::atomic<int64> playhead { 0 };
    std::atomic<float> monitorGain { 1.0f };
    std::atomic<float> masterGain { 1.0f };
    std::atomic<bool>  monitorInputOn { true };
    std::atomic<int64> stemOffset { 0 };
    AudioDeviceManager* devmgr = nullptr;

    // 녹음 트랙 (여러 개) + 녹음 대상(armed) + 솔로 캐시(오디오 스레드 락-프리 판독)
    std::vector<std::unique_ptr<RecTrack>> recTracks;
    std::atomic<int>  armedTrack { 0 };
    int nextRecId = 1;
    std::atomic<bool> anyStemSolo { false };
    std::atomic<bool> anyRecSolo  { false };

    // 녹음 테이크 재생
    std::vector<std::unique_ptr<TakePlay>> takesPlay;
    CriticalSection takesLock;

    // 부가: 레벨/튜너/메트로놈
    std::atomic<float> inPeak { 0.0f };
    std::vector<float> pitchRing = std::vector<float> (2048, 0.0f);
    int pitchW = 0;
    SpinLock pitchLock;
    std::atomic<bool> metroOn { false };
    std::atomic<double> metroBpm { 120.0 };
    double metroCounter = 0.0;
    int clickPos = -1;

    TimeSliceThread writerThread;
    std::unique_ptr<AudioFormatWriter::ThreadedWriter> threadedWriter;
    std::atomic<AudioFormatWriter::ThreadedWriter*> activeWriter { nullptr };
    std::atomic<bool>  recordArmed { false };
    std::atomic<int64> recordedStart { -1 };
    File outFile;
};

// 재생 위치를 주기적으로 emit (message 스레드)
class PosTimer : public Timer
{
public:
    explicit PosTimer (Engine& e) : engine (e) {}
    void timerCallback() override
    {
        if (engine.isPlaying())
        {
            auto* o = ev ("pos");
            o->setProperty ("samples", engine.getPlayhead());
            emit (var (o));
        }
        // 입력 레벨 (매 틱)
        { auto* o = ev ("level"); o->setProperty ("peak", engine.inputLevel()); emit (var (o)); }
        // 튜너 피치 (3틱마다 — 무거움)
        if (++tick % 3 == 0)
        {
            const double f = engine.detectPitch();
            auto* o = ev ("pitch"); o->setProperty ("freq", f); emit (var (o));
        }
    }
    int tick = 0;
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
    else if (cmd == "takeRemove")  engine.removeTake ((int64) (double) c["id"]);
    else if (cmd == "takeClear")   engine.clearTakes();
    else if (cmd == "takeLoad")    engine.loadTake (c["file"].toString(), (int64) (double) c["start"], (int) c["trackId"]);
    else if (cmd == "takeMove")    engine.moveTake ((int64) (double) c["id"], (int64) (double) c["start"]);
    else if (cmd == "stemOffset")  engine.setStemOffset ((int64) (double) c["samples"]);
    else if (cmd == "recTrackAdd") engine.addRecTrack();
    else if (cmd == "recTrackRemove") engine.removeRecTrack ((int) c["id"]);
    else if (cmd == "recArm")      engine.armRec ((int) c["id"]);
    else if (cmd == "recTrack")    engine.setRecTrack ((int) c["id"], c["gain"], c["mute"], c["solo"]);
    else if (cmd == "recTracks")   engine.emitRecTracks();
    else if (cmd == "track")       engine.setTrack ((int) c["index"], c["gain"], c["mute"], c["solo"]);
    else if (cmd == "master")      engine.setMaster ((float) (double) c["gain"]);
    else if (cmd == "monitor")     engine.setMonitor ((float) (double) c["gain"]);
    else if (cmd == "inputMonitor") engine.setInputMonitor ((bool) c["on"]);
    else if (cmd == "metro")       engine.setMetro ((bool) c["on"], (double) c["bpm"]);
    else if (cmd == "listDevices") engine.listDevices();
    else if (cmd == "setDevice")   engine.setDevice (c);
    else if (cmd == "scanPlugins") engine.scanPlugins();
    else if (cmd == "fxAdd")       engine.addFx ((int) c["index"]);
    else if (cmd == "fxRemove")    engine.removeFx ((int) c["slot"]);
    else if (cmd == "fxReorder")   { Array<int> o; if (auto* a = c["order"].getArray()) for (auto& v : *a) o.add ((int) v); engine.reorderFx (o); }
    else if (cmd == "fxSetChain")  engine.setChain (c["plugins"]);
    else if (cmd == "fxBypass")    engine.setBypass ((int) c["slot"], (bool) c["on"]);
    else if (cmd == "fxEditor")    engine.showEditor ((int) c["slot"]);
    else if (cmd == "fxSaveState") engine.fxSaveState ((int) c["slot"]);
    else if (cmd == "fxSetState")  engine.fxSetState ((int) c["slot"], c["data"].toString());
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
    engine.setDeviceManager (&dm);
    for (int i = 1; i < argc; ++i)
        engine.addStem (String::fromUTF8 (argv[i]));

    dm.addAudioCallback (&engine);
    PosTimer posTimer (engine);
    posTimer.startTimer (50);       // 20Hz 위치 스트림
    emit (var (ev ("ready")));
    engine.emitRecTracks();         // 초기 녹음 트랙 목록

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
    engine.clearChain();
    dm.removeAudioCallback (&engine);
    return 0;
}
