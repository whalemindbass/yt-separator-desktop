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
    float curGain = 1.0f;   // 오디오 스레드 전용 — 게인/뮤트/솔로 램프(클릭/지퍼 방지)
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

// FX 체인 슬롯 (입력 이펙트 여러 개 직렬)
struct FxSlot
{
    std::unique_ptr<AudioPluginInstance> plugin;
    std::unique_ptr<DocumentWindow> editor;
    std::atomic<bool> bypass { false };
    int id = 0;
    int descIndex = -1;
};

// 녹음 트랙 (내 녹음 여러 개 — 각각 뮤트/솔로/게인 + 독립 FX 체인, R 로 녹음 대상 선택)
struct RecTrack
{
    int id = 0;
    std::atomic<float> gain { 1.0f };
    std::atomic<bool>  mute { false };
    std::atomic<bool>  solo { false };
    std::vector<std::unique_ptr<FxSlot>> chain;   // 트랙별 독립 이펙트
    CriticalSection fxLock;                        // processBlock 과 체인 변경 상호배제
    float curGain = 1.0f;                          // 오디오 스레드 전용 — 게인/뮤트/솔로 램프
};

// 원본 → 목적지에 게인 램프(g0→g1) 걸어 합산 (블록 경계 클릭·지퍼 방지)
static inline void addRamped (float* dst, const float* src, int n, float g0, float g1)
{
    if (g0 == g1) { FloatVectorOperations::addWithMultiply (dst, src, g0, n); return; }
    const float step = (g1 - g0) / (float) jmax (1, n);
    float g = g0;
    for (int i = 0; i < n; ++i) { dst[i] += src[i] * g; g += step; }
}

class Engine : public AudioIODeviceCallback
{
public:
    Engine() : writerThread ("rec") { fmt.registerBasicFormats(); }   // 기본 녹음 트랙 없음 (사용자가 추가)
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
        if (findRec (armedTrack.load()) == nullptr) { std::cerr << "[engine] no armed rec track\n"; return; }
        outFile = out;
        auto* dev = currentDevice;
        if (dev == nullptr) { std::cerr << "[engine] no device\n"; return; }
        if (numInputChans <= 0) { std::cerr << "[engine] no input channels — cannot record\n"; return; }

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
    void loadTake (const String& file, int64 start, int trackId, int64 id)   // 저장된 테이크 파일을 재생 소스로 등록
    {
        File f (file);
        if (auto* reader = fmt.createReaderFor (f))
        {
            auto tp = std::make_unique<TakePlay>();
            tp->src = std::make_unique<AudioFormatReaderSource> (reader, true);
            tp->src->prepareToPlay (blockSize, deviceSampleRate);
            const int64 tid = id > 0 ? id : nextTakeId++;   // 저장된 고유 id 재사용, 없으면 새로
            tp->id = tid;
            if (tid >= nextTakeId) nextTakeId = tid + 1;     // 이후 녹음 id 와 충돌 방지
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

    FxSlot* findSlot (RecTrack& rt, int id)
    {
        for (auto& s : rt.chain) if (s->id == id) return s.get();
        return nullptr;
    }
    void emitChain (RecTrack& rt)
    {
        Array<var> list;
        for (auto& s : rt.chain)
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
        r->setProperty ("trackId", rt.id);
        r->setProperty ("list", var (list));
        emit (var (r));
    }
    void addFx (int trackId, int index)
    {
        auto* rt = findRec (trackId);
        if (rt == nullptr) { std::cerr << "[engine] addFx: no track\n"; return; }
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
            const ScopedLock sl (rt->fxLock);
            rt->chain.push_back (std::move (slot));
        }
        emitChain (*rt);
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
        recomputeSolos();   // 새 스템은 solo=false → 이전 곡 솔로 캐시 stale 방지(무음 버그)
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
        r->setProperty ("gen", recTracksGen);   // 재구성 동기화 토큰 에코
        emit (var (r));
    }
    void emitChainFor (int trackId) { if (auto* rt = findRec (trackId)) emitChain (*rt); }
    void addRecTrack()
    {
        auto t = std::make_unique<RecTrack>();
        const int newId = nextRecId++;
        t->id = newId;
        { const ScopedLock sl (takesLock); recTracks.push_back (std::move (t)); }
        if (findRec (armedTrack.load()) == nullptr) armedTrack = newId;   // 첫 트랙이면 자동 녹음 대상
        emitRecTracks();
    }
    void removeRecTrack (int id)
    {
        auto* rt = findRec (id);
        if (rt != nullptr) clearChain (*rt);   // 에디터 창 닫기 (message 스레드)
        {
            const ScopedLock sl (takesLock);
            takesPlay.erase (std::remove_if (takesPlay.begin(), takesPlay.end(),
                                 [id] (auto& t) { return t->trackId == id; }), takesPlay.end());
            recTracks.erase (std::remove_if (recTracks.begin(), recTracks.end(),
                                 [id] (auto& t) { return t->id == id; }), recTracks.end());
        }
        if (armedTrack.load() == id) armedTrack = recTracks.empty() ? 0 : recTracks.front()->id;
        recomputeSolos();
        emitRecTracks();
    }
    void armRec (int id) { if (findRec (id)) { armedTrack = id; emitRecTracks(); } }
    // 녹음 트랙 전체 재구성 (녹음 저장 불러오기 — 트랙 수·상태 복원). 새 id 는 emitRecTracks 로 통지.
    void setRecTracks (const var& list, int gen)
    {
        recTracksGen = gen;
        for (auto& rt : recTracks) clearChain (*rt);
        { const ScopedLock sl (takesLock); takesPlay.clear(); recTracks.clear(); }
        if (auto* a = list.getArray())
            for (auto& v : *a)
            {
                auto t = std::make_unique<RecTrack>();
                t->id = nextRecId++;
                if (! v["gain"].isVoid()) t->gain = (float) (double) v["gain"];
                if (! v["mute"].isVoid()) t->mute = (bool) v["mute"];
                if (! v["solo"].isVoid()) t->solo = (bool) v["solo"];
                const ScopedLock sl (takesLock);
                recTracks.push_back (std::move (t));
            }
        armedTrack = recTracks.empty() ? 0 : recTracks.front()->id;
        recomputeSolos();
        emitRecTracks();
    }
    void setRecTrack (int id, const var& gain, const var& mute, const var& solo)
    {
        auto* t = findRec (id);
        if (t == nullptr) return;
        if (! gain.isVoid()) t->gain = (float) (double) gain;
        if (! mute.isVoid()) t->mute = (bool) mute;
        if (! solo.isVoid()) t->solo = (bool) solo;
        recomputeSolos();
    }
    void moveTake (int64 id, int64 newStart, int trackId)   // trackId>0 이면 트랙 이동
    {
        const ScopedLock sl (takesLock);
        for (auto& t : takesPlay) if (t->id == id) { t->start = newStart; if (trackId > 0) t->trackId = trackId; break; }
    }
    void setBypass (int trackId, int id, bool on)
    {
        auto* rt = findRec (trackId); if (rt == nullptr) return;
        if (auto* s = findSlot (*rt, id)) { s->bypass = on; emitChain (*rt); }
    }
    void setBypassAll (int trackId, bool on)   // 일괄 끄기/켜기
    {
        auto* rt = findRec (trackId); if (rt == nullptr) return;
        for (auto& s : rt->chain) if (s) s->bypass = on;
        emitChain (*rt);
    }
    void removeFx (int trackId, int id)
    {
        auto* rt = findRec (trackId); if (rt == nullptr) return;
        if (auto* s = findSlot (*rt, id)) s->editor.reset();   // message 스레드
        {
            const ScopedLock sl (rt->fxLock);
            rt->chain.erase (std::remove_if (rt->chain.begin(), rt->chain.end(),
                             [id] (auto& x) { return x->id == id; }), rt->chain.end());
        }
        emitChain (*rt);
    }
    void reorderFx (int trackId, const Array<int>& order)
    {
        auto* rt = findRec (trackId); if (rt == nullptr) return;
        {
            const ScopedLock sl (rt->fxLock);
            std::vector<std::unique_ptr<FxSlot>> next;
            for (int id : order)
            {
                auto it = std::find_if (rt->chain.begin(), rt->chain.end(), [id] (auto& x) { return x && x->id == id; });
                if (it != rt->chain.end()) { next.push_back (std::move (*it)); }
            }
            for (auto& x : rt->chain) if (x) next.push_back (std::move (x));   // 누락분 보존
            rt->chain = std::move (next);
        }
        emitChain (*rt);
    }
    // VST 세부 설정(노브값) 직렬화 — 슬롯 단위 base64
    void fxSaveState (int trackId, int id)
    {
        auto* rt = findRec (trackId); if (rt == nullptr) return;
        auto* s = findSlot (*rt, id);
        if (s == nullptr) return;
        MemoryBlock mb;
        s->plugin->getStateInformation (mb);
        auto* o = ev ("fxState");
        o->setProperty ("trackId", trackId);
        o->setProperty ("id", id);
        o->setProperty ("data", Base64::toBase64 (mb.getData(), mb.getSize()));
        emit (var (o));
    }
    void fxSetState (int trackId, int id, const String& b64)
    {
        auto* rt = findRec (trackId); if (rt == nullptr) return;
        auto* s = findSlot (*rt, id);
        if (s == nullptr || b64.isEmpty()) return;
        MemoryOutputStream mo;
        if (Base64::convertFromBase64 (mo, b64))
        {
            const ScopedLock sl (rt->fxLock);
            s->plugin->setStateInformation (mo.getData(), (int) mo.getDataSize());
        }
    }
    void showEditor (int trackId, int id)
    {
        auto* rt = findRec (trackId); if (rt == nullptr) return;
        auto* s = findSlot (*rt, id);
        if (s == nullptr || ! s->plugin->hasEditor()) return;
        if (s->editor != nullptr) { s->editor->setVisible (true); s->editor->toFront (true); return; }
        s->editor.reset (new PluginWindow (s->plugin->createEditorIfNeeded(), s->plugin->getName()));
        s->editor->toFront (true);
    }
    void clearChain (RecTrack& rt)
    {
        for (auto& s : rt.chain) if (s) s->editor.reset();
        const ScopedLock sl (rt.fxLock);
        rt.chain.clear();
    }
    void clearAllChains() { for (auto& rt : recTracks) clearChain (*rt); }
    // 프리셋 로드 — 트랙 체인 전체를 한 번에 재구성(원자적). churn 없이 안전.
    void setChain (int trackId, const var& list)
    {
        auto* rt = findRec (trackId); if (rt == nullptr) return;
        if (pluginFmt.getNumFormats() == 0) addDefaultFormatsToManager (pluginFmt);

        // 새 체인을 락 밖에서 완성한 뒤 한 번에 스왑(원자적) — 재생 중 빈/부분 체인 노출·드롭 방지
        std::vector<std::unique_ptr<FxSlot>> next;
        int failed = 0;
        if (auto* a = list.getArray())
            for (auto& v : *a)
            {
                const int index = (int) v["index"];
                if (index < 0 || index >= scanned.size()) { ++failed; continue; }
                String err;
                auto inst = pluginFmt.createPluginInstance (scanned[index], deviceSampleRate, blockSize, err);
                if (inst == nullptr) { ++failed; std::cerr << "[engine] setChain load failed: " << err << "\n"; continue; }
                inst->setPlayConfigDetails (2, 2, deviceSampleRate, blockSize);
                inst->prepareToPlay (deviceSampleRate, blockSize);
                const String data = v["data"].toString();
                if (data.isNotEmpty()) { MemoryOutputStream mo; if (Base64::convertFromBase64 (mo, data)) inst->setStateInformation (mo.getData(), (int) mo.getDataSize()); }
                auto slot = std::make_unique<FxSlot>();
                slot->id = nextSlotId++;
                slot->descIndex = index;
                slot->bypass = (bool) v["bypass"];
                slot->plugin = std::move (inst);
                next.push_back (std::move (slot));
            }

        std::vector<std::unique_ptr<FxSlot>> old;   // 이전 체인은 락 밖에서 소멸(에디터/플러그인 소멸이 오디오 스레드 안 막게)
        {
            const ScopedLock sl (rt->fxLock);
            old.swap (rt->chain);
            rt->chain = std::move (next);
        }
        for (auto& s : old) if (s) s->editor.reset();   // message 스레드에서 정리
        old.clear();
        if (failed > 0) { auto* e = ev ("fxError"); e->setProperty ("trackId", trackId); e->setProperty ("failed", failed); emit (var (e)); }
        emitChain (*rt);
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
        for (auto& rt : recTracks) { const ScopedLock sl (rt->fxLock); for (auto& s : rt->chain) if (s && s->plugin) s->plugin->prepareToPlay (deviceSampleRate, block); }
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
        o->setProperty ("stemSr", stemSampleRate);
        o->setProperty ("srMismatch", ! approximatelyEqual (stemSampleRate, deviceSampleRate));
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
                const float target = audible ? s->gain.load() : 0.0f;   // 뮤트/솔로도 램프로 declick
                for (int c = 0; c < numOut; ++c)
                    addRamped (outputs[c], scratch.getReadPointer (jmin (c, scratch.getNumChannels() - 1)),
                               numSamples, s->curGain, target);
                s->curGain = target;
            }
            playhead.fetch_add (numSamples);
        }

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

        // 내 녹음 버스 = 트랙별 (라이브 입력 + 녹음 테이크) → 트랙별 독립 FX → 출력
        {
            const float mg = monitorGain.load();
            const ScopedTryLock stl (takesLock);   // recTracks/takesPlay 보호
            if (stl.isLocked())
            {
                const int armed = armedTrack.load();
                const bool monOn = monitorInputOn.load();
                for (auto& rt : recTracks)
                {
                    const bool audible = anySolo ? rt->solo.load() : ! rt->mute.load();
                    const float target = (audible ? rt->gain.load() : 0.0f) * mg;   // 페이더는 FX 뒤(post-FX)
                    if (rt->curGain == 0.0f && target == 0.0f) continue;             // 무음 지속 → 처리 스킵

                    fxBuf.setSize (jmax (2, numOutputChans), numSamples, false, false, true);
                    fxBuf.clear();

                    // 테이크·입력은 유니티로 버스에 모음 (게인은 FX 뒤에 적용)
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
                                fxBuf.addFrom (c, 0, scratch, jmin (c, scratch.getNumChannels() - 1), 0, numSamples);
                        }

                    if (rt->id == armed && monOn && numIn > 0)   // armed 트랙만 라이브 입력 모니터
                        for (int c = 0; c < fxBuf.getNumChannels(); ++c)
                            fxBuf.addFrom (c, 0, inputs[jmin (c, numIn - 1)], numSamples);

                    // 이 트랙의 독립 FX 체인 적용
                    {
                        const ScopedTryLock fl (rt->fxLock);
                        if (fl.isLocked())
                            for (auto& s : rt->chain)
                                if (s && s->plugin && ! s->bypass.load())
                                {
                                    MidiBuffer mm;
                                    s->plugin->processBlock (fxBuf, mm);
                                }
                    }

                    for (int c = 0; c < numOut; ++c)   // post-FX 페이더 + 램프
                        addRamped (outputs[c], fxBuf.getReadPointer (jmin (c, fxBuf.getNumChannels() - 1)),
                                   numSamples, rt->curGain, target);
                    rt->curGain = target;
                }
            }
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

        // 마스터 볼륨 (램프) + 안전 클리퍼 (다트랙 합산 클리핑/왜곡 방지)
        const float master = masterGain.load();
        if (numOut > 0)
        {
            AudioBuffer<float> out (outputs, numOut, numSamples);   // 기존 포인터 래핑(무복사)
            out.applyGainRamp (0, numSamples, lastMasterGain, master);
            for (int c = 0; c < numOut; ++c)
            {
                FloatVectorOperations::max (outputs[c], outputs[c], -1.0f, numSamples);
                FloatVectorOperations::min (outputs[c], outputs[c],  1.0f, numSamples);
            }
        }
        lastMasterGain = master;

        // 녹음
        if (recordArmed.load())
        {
            if (recordedStart.load() < 0 && playing.load())
                recordedStart = phStart;   // 이 블록 입력에 대응하는 위치(증분 전 phStart). playhead 는 이미 +numSamples 됨

            if (recordedStart.load() >= 0 && numIn > 0)   // 입력 채널 없으면 write 안 함(크래시 방지)
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
                const int64 takeId = nextTakeId++;   // 트랙 무관 전역 고유 id (start 아님 → 충돌 방지)
                tp->id = takeId;
                tp->start = timelineStart;
                tp->len = reader->lengthInSamples;
                tp->trackId = armedTrack.load();
                lastTakeId = takeId;
                const ScopedLock sl (takesLock);
                takesPlay.push_back (std::move (tp));
            }

            auto* o = ev ("take");
            o->setProperty ("id", lastTakeId);   // 렌더러 클립 식별용(고유 id)
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

    // VST FX (스캔 목록은 전역, 체인은 트랙별 RecTrack 에 보관)
    AudioPluginFormatManager pluginFmt;
    Array<PluginDescription> scanned;
    int nextSlotId = 1;       // 슬롯 id 는 트랙 간 전역 유일 (에디터 매핑용)
    AudioBuffer<float> fxBuf;  // 트랙별 처리용 스크래치

    std::atomic<bool>  playing { false };
    std::atomic<int64> playhead { 0 };
    std::atomic<float> monitorGain { 1.0f };
    std::atomic<float> masterGain { 1.0f };
    float lastMasterGain = 1.0f;   // 마스터 게인 램프용 (오디오 스레드 전용)
    std::atomic<bool>  monitorInputOn { true };
    std::atomic<int64> stemOffset { 0 };
    AudioDeviceManager* devmgr = nullptr;

    // 녹음 트랙 (여러 개) + 녹음 대상(armed) + 솔로 캐시(오디오 스레드 락-프리 판독)
    std::vector<std::unique_ptr<RecTrack>> recTracks;
    std::atomic<int>  armedTrack { 0 };
    int nextRecId = 1;
    std::atomic<int64> nextTakeId { 1 };   // 테이크 전역 고유 id (start 와 무관)
    int64 lastTakeId = 0;
    int recTracksGen = 0;                  // 트랙 재구성 동기화 토큰(렌더러 에코용)
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
    else if (cmd == "takeLoad")    engine.loadTake (c["file"].toString(), (int64) (double) c["start"], (int) c["trackId"], (int64) (double) c["id"]);
    else if (cmd == "takeMove")    engine.moveTake ((int64) (double) c["id"], (int64) (double) c["start"], (int) c["trackId"]);
    else if (cmd == "stemOffset")  engine.setStemOffset ((int64) (double) c["samples"]);
    else if (cmd == "recTrackAdd") engine.addRecTrack();
    else if (cmd == "recTrackRemove") engine.removeRecTrack ((int) c["id"]);
    else if (cmd == "recArm")      engine.armRec ((int) c["id"]);
    else if (cmd == "recTrack")    engine.setRecTrack ((int) c["id"], c["gain"], c["mute"], c["solo"]);
    else if (cmd == "recTracks")   engine.emitRecTracks();
    else if (cmd == "recTracksReset") engine.setRecTracks (c["tracks"], (int) c["gen"]);
    else if (cmd == "track")       engine.setTrack ((int) c["index"], c["gain"], c["mute"], c["solo"]);
    else if (cmd == "master")      engine.setMaster ((float) (double) c["gain"]);
    else if (cmd == "monitor")     engine.setMonitor ((float) (double) c["gain"]);
    else if (cmd == "inputMonitor") engine.setInputMonitor ((bool) c["on"]);
    else if (cmd == "metro")       engine.setMetro ((bool) c["on"], (double) c["bpm"]);
    else if (cmd == "listDevices") engine.listDevices();
    else if (cmd == "setDevice")   engine.setDevice (c);
    else if (cmd == "scanPlugins") engine.scanPlugins();
    else if (cmd == "fxAdd")       engine.addFx ((int) c["track"], (int) c["index"]);
    else if (cmd == "fxRemove")    engine.removeFx ((int) c["track"], (int) c["slot"]);
    else if (cmd == "fxReorder")   { Array<int> o; if (auto* a = c["order"].getArray()) for (auto& v : *a) o.add ((int) v); engine.reorderFx ((int) c["track"], o); }
    else if (cmd == "fxSetChain")  engine.setChain ((int) c["track"], c["plugins"]);
    else if (cmd == "fxBypass")    engine.setBypass ((int) c["track"], (int) c["slot"], (bool) c["on"]);
    else if (cmd == "fxBypassAll") engine.setBypassAll ((int) c["track"], (bool) c["on"]);
    else if (cmd == "fxEditor")    engine.showEditor ((int) c["track"], (int) c["slot"]);
    else if (cmd == "fxSaveState") engine.fxSaveState ((int) c["track"], (int) c["slot"]);
    else if (cmd == "fxSetState")  engine.fxSetState ((int) c["track"], (int) c["slot"], c["data"].toString());
    else if (cmd == "fxChainReq")  engine.emitChainFor ((int) c["track"]);
    else if (cmd == "quit")        MessageManager::getInstance()->stopDispatchLoop();
    else                           std::cerr << "[engine] unknown cmd: " << cmd << "\n";
}

int main (int argc, char* argv[])
{
    ScopedJuceInitialiser_GUI juceInit;

    AudioDeviceManager dm;
    const String err = dm.initialiseWithDefaultDevices (2, 2);
    if (err.isNotEmpty()) { auto* e = ev ("error"); e->setProperty ("msg", "audio init: " + err); emit (var (e)); std::cerr << "audio init: " << err << "\n"; return 1; }

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
    engine.clearAllChains();
    dm.removeAudioCallback (&engine);
    return 0;
}
