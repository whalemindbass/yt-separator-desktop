// yss-engine — 실시간 오디오 사이드카 (Electron 연동용 JSON IPC)
//   stdin  : 한 줄당 JSON 명령 { "cmd": "...", ... }
//            loadStems{paths[]} play stop seek{pos} recordArm{file?} recordStop
//            scanPlugins loadFx{index} showEditor quit
//   stdout : 한 줄당 JSON 이벤트 { "ev": "..." }
//            ready device plugins fx stems pos take error
//   stderr : 사람용 진단 로그

#include <limits>
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

// FX 체인 슬롯 (입력 이펙트 여러 개 직렬)
// ── 볼륨 자동화 ──────────────────────────────────────────────
// 시간축 브레이크포인트. 점 사이는 선형 보간, 양 끝은 첫/끝 값 유지.
struct AutoPoint { int64 s; float v; };

static float autoValueAt (const std::vector<AutoPoint>& p, int64 pos)
{
    if (p.empty()) return 1.0f;
    if (pos <= p.front().s) return p.front().v;
    if (pos >= p.back().s)  return p.back().v;
    size_t lo = 0, hi = p.size() - 1;
    while (hi - lo > 1) { const size_t mid = (lo + hi) / 2; if (p[mid].s <= pos) lo = mid; else hi = mid; }
    const auto& a = p[lo]; const auto& b = p[hi];
    if (b.s <= a.s) return b.v;
    const double t = (double) (pos - a.s) / (double) (b.s - a.s);
    return (float) (a.v + (b.v - a.v) * t);
}

struct FxSlot
{
    std::unique_ptr<AudioPluginInstance> plugin;
    std::unique_ptr<DocumentWindow> editor;
    std::atomic<bool> bypass { false };
    int id = 0;
    int descIndex = -1;          // scanned 내 위치 (재스캔 시 흔들릴 수 있음)
    PluginDescription desc;      // 안정 식별자 — export 는 이걸로 재생성
};

struct Stem
{
    std::unique_ptr<AudioFormatReaderSource> src;
    String name;
    String path;   // export(오프라인 렌더)용 프레시 리더 생성
    int id = 0;    // FX 주소용 id (스템은 90001+ 범위 — 녹음 트랙 id와 충돌 방지)
    std::atomic<float> gain { 1.0f };
    std::atomic<float> pan  { 0.0f };   // -1(L)..0(C)..+1(R), equal-power
    std::atomic<bool>  mute { false };
    std::atomic<bool>  solo { false };
    std::atomic<float> pkL { 0.0f }, pkR { 0.0f };   // post-fader peak (누적, exchange 로 소비)
    std::vector<std::unique_ptr<FxSlot>> chain;   // 스템별 독립 FX
    CriticalSection fxLock;
    std::vector<AutoPoint> autoPts;           // 볼륨 자동화 — 켜져 있으면 페이더 대신 이 값을 씀
    CriticalSection autoLock;
    std::atomic<bool> autoOn { false };
    float curAutoGain = 1.0f;                 // 오디오 스레드 전용 — 락 실패 시 직전 값 유지
    float curGainL = 1.0f, curGainR = 1.0f;   // 오디오 스레드 전용 — L/R 각각 램프(pan+gain 결합)
    // PDC — 다른 트랙의 플러그인 지연에 맞추기 위한 보정 지연
    AudioBuffer<float> pdcBuf;                // 링버퍼 (message 스레드에서만 할당)
    std::atomic<int> pdcDelay { 0 };          // 목표 지연(샘플)
    int pdcActive = 0, pdcWrite = 0;          // 오디오 스레드 전용
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

// 녹음/임포트 클립 재생 — 디바이스 SR 로 리샘플된 메모리 버퍼(오디오 스레드 디스크 I/O 없음)
struct TakePlay
{
    AudioBuffer<float> buf;   // 2ch, 디바이스 SR (전체 소스)
    int64 id = 0;      // 안정 식별자 (이동해도 유지)
    int64 start = 0;   // 타임라인 위치 (이동 가능)
    int64 inOffset = 0;// 버퍼 내 시작(트림 좌측)
    int64 len = 0;     // 재생 길이(트림 반영)
    int64 fadeIn = 0;  // 페이드 인 길이(샘플)
    int64 fadeOut = 0; // 페이드 아웃 길이(샘플)
    int   trackId = 0; // 소속 녹음 트랙
    String path;       // export(오프라인 렌더)용
};

// 클립 페이드 엔벨로프 적용 — buf[0..n) 는 클립 내 pos 위치부터의 슬라이스
static void applyClipFades (AudioBuffer<float>& buf, int64 pos, int64 len, int64 fadeIn, int64 fadeOut, int n)
{
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
    {
        float* d = buf.getWritePointer (ch);
        for (int j = 0; j < n; ++j)
        {
            const int64 p = pos + j;
            float g = 1.0f;
            if (fadeIn > 0 && p < fadeIn)              g *= (float) p / (float) fadeIn;
            if (fadeOut > 0 && p >= len - fadeOut)     g *= (float) (len - p) / (float) fadeOut;
            d[j] *= g;
        }
    }
}


// 트랙 (내 녹음/오디오 임포트 — 각각 뮤트/솔로/게인 + 독립 FX 체인). type: 0=녹음, 1=오디오(녹음불가)
struct RecTrack
{
    int id = 0;
    int type = 0;   // 0=rec(내 악기 녹음), 1=audio(임포트, 녹음 대상 불가)
    std::atomic<float> gain { 1.0f };
    std::atomic<float> pan  { 0.0f };              // -1..0..+1 equal-power
    std::atomic<bool>  mute { false };
    std::atomic<bool>  solo { false };
    std::atomic<float> pkL { 0.0f }, pkR { 0.0f }; // post-fader peak(누적, exchange로 소비)
    std::vector<std::unique_ptr<FxSlot>> chain;   // 트랙별 독립 이펙트
    CriticalSection fxLock;                        // processBlock 과 체인 변경 상호배제
    std::vector<AutoPoint> autoPts;                // 볼륨 자동화
    CriticalSection autoLock;
    std::atomic<bool> autoOn { false };
    float curAutoGain = 1.0f;
    float curGainL = 1.0f, curGainR = 1.0f;        // 오디오 스레드 전용 — L/R 결합 램프(게인·팬·뮤트·솔로)
    // PDC
    AudioBuffer<float> pdcBuf;
    std::atomic<int> pdcDelay { 0 };
    int pdcActive = 0, pdcWrite = 0;
};

// 원본 → 목적지에 게인 램프(g0→g1) 걸어 합산 (블록 경계 클릭·지퍼 방지)
static inline void addRamped (float* dst, const float* src, int n, float g0, float g1)
{
    if (g0 == g1) { FloatVectorOperations::addWithMultiply (dst, src, g0, n); return; }
    const float step = (g1 - g0) / (float) jmax (1, n);
    float g = g0;
    for (int i = 0; i < n; ++i) { dst[i] += src[i] * g; g += step; }
}

// equal-power pan: -1..0..+1 → (gL, gR)
static inline void panGains (float pan, float& gL, float& gR)
{
    const float p = jlimit (-1.0f, 1.0f, pan);
    const float theta = (p + 1.0f) * 0.25f * MathConstants<float>::pi;
    gL = std::cos (theta); gR = std::sin (theta);
}

// post-fader block peak = 원본 abs max × 게인 max endpoint
static inline float blockPeak (const float* src, int n, float g0, float g1)
{
    float m = 0.0f;
    for (int i = 0; i < n; ++i) { const float a = std::abs (src[i]); if (a > m) m = a; }
    return m * jmax (std::abs (g0), std::abs (g1));
}

// atomic peak: max 유지(락 없음)
// ── PDC 지연 라인 ────────────────────────────────────────────
// buf 를 delay 샘플만큼 늦춘다(in-place). ring 은 트랙 전용 링버퍼.
static inline void applyDelayLine (AudioBuffer<float>& buf, int n,
                                   AudioBuffer<float>& ring, int& writePos, int delay)
{
    const int cap = ring.getNumSamples();
    if (delay <= 0 || cap <= 0) return;
    const int chans = jmin (buf.getNumChannels(), ring.getNumChannels());
    int endPos = writePos;
    for (int c = 0; c < chans; ++c)
    {
        float* d = buf.getWritePointer (c);
        float* r = ring.getWritePointer (c);
        int w = writePos;
        for (int i = 0; i < n; ++i)
        {
            int rd = w - delay;
            if (rd < 0) rd += cap;
            const float out = r[rd];
            r[w] = d[i];
            d[i] = out;
            if (++w >= cap) w = 0;
        }
        endPos = w;
    }
    writePos = endPos;
}

// 미터 노이즈 게이트 — 인터페이스 입력 노이즈 플로어가 미터를 계속 튀게 하므로
// 이 값 아래는 아예 0 으로 본다 (≈ -45 dBFS)
static constexpr float METER_GATE = 0.0056f;

static inline void updatePeak (std::atomic<float>& p, float v)
{
    if (v < METER_GATE) return;
    float cur = p.load (std::memory_order_relaxed);
    while (v > cur && ! p.compare_exchange_weak (cur, v, std::memory_order_relaxed)) {}
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
        s->path = f.getFullPathName();
        s->id   = 90001 + (int) stems.size();   // 스템 FX 주소용 id (녹음 트랙 id와 분리된 범위)
        s->src  = std::make_unique<AudioFormatReaderSource> (r, true);
        stemSampleRate = r->sampleRate;
        stems.push_back (std::move (s));
        return true;
    }

    // ---- 트랜스포트 ----
    // 시크·재생/정지 전환은 파형이 순간적으로 튀어 '틱' 소리가 난다.
    // 다음 블록에서 직전 출력 값과 매끄럽게 이어붙이도록 디클릭을 예약한다.
    void play()  { declickPending = true; playing = true;  std::cerr << "[engine] play @" << playhead.load() << "\n"; }
    void stop()  { declickPending = true; playing = false; std::cerr << "[engine] stop @" << playhead.load() << "\n"; }
    void seek0() { setPos (0); std::cerr << "[engine] seek 0\n"; }

    void setPos (int64 p)
    {
        declickPending = true;
        playhead = p;
        for (auto& s : stems) s->src->setNextReadPosition (p);
    }

    // ---- 녹음 ----
    void armRecord (const File& out)
    {
        finishRecording();
        { auto* rt = findRec (armedTrack.load()); if (rt == nullptr || rt->type != 0) { std::cerr << "[engine] no armed rec track\n"; return; } }
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

        writerChans = jmax (1, numInputChans);
        // FIFO 를 넉넉히 — 디스크가 잠깐 밀려도 샘플이 드롭돼 '틱' 이 남지 않도록
        threadedWriter.reset (new AudioFormatWriter::ThreadedWriter (w, writerThread, 1 << 17));
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

    // 파일 → 디바이스 SR 2ch 메모리 버퍼로 (리샘플). 반환=샘플수. 오디오 스레드 디스크 I/O 제거 + SR 정합
    int64 loadClipBuffer (const File& f, AudioBuffer<float>& out)
    {
        std::unique_ptr<AudioFormatReader> r (fmt.createReaderFor (f));
        if (r == nullptr) return 0;
        const int64 srcLen = r->lengthInSamples;
        if (srcLen <= 0) return 0;
        const double srcSr = r->sampleRate > 0 ? r->sampleRate : deviceSampleRate;
        AudioBuffer<float> src (2, (int) srcLen);
        src.clear();
        r->read (&src, 0, (int) srcLen, 0, true, true);
        if (r->numChannels < 2) src.copyFrom (1, 0, src, 0, 0, (int) srcLen);   // 모노 → 스테레오
        if (approximatelyEqual (srcSr, deviceSampleRate)) { out = std::move (src); return srcLen; }
        const int outLen = (int) std::ceil ((double) srcLen * deviceSampleRate / srcSr);
        out.setSize (2, outLen); out.clear();
        for (int c = 0; c < 2; ++c)
        {
            LagrangeInterpolator interp;
            interp.process (srcSr / deviceSampleRate, src.getReadPointer (c), out.getWritePointer (c), outLen);
        }
        return outLen;
    }

    void loadTake (const String& file, int64 start, int trackId, int64 id)   // 저장/임포트 클립을 재생 버퍼로 등록
    {
        auto tp = std::make_unique<TakePlay>();
        tp->len = loadClipBuffer (File (file), tp->buf);
        if (tp->len <= 0) { std::cerr << "[engine] loadTake: cannot read " << file << "\n"; return; }
        const int64 tid = id > 0 ? id : nextTakeId++;
        tp->id = tid;
        if (tid >= nextTakeId) nextTakeId = tid + 1;
        tp->start = start;
        tp->trackId = trackId > 0 ? trackId : armedTrack.load();
        const ScopedLock sl (takesLock);
        takesPlay.push_back (std::move (tp));
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
    // ── FX 호스트 통합(녹음 트랙 + 스템) — id 로 체인/락 조회 ──
    using FxChainVec = std::vector<std::unique_ptr<FxSlot>>;
    FxChainVec* fxChainOf (int id, CriticalSection*& lock)
    {
        if (auto* rt = findRec (id)) { lock = &rt->fxLock; return &rt->chain; }
        for (auto& s : stems) if (s->id == id) { lock = &s->fxLock; return &s->chain; }
        lock = nullptr; return nullptr;
    }
    static FxSlot* findSlotIn (FxChainVec& chain, int id)
    {
        for (auto& s : chain) if (s && s->id == id) return s.get();
        return nullptr;
    }
    void emitChainId (int id, FxChainVec& chain)
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
        r->setProperty ("trackId", id);
        r->setProperty ("list", var (list));
        emit (var (r));
    }
    void addFx (int trackId, int index)
    {
        CriticalSection* lk = nullptr; auto* chain = fxChainOf (trackId, lk);
        if (chain == nullptr) { std::cerr << "[engine] addFx: no host\n"; return; }
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
        slot->desc = scanned[index];
        slot->plugin = std::move (inst);
        { const ScopedLock sl (*lk); chain->push_back (std::move (slot)); }
        recomputePdc();
        emitChainId (trackId, *chain);
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
    bool  isMonitorOn() const { return monitorInputOn.load(); }
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
    void setMetro (bool on, double bpm, int64 phase, double interval)
    {
        metroOn = on; if (bpm > 20.0) metroBpm = bpm; metroPhase = phase;
        metroInterval = interval;                 // 샘플 단위 정밀 박 간격(감지값). <=1 이면 bpm 기반
        lastBeatIdx = std::numeric_limits<int64>::min();   // 재생 시작 시 첫 박 경계 전 스퓨리어스 클릭 방지
    }
    float inputLevel() { return inPeak.exchange (0.0f); }   // 마지막 peak 읽고 리셋
    // 트랙 미터 수집 — 스템·녹음 트랙 + 마스터. 각 pkL/pkR exchange 로 소비.
    // 반환값: 하나라도 소리가 있었는지 (전부 0 이면 emit 생략)
    bool collectMeters (Array<var>& out)
    {
        bool any = false;
        auto add = [&] (int id, std::atomic<float>& pl, std::atomic<float>& pr)
        {
            const float l = pl.exchange (0.0f, std::memory_order_relaxed);
            const float r = pr.exchange (0.0f, std::memory_order_relaxed);
            if (l > 0.0f || r > 0.0f) any = true;
            auto* o = new DynamicObject();
            o->setProperty ("id", id);
            o->setProperty ("l", l);
            o->setProperty ("r", r);
            out.add (var (o));
        };
        add (0, mstPkL, mstPkR);                       // master (id = 0 예약)
        for (auto& s : stems) add (s->id, s->pkL, s->pkR);
        const ScopedTryLock sl (takesLock);
        if (sl.isLocked())
            for (auto& rt : recTracks) add (rt->id, rt->pkL, rt->pkR);
        return any;
    }
    // YIN 피치 검출 (De Cheveigné & Kawahara) — 옥타브 안정 + 포물선 보간으로 정밀.
    double detectPitch()
    {
        const int N = 4096;               // 저음(베이스)까지 커버
        const int W = N / 2;              // 최대 lag
        std::vector<float> buf (N);
        {
            const SpinLock::ScopedLockType sl (pitchLock);
            const int R = (int) pitchRing.size();
            for (int i = 0; i < N; ++i) buf[i] = pitchRing[(pitchW + i) % R];
        }
        double mean = 0; for (float v : buf) mean += v; mean /= N;
        double rms = 0; for (int i = 0; i < N; ++i) { buf[i] -= (float) mean; rms += buf[i] * (double) buf[i]; }
        rms = std::sqrt (rms / N);
        if (rms < 0.004) return 0.0;      // 너무 조용

        // 1) 차분 함수 d(tau)
        std::vector<double> d ((size_t) W, 0.0);
        for (int tau = 1; tau < W; ++tau)
        {
            double sum = 0;
            for (int i = 0; i < W; ++i) { const double diff = buf[i] - (double) buf[i + tau]; sum += diff * diff; }
            d[(size_t) tau] = sum;
        }
        // 2) 누적평균 정규화 차분 (CMND)
        std::vector<double> cmnd ((size_t) W, 1.0);
        double run = 0.0;
        for (int tau = 1; tau < W; ++tau)
        {
            run += d[(size_t) tau];
            cmnd[(size_t) tau] = run > 1e-12 ? d[(size_t) tau] * tau / run : 1.0;
        }
        // 3) 절대 임계 이하 첫 국소최소
        const double thresh = 0.15;
        int tau = -1;
        for (int t = 2; t < W - 1; ++t)
        {
            if (cmnd[(size_t) t] < thresh)
            {
                while (t + 1 < W && cmnd[(size_t) (t + 1)] < cmnd[(size_t) t]) ++t;
                tau = t; break;
            }
        }
        if (tau < 0)   // 임계 미달 → 전역 최소 (신뢰도 낮으면 버림)
        {
            double m = 1e9;
            for (int t = 2; t < W; ++t) if (cmnd[(size_t) t] < m) { m = cmnd[(size_t) t]; tau = t; }
            if (tau < 0 || m > 0.5) return 0.0;
        }
        // 4) 포물선 보간으로 tau 정밀화
        double betterTau = tau;
        if (tau > 0 && tau < W - 1)
        {
            const double s0 = cmnd[(size_t) (tau - 1)], s1 = cmnd[(size_t) tau], s2 = cmnd[(size_t) (tau + 1)];
            const double denom = 2.0 * (2.0 * s1 - s2 - s0);
            if (std::abs (denom) > 1e-12) betterTau = tau + (s2 - s0) / denom;
        }
        const double f = deviceSampleRate / betterTau;
        return (f >= 40.0 && f <= 2000.0) ? f : 0.0;
    }

    // 트랙 제어 (index = 스템 순서)
    void setTrack (int index, const var& gain, const var& mute, const var& solo, const var& pan)
    {
        if (index < 0 || index >= (int) stems.size()) return;
        auto& s = *stems[(size_t) index];
        if (! gain.isVoid()) s.gain = (float) (double) gain;
        if (! mute.isVoid()) s.mute = (bool) mute;
        if (! solo.isVoid()) s.solo = (bool) solo;
        if (! pan.isVoid())  s.pan  = jlimit (-1.0f, 1.0f, (float) (double) pan);
        recomputeSolos();
    }
    // ---- 볼륨 자동화 ----
    // id: 스템(90001+) 또는 녹음 트랙 id. points 는 {s:샘플, v:게인} 배열(샘플 오름차순)
    void setAutomation (int id, const var& points, const var& on)
    {
        std::vector<AutoPoint>* dst = nullptr;
        CriticalSection* lk = nullptr;
        std::atomic<bool>* flag = nullptr;
        for (auto& s : stems)     if (s->id == id) { dst = &s->autoPts; lk = &s->autoLock; flag = &s->autoOn; break; }
        if (dst == nullptr)
            for (auto& t : recTracks) if (t->id == id) { dst = &t->autoPts; lk = &t->autoLock; flag = &t->autoOn; break; }
        if (dst == nullptr) return;

        if (! points.isVoid())
        {
            std::vector<AutoPoint> np;
            if (auto* a = points.getArray())
                for (auto& v : *a)
                    np.push_back ({ (int64) (double) v["s"], jlimit (0.0f, 4.0f, (float) (double) v["v"]) });
            std::sort (np.begin(), np.end(), [] (const AutoPoint& a, const AutoPoint& b) { return a.s < b.s; });
            const ScopedLock sl (*lk);
            *dst = std::move (np);
        }
        if (! on.isVoid()) flag->store ((bool) on);
    }

    // ---- PDC (Plugin Delay Compensation) ----
    // 지연 있는 플러그인(linear-phase EQ, look-ahead 리미터 등)을 쓰면 그 트랙만 늦게 나온다.
    // 전 트랙 중 최대 지연에 맞춰 나머지 트랙을 그만큼 늦춰 박자를 다시 맞춘다.
    static int chainLatency (const FxChainVec& c)
    {
        int sum = 0;
        for (auto& sl : c)
            if (sl && sl->plugin && ! sl->bypass.load())
                sum += jmax (0, sl->plugin->getLatencySamples());
        return sum;
    }
    void recomputePdc (bool announce = true)
    {
        if (! pdcEnabled.load())
        {
            for (auto& s : stems)      s->pdcDelay.store (0);
            for (auto& rt : recTracks) rt->pdcDelay.store (0);
            if (announce && pdcMaxReported != 0) { pdcMaxReported = 0; emitPdc (0); }
            return;
        }
        const int cap = jmax (0, pdcCapacity - 1);
        std::vector<int> stemLat, recLat;
        int maxLat = 0;
        // 락은 전부 tryLock — 실패하면 이번 회차는 건너뛴다.
        // (블로킹 락을 쓰면 오디오 스레드가 FX 를 건너뛰어 드라이 신호가 튀어나온다)
        for (auto& s : stems)
        {
            const ScopedTryLock sl (s->fxLock);
            if (! sl.isLocked()) return;
            const int l = jmin (cap, chainLatency (s->chain));
            stemLat.push_back (l); maxLat = jmax (maxLat, l);
        }
        {
            const ScopedTryLock tl (takesLock);
            if (! tl.isLocked()) return;
            for (auto& rt : recTracks)
            {
                const ScopedTryLock sl (rt->fxLock);
                if (! sl.isLocked()) return;
                const int l = jmin (cap, chainLatency (rt->chain));
                recLat.push_back (l); maxLat = jmax (maxLat, l);
            }
            size_t i = 0;
            for (auto& rt : recTracks) rt->pdcDelay.store (jmax (0, maxLat - recLat[i++]));
        }
        size_t i = 0;
        for (auto& s : stems) s->pdcDelay.store (jmax (0, maxLat - stemLat[i++]));
        if (announce && maxLat != pdcMaxReported) { pdcMaxReported = maxLat; emitPdc (maxLat); }
    }
    void emitPdc (int samples)
    {
        auto* o = ev ("pdc");
        o->setProperty ("samples", samples);
        o->setProperty ("ms", deviceSampleRate > 0 ? samples * 1000.0 / deviceSampleRate : 0.0);
        o->setProperty ("on", pdcEnabled.load());
        emit (var (o));
    }
    void setPdcEnabled (bool on) { pdcEnabled = on; recomputePdc(); }

    void setMaster (float g)   { masterGain = g; }
    void setMonitor (float g)  { monitorGain = g; }
    void setInputMonitor (bool on) { monitorInputOn = on; }
    void setStemOffset (int64 samples) { declickPending = true; stemOffset = samples; }

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
            o->setProperty ("pan",  t->pan.load());
            o->setProperty ("mute", t->mute.load());
            o->setProperty ("solo", t->solo.load());
            o->setProperty ("type", t->type);
            o->setProperty ("armed", t->id == armedTrack.load());
            list.add (var (o));
        }
        auto* r = ev ("recTracks");
        r->setProperty ("list", var (list));
        r->setProperty ("gen", recTracksGen);   // 재구성 동기화 토큰 에코
        emit (var (r));
    }
    void emitChainFor (int trackId) { CriticalSection* lk = nullptr; if (auto* chain = fxChainOf (trackId, lk)) emitChainId (trackId, *chain); }
    void addRecTrack (int type = 0)
    {
        auto t = std::make_unique<RecTrack>();
        const int newId = nextRecId++;
        t->id = newId; t->type = type;
        { const ScopedLock sl (takesLock); recTracks.push_back (std::move (t)); }
        if (type == 0 && findRec (armedTrack.load()) == nullptr) armedTrack = newId;   // 녹음 트랙만 자동 arm
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
    void armRec (int id) { if (auto* rt = findRec (id)) if (rt->type == 0) { armedTrack = id; emitRecTracks(); } }   // 오디오 트랙은 녹음 대상 불가
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
                if (! v["type"].isVoid()) t->type = (int) v["type"];
                if (! v["gain"].isVoid()) t->gain = (float) (double) v["gain"];
                if (! v["pan"].isVoid())  t->pan  = jlimit (-1.0f, 1.0f, (float) (double) v["pan"]);
                if (! v["mute"].isVoid()) t->mute = (bool) v["mute"];
                if (! v["solo"].isVoid()) t->solo = (bool) v["solo"];
                const ScopedLock sl (takesLock);
                recTracks.push_back (std::move (t));
            }
        armedTrack = 0;
        for (auto& t : recTracks) if (t->type == 0) { armedTrack = t->id; break; }   // 첫 녹음 트랙 arm
        recomputeSolos();
        emitRecTracks();
    }
    void setRecTrack (int id, const var& gain, const var& mute, const var& solo, const var& pan)
    {
        auto* t = findRec (id);
        if (t == nullptr) return;
        if (! gain.isVoid()) t->gain = (float) (double) gain;
        if (! mute.isVoid()) t->mute = (bool) mute;
        if (! solo.isVoid()) t->solo = (bool) solo;
        if (! pan.isVoid())  t->pan  = jlimit (-1.0f, 1.0f, (float) (double) pan);
        recomputeSolos();
    }
    void moveTake (int64 id, int64 newStart, int trackId)   // trackId>0 이면 트랙 이동
    {
        const ScopedLock sl (takesLock);
        for (auto& t : takesPlay) if (t->id == id) { t->start = newStart; if (trackId > 0) t->trackId = trackId; break; }
    }
    // 클립 트림 — 타임라인 start·버퍼 내 시작·길이 갱신 (버퍼 범위로 클램프)
    void trimTake (int64 id, int64 start, int64 inOffset, int64 len)
    {
        const ScopedLock sl (takesLock);
        for (auto& t : takesPlay) if (t->id == id)
        {
            const int64 total = t->buf.getNumSamples();
            int64 io = jlimit<int64> (0, jmax<int64> (0, total - 1), inOffset);
            int64 ln = jlimit<int64> (1, total - io, len);
            t->start = jmax<int64> (0, start); t->inOffset = io; t->len = ln;
            t->fadeIn  = jmin (t->fadeIn, ln);   // 길이보다 긴 페이드 클램프
            t->fadeOut = jmin (t->fadeOut, ln);
            break;
        }
    }
    // 클립 페이드 인/아웃 설정(샘플)
    void setFade (int64 id, int64 fadeIn, int64 fadeOut)
    {
        const ScopedLock sl (takesLock);
        for (auto& t : takesPlay) if (t->id == id)
        {
            t->fadeIn  = jlimit<int64> (0, t->len, fadeIn);
            t->fadeOut = jlimit<int64> (0, t->len, fadeOut);
            break;
        }
    }
    // 클립 분할 — atSample(타임라인) 에서 둘로. 새 클립 id 를 받음(버퍼 공유 복사)
    void splitTake (int64 id, int64 atSample, int64 newId)
    {
        const ScopedLock sl (takesLock);
        for (size_t i = 0; i < takesPlay.size(); ++i)
        {
            auto& t = takesPlay[i];
            if (t->id != id) continue;
            const int64 rel = atSample - t->start;
            if (rel <= 0 || rel >= t->len) return;   // 클립 안에서만 분할
            auto nt = std::make_unique<TakePlay>();
            nt->buf = t->buf;                          // 버퍼 복사(공유 소스)
            nt->id = newId > 0 ? newId : nextTakeId++;
            if (nt->id >= nextTakeId) nextTakeId = nt->id + 1;
            nt->start   = t->start + rel;
            nt->inOffset = t->inOffset + rel;
            nt->len     = t->len - rel;
            nt->trackId = t->trackId;
            nt->path    = t->path;
            nt->fadeOut = jmin (t->fadeOut, nt->len);   // 페이드아웃은 뒷조각으로
            nt->fadeIn  = 0;
            t->len = rel;                               // 원본은 앞부분
            t->fadeIn  = jmin (t->fadeIn, t->len);      // 페이드인은 앞조각 유지
            t->fadeOut = 0;
            takesPlay.push_back (std::move (nt));
            return;
        }
    }
    void setBypass (int trackId, int id, bool on)
    {
        CriticalSection* lk = nullptr; auto* chain = fxChainOf (trackId, lk); if (chain == nullptr) return;
        if (auto* s = findSlotIn (*chain, id)) { s->bypass = on; recomputePdc(); emitChainId (trackId, *chain); }
    }
    void setBypassAll (int trackId, bool on)   // 일괄 끄기/켜기
    {
        CriticalSection* lk = nullptr; auto* chain = fxChainOf (trackId, lk); if (chain == nullptr) return;
        for (auto& s : *chain) if (s) s->bypass = on;
        recomputePdc();
        emitChainId (trackId, *chain);
    }
    void removeFx (int trackId, int id)
    {
        CriticalSection* lk = nullptr; auto* chain = fxChainOf (trackId, lk); if (chain == nullptr) return;
        if (auto* s = findSlotIn (*chain, id)) s->editor.reset();   // message 스레드
        std::unique_ptr<FxSlot> dead;   // 플러그인 소멸은 락 밖에서 — 소멸이 길면 오디오가 끊긴다
        {
            const ScopedLock sl (*lk);
            auto it = std::find_if (chain->begin(), chain->end(), [id] (auto& x) { return x && x->id == id; });
            if (it != chain->end()) { dead = std::move (*it); chain->erase (it); }
        }
        dead.reset();
        recomputePdc();
        emitChainId (trackId, *chain);
    }
    void reorderFx (int trackId, const Array<int>& order)
    {
        CriticalSection* lk = nullptr; auto* chain = fxChainOf (trackId, lk); if (chain == nullptr) return;
        {
            const ScopedLock sl (*lk);
            std::vector<std::unique_ptr<FxSlot>> next;
            for (int id : order)
            {
                auto it = std::find_if (chain->begin(), chain->end(), [id] (auto& x) { return x && x->id == id; });
                if (it != chain->end()) { next.push_back (std::move (*it)); }
            }
            for (auto& x : *chain) if (x) next.push_back (std::move (x));   // 누락분 보존
            *chain = std::move (next);
        }
        recomputePdc();
        emitChainId (trackId, *chain);
    }
    // VST 세부 설정(노브값) 직렬화 — 슬롯 단위 base64
    void fxSaveState (int trackId, int id)
    {
        CriticalSection* lk = nullptr; auto* chain = fxChainOf (trackId, lk); if (chain == nullptr) return;
        auto* s = findSlotIn (*chain, id); if (s == nullptr) return;
        MemoryBlock mb;
        if (s->plugin == nullptr) return;
        s->plugin->getStateInformation (mb);
        auto* o = ev ("fxState");
        o->setProperty ("trackId", trackId);
        o->setProperty ("id", id);
        o->setProperty ("data", Base64::toBase64 (mb.getData(), mb.getSize()));
        emit (var (o));
    }
    void fxSetState (int trackId, int id, const String& b64)
    {
        CriticalSection* lk = nullptr; auto* chain = fxChainOf (trackId, lk); if (chain == nullptr) return;
        auto* s = findSlotIn (*chain, id);
        if (s == nullptr || s->plugin == nullptr || b64.isEmpty()) return;
        MemoryOutputStream mo;
        if (Base64::convertFromBase64 (mo, b64))
        {
            const ScopedLock sl (*lk);
            s->plugin->setStateInformation (mo.getData(), (int) mo.getDataSize());
        }
    }
    void showEditor (int trackId, int id)
    {
        CriticalSection* lk = nullptr; auto* chain = fxChainOf (trackId, lk); if (chain == nullptr) return;
        auto* s = findSlotIn (*chain, id);
        if (s == nullptr || s->plugin == nullptr || ! s->plugin->hasEditor()) return;
        if (s->editor != nullptr) { s->editor->setVisible (true); s->editor->toFront (true); return; }
        s->editor.reset (new PluginWindow (s->plugin->createEditorIfNeeded(), s->plugin->getName()));
        s->editor->toFront (true);
    }
    void clearChainVec (FxChainVec& chain, CriticalSection& lock)
    {
        for (auto& s : chain) if (s) s->editor.reset();
        const ScopedLock sl (lock);
        chain.clear();
    }
    void clearChain (RecTrack& rt) { clearChainVec (rt.chain, rt.fxLock); recomputePdc (false); }
    void clearAllChains() { for (auto& rt : recTracks) clearChain (*rt); for (auto& s : stems) clearChainVec (s->chain, s->fxLock); }
    // 프리셋 로드 — 체인 전체를 한 번에 재구성(원자적). churn 없이 안전.
    void setChain (int trackId, const var& list)
    {
        CriticalSection* lk = nullptr; auto* chain = fxChainOf (trackId, lk); if (chain == nullptr) return;
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
                slot->desc = scanned[index];
                slot->bypass = (bool) v["bypass"];
                slot->plugin = std::move (inst);
                next.push_back (std::move (slot));
            }

        std::vector<std::unique_ptr<FxSlot>> old;   // 이전 체인은 락 밖에서 소멸(에디터/플러그인 소멸이 오디오 스레드 안 막게)
        {
            const ScopedLock sl (*lk);
            old.swap (*chain);
            *chain = std::move (next);
        }
        for (auto& s : old) if (s) s->editor.reset();   // message 스레드에서 정리
        old.clear();
        recomputePdc();
        if (failed > 0) { auto* e = ev ("fxError"); e->setProperty ("trackId", trackId); e->setProperty ("failed", failed); emit (var (e)); }
        emitChainId (trackId, *chain);
    }

    // ---- Export: 전체 믹스 오프라인 렌더링(스템+테이크→트랙 FX→마스터) (message 스레드) ----
    //   format: wav | flac | aiff (MP3 은 렌더러가 WAV 렌더 후 ffmpeg 변환)
    void exportMix (const String& outPath, const String& format, int bitDepth, bool mineOnly, double startSec, double endSec)
    {
        const double sr = (deviceSampleRate > 0 ? deviceSampleRate : stemSampleRate);
        const int block = 2048;
        if (pluginFmt.getNumFormats() == 0) addDefaultFormatsToManager (pluginFmt);

        const int64 soff = stemOffset.load();
        const bool anySolo = anyStemSolo.load() || anyRecSolo.load();
        int64 total = 0;

        // 스템: 프레시 리더(실시간 소스와 공유 안 함). "내 녹음만" 이면 스킵
        struct SR { std::unique_ptr<AudioFormatReaderSource> src; float gain; bool audible;
                    bool autoOn; std::vector<AutoPoint> autoPts;
                    std::vector<std::unique_ptr<AudioPluginInstance>> fx; int latency = 0;
                    AudioBuffer<float> pdc; int pdcW = 0; int pdcD = 0; };
        std::vector<SR> srs;
        if (! mineOnly)
            for (auto& s : stems)
            {
                auto* rd = fmt.createReaderFor (File (s->path));
                if (rd == nullptr) continue;
                auto src = std::make_unique<AudioFormatReaderSource> (rd, true);
                src->prepareToPlay (block, sr);
                total = jmax (total, soff + rd->lengthInSamples);
                std::vector<AutoPoint> ap;
                { const ScopedLock al (s->autoLock); ap = s->autoPts; }   // 스냅샷
                SR sr2;
                sr2.src = std::move (src);
                sr2.gain = s->gain.load();
                sr2.audible = anySolo ? s->solo.load() : ! s->mute.load();
                sr2.autoOn = s->autoOn.load();
                sr2.autoPts = std::move (ap);
                {   // 스템 FX 체인도 오프라인 인스턴스로 복제 (실시간과 결과가 같아야 함)
                    const ScopedLock fl (s->fxLock);
                    for (auto& slot : s->chain)
                    {
                        if (! slot || ! slot->plugin || slot->bypass.load()) continue;
                        String err;
                        auto inst = pluginFmt.createPluginInstance (slot->desc, sr, block, err);
                        if (inst == nullptr) continue;
                        MemoryBlock mb; slot->plugin->getStateInformation (mb);
                        inst->setPlayConfigDetails (2, 2, sr, block);
                        inst->prepareToPlay (sr, block);
                        inst->setStateInformation (mb.getData(), (int) mb.getSize());
                        sr2.latency += jmax (0, inst->getLatencySamples());
                        sr2.fx.push_back (std::move (inst));
                    }
                }
                srs.push_back (std::move (sr2));
            }

        // 트랙: 테이크 버퍼 스냅샷 + 프레시 FX 인스턴스(라이브 체인 상태 복제)
        struct TR { AudioBuffer<float> buf; int64 start; int64 len; int64 inOffset; int64 fadeIn; int64 fadeOut; };
        struct TRK { float gain; bool audible; std::vector<std::unique_ptr<AudioPluginInstance>> fx; std::vector<TR> takes;
                     bool autoOn; std::vector<AutoPoint> autoPts; int latency = 0;
                     AudioBuffer<float> pdc; int pdcW = 0; int pdcD = 0; };
        std::vector<TRK> trks;
        {
            const bool trackSolo = mineOnly ? anyRecSolo.load() : anySolo;   // 내 녹음만이면 스템 솔로 무시
            const ScopedLock lk (takesLock);
            for (auto& rt : recTracks)
            {
                TRK tk; tk.gain = rt->gain.load(); tk.audible = trackSolo ? rt->solo.load() : ! rt->mute.load();
                tk.autoOn = rt->autoOn.load();
                { const ScopedLock al (rt->autoLock); tk.autoPts = rt->autoPts; }   // 스냅샷
                {
                    const ScopedLock fl (rt->fxLock);
                    for (auto& slot : rt->chain)
                    {
                        if (! slot || ! slot->plugin || slot->bypass.load()) continue;
                        String err;
                        auto inst = pluginFmt.createPluginInstance (slot->desc, sr, block, err);
                        if (inst == nullptr) continue;
                        MemoryBlock mb; slot->plugin->getStateInformation (mb);
                        inst->setPlayConfigDetails (2, 2, sr, block);
                        inst->prepareToPlay (sr, block);
                        inst->setStateInformation (mb.getData(), (int) mb.getSize());
                        tk.latency += jmax (0, inst->getLatencySamples());
                        tk.fx.push_back (std::move (inst));
                    }
                }
                for (auto& t : takesPlay)
                {
                    if (t->trackId != rt->id) continue;
                    TR tr; tr.buf = t->buf; tr.start = t->start; tr.len = t->len; tr.inOffset = t->inOffset; tr.fadeIn = t->fadeIn; tr.fadeOut = t->fadeOut;   // 스냅샷
                    total = jmax (total, t->start + t->len);
                    tk.takes.push_back (std::move (tr));
                }
                trks.push_back (std::move (tk));
            }
        }

        if (total <= 0) { auto* e = ev ("exportError"); e->setProperty ("msg", "내보낼 오디오가 없습니다"); emit (var (e)); return; }

        File out (outPath); out.deleteFile();
        std::unique_ptr<FileOutputStream> os (out.createOutputStream());
        if (os == nullptr) { auto* e = ev ("exportError"); e->setProperty ("msg", "파일 열기 실패"); emit (var (e)); return; }

        std::unique_ptr<AudioFormat> af;
        if      (format == "flac") af.reset (new FlacAudioFormat());
        else if (format == "aiff") af.reset (new AiffAudioFormat());
        else                       af.reset (new WavAudioFormat());
        int bits = bitDepth > 0 ? bitDepth : 24;
        const auto allowed = af->getPossibleBitDepths();          // 포맷이 지원하는 비트뎁스로 보정
        if (! allowed.contains (bits)) bits = allowed.isEmpty() ? 24 : allowed.getLast();
        const bool isFloat = (bits == 32 && format != "flac");    // 32-bit = float(WAV/AIFF)
        std::unique_ptr<AudioFormatWriter> writer (af->createWriterFor (os.get(), sr, 2, bits, {}, 0));
        if (writer == nullptr) { auto* e = ev ("exportError"); e->setProperty ("msg", "이 포맷/비트뎁스 지원 안 됨"); emit (var (e)); return; }
        os.release();

        // 내보내기 범위 (선택 없으면 전체)
        int64 s0 = startSec > 0 ? (int64) (startSec * sr) : 0;
        int64 s1 = endSec   > 0 ? (int64) (endSec   * sr) : total;
        s0 = jlimit<int64> (0, total, s0);
        s1 = jlimit<int64> (s0 + 1, total, s1);
        const int64 span = s1 - s0;

        // ── PDC — 실시간과 동일하게 트랙 간 정렬을 맞춘다 ──
        // 스템은 FX 를 오프라인에서 재적용하지 않으므로 지연 0. 트랙만 지연을 가진다.
        int maxLat = 0;
        for (auto& r : srs)   maxLat = jmax (maxLat, r.latency);
        for (auto& tk : trks) maxLat = jmax (maxLat, tk.latency);
        if (! pdcEnabled.load()) maxLat = 0;
        if (maxLat > 0)
        {
            const int cap = maxLat + block + 8;
            for (auto& r : srs)
            {
                r.pdcD = jmax (0, maxLat - r.latency);
                if (r.pdcD > 0) { r.pdc.setSize (2, cap); r.pdc.clear(); r.pdcW = 0; }
            }
            for (auto& tk : trks)
            {
                tk.pdcD = jmax (0, maxLat - tk.latency);
                if (tk.pdcD > 0) { tk.pdc.setSize (2, cap); tk.pdc.clear(); tk.pdcW = 0; }
            }
        }

        AudioBuffer<float> mix (2, block), sbuf (2, block), tbuf (2, block), tmp (2, block);
        const float mg = monitorGain.load();
        const float master = masterGain.load();
        // 전체가 maxLat 만큼 늦게 나오므로 그만큼 앞에서부터 렌더해 버리고(프리롤) 파일에는 안 쓴다
        int64 pos = s0 - maxLat; int blk = 0;
        int64 skip = maxLat;
        while (pos < s1)
        {
            const int n = (int) jmin<int64> ((int64) block, s1 - pos);
            if (n <= 0) break;
            mix.clear();

            for (auto& r : srs)   // 스템
            {
                sbuf.clear();
                r.src->setNextReadPosition (jmax<int64> (0, pos - soff));
                AudioSourceChannelInfo info (&sbuf, 0, n); r.src->getNextAudioBlock (info);
                if (! r.fx.empty())   // 스템 FX 체인 (실시간과 동일하게 적용)
                {
                    AudioBuffer<float> pb (sbuf.getArrayOfWritePointers(), 2, n);
                    MidiBuffer mm;
                    for (auto& fxp : r.fx) fxp->processBlock (pb, mm);
                }
                if (r.pdcD > 0) applyDelayLine (sbuf, n, r.pdc, r.pdcW, r.pdcD);
                if (r.audible)
                {
                    // 자동화 ON 이면 블록 시작→끝 값으로 램프 (오프라인에서도 곡선 그대로)
                    const float g0 = r.autoOn ? autoValueAt (r.autoPts, pos)     : r.gain;
                    const float g1 = r.autoOn ? autoValueAt (r.autoPts, pos + n) : r.gain;
                    for (int c = 0; c < 2; ++c)
                    {
                        const int sc = jmin (c, sbuf.getNumChannels() - 1);
                        if (g0 == g1) mix.addFrom (c, 0, sbuf, sc, 0, n, g0);
                        else          mix.addFromWithRamp (c, 0, sbuf.getReadPointer (sc), n, g0, g1);
                    }
                }
            }

            for (auto& tk : trks)   // 트랙(테이크 → FX → post-fx 게인)
            {
                if (! tk.audible) continue;
                tbuf.clear();
                bool any = false;
                for (auto& t : tk.takes)
                {
                    const int64 rp = pos - t.start;
                    if (rp < 0 || rp >= t.len) continue;
                    const int nn = (int) jmin<int64> ((int64) n, t.len - rp);
                    if (t.fadeIn <= 0 && t.fadeOut <= 0)
                        for (int c = 0; c < 2; ++c) tbuf.addFrom (c, 0, t.buf, jmin (c, t.buf.getNumChannels() - 1), (int) (t.inOffset + rp), nn);
                    else
                    {
                        AudioBuffer<float> ct (2, nn);
                        for (int c = 0; c < 2; ++c) ct.copyFrom (c, 0, t.buf, jmin (c, t.buf.getNumChannels() - 1), (int) (t.inOffset + rp), nn);
                        applyClipFades (ct, rp, t.len, t.fadeIn, t.fadeOut, nn);
                        for (int c = 0; c < 2; ++c) tbuf.addFrom (c, 0, ct, c, 0, nn);
                    }
                    any = true;
                }
                if (! any && tk.fx.empty()) continue;
                { AudioBuffer<float> pb (tbuf.getArrayOfWritePointers(), 2, n); MidiBuffer mm; for (auto& f : tk.fx) f->processBlock (pb, mm); }
                if (tk.pdcD > 0) applyDelayLine (tbuf, n, tk.pdc, tk.pdcW, tk.pdcD);
                {
                    const float g0 = (tk.autoOn ? autoValueAt (tk.autoPts, pos)     : tk.gain) * mg;
                    const float g1 = (tk.autoOn ? autoValueAt (tk.autoPts, pos + n) : tk.gain) * mg;
                    for (int c = 0; c < 2; ++c)
                    {
                        if (g0 == g1) mix.addFrom (c, 0, tbuf, c, 0, n, g0);
                        else          mix.addFromWithRamp (c, 0, tbuf.getReadPointer (c), n, g0, g1);
                    }
                }
            }

            mix.applyGain (0, n, master);   // 마스터 (+ 정수 포맷은 세이프 클리퍼, float 은 헤드룸 보존)
            if (! isFloat)
                for (int c = 0; c < 2; ++c)
                {
                    FloatVectorOperations::max (mix.getWritePointer (c), mix.getReadPointer (c), -1.0f, n);
                    FloatVectorOperations::min (mix.getWritePointer (c), mix.getReadPointer (c),  1.0f, n);
                }
            if (skip > 0)   // 프리롤 — PDC 로 밀린 앞부분은 버린다
            {
                const int64 drop = jmin<int64> (skip, n);
                skip -= drop;
                if (drop < n) writer->writeFromAudioSampleBuffer (mix, (int) drop, n - (int) drop);
            }
            else writer->writeFromAudioSampleBuffer (mix, 0, n);
            pos += n;
            if ((++blk % 40) == 0) { auto* p = ev ("exportProgress");
                p->setProperty ("pct", jlimit (0.0, 100.0, (double) (pos - s0) / (double) span * 100.0)); emit (var (p)); }
        }
        writer.reset();   // flush + close
        auto* d = ev ("exportDone"); d->setProperty ("file", outPath); emit (var (d));
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
        for (auto& st : stems) { const ScopedLock sl (st->fxLock); for (auto& s : st->chain) if (s && s->plugin) s->plugin->prepareToPlay (deviceSampleRate, block); }
        // PDC 링버퍼 — 최대 1초까지 보정. 오디오 스레드에서 절대 재할당하지 않도록 여기서 확보
        pdcCapacity = (int) (deviceSampleRate * 1.0) + block + 8;
        for (auto& st : stems)     { st->pdcBuf.setSize (2, pdcCapacity); st->pdcBuf.clear(); st->pdcWrite = 0; st->pdcActive = 0; }
        for (auto& rt : recTracks) { rt->pdcBuf.setSize (2, pdcCapacity); rt->pdcBuf.clear(); rt->pdcWrite = 0; rt->pdcActive = 0; }
        pdcMaxReported = -1;
        recomputePdc();
        scratch.setSize (2, block);
        stemFxBuf.setSize (2, block);   // 오디오 스레드에서 재할당되지 않도록 미리 확보
        fxBuf.setSize (2, block);
        clipTmp.setSize (2, block);
        pitchRing.assign (4096, 0.0f); pitchW = 0;
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
                if (s->autoOn.load())   // 자동화 ON — 페이더 대신 곡선 값(read 모드)
                {
                    const ScopedTryLock al (s->autoLock);
                    if (al.isLocked()) s->curAutoGain = autoValueAt (s->autoPts, phStart);
                }
                const float fader = s->autoOn.load() ? s->curAutoGain : s->gain.load();
                const float g = audible ? fader : 0.0f;   // 뮤트/솔로도 램프로 declick
                float pL, pR; panGains (s->pan.load(), pL, pR);
                const float tgtL = g * pL, tgtR = g * pR;

                // 스템별 독립 FX 체인 (있으면 별도 버퍼에서 처리 후 합산)
                const ScopedTryLock fl (s->fxLock);
                AudioBuffer<float>* srcBuf = &scratch;
                if (fl.isLocked() && ! s->chain.empty())
                {
                    stemFxBuf.setSize (2, numSamples, false, false, true);   // 플러그인 구성(2in/2out)과 일치
                    stemFxBuf.clear();
                    for (int c = 0; c < stemFxBuf.getNumChannels(); ++c)
                        stemFxBuf.copyFrom (c, 0, scratch, jmin (c, scratch.getNumChannels() - 1), 0, numSamples);
                    for (auto& sl : s->chain)
                        if (sl && sl->plugin && ! sl->bypass.load()) { MidiBuffer mm; sl->plugin->processBlock (stemFxBuf, mm); }
                    srcBuf = &stemFxBuf;
                }
                {   // PDC — 다른 트랙의 플러그인 지연에 맞춰 이 트랙을 늦춤
                    const int want = s->pdcDelay.load();
                    if (want != s->pdcActive) { s->pdcBuf.clear(); s->pdcWrite = 0; s->pdcActive = want; }
                    applyDelayLine (*srcBuf, numSamples, s->pdcBuf, s->pdcWrite, s->pdcActive);
                }
                const float* srcL = srcBuf->getReadPointer (0);
                const float* srcR = srcBuf->getReadPointer (jmin (1, srcBuf->getNumChannels() - 1));
                if (numOut >= 2)
                {
                    addRamped (outputs[0], srcL, numSamples, s->curGainL, tgtL);
                    addRamped (outputs[1], srcR, numSamples, s->curGainR, tgtR);
                }
                else
                    addRamped (outputs[0], srcL, numSamples, s->curGainL, tgtL);
                updatePeak (s->pkL, blockPeak (srcL, numSamples, s->curGainL, tgtL));
                updatePeak (s->pkR, blockPeak (srcR, numSamples, s->curGainR, tgtR));
                s->curGainL = tgtL; s->curGainR = tgtR;
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
                    if (rt->autoOn.load())   // 자동화 ON — 페이더 대신 곡선 값(read 모드)
                    {
                        const ScopedTryLock al (rt->autoLock);
                        if (al.isLocked()) rt->curAutoGain = autoValueAt (rt->autoPts, phStart);
                    }
                    const float fader = rt->autoOn.load() ? rt->curAutoGain : rt->gain.load();
                    const float g = (audible ? fader : 0.0f) * mg;   // 페이더는 FX 뒤(post-FX)
                    float pL, pR; panGains (rt->pan.load(), pL, pR);
                    const float tgtL = g * pL, tgtR = g * pR;
                    if (rt->curGainL == 0.0f && rt->curGainR == 0.0f && tgtL == 0.0f && tgtR == 0.0f) continue;

                    fxBuf.setSize (2, numSamples, false, false, true);   // 플러그인 구성(2in/2out)과 일치
                    fxBuf.clear();

                    // 테이크·입력은 유니티로 버스에 모음 (게인은 FX 뒤에 적용). 메모리 버퍼에서 직접(디스크 I/O 없음)
                    if (playing.load())
                        for (auto& t : takesPlay)
                        {
                            if (t->trackId != rt->id) continue;
                            const int64 pos = phStart - t->start;
                            if (pos < 0 || pos >= t->len) continue;
                            const int n2 = (int) jmin<int64> ((int64) numSamples, t->len - pos);
                            if (t->fadeIn <= 0 && t->fadeOut <= 0)   // 페이드 없음 — 직접 add
                                for (int c = 0; c < fxBuf.getNumChannels(); ++c)
                                    fxBuf.addFrom (c, 0, t->buf, jmin (c, t->buf.getNumChannels() - 1), (int) (t->inOffset + pos), n2);
                            else   // 페이드 반영: 임시로 복사 후 엔벨로프 적용, 합산
                            {
                                clipTmp.setSize (fxBuf.getNumChannels(), n2, false, false, true);
                                for (int c = 0; c < fxBuf.getNumChannels(); ++c)
                                    clipTmp.copyFrom (c, 0, t->buf, jmin (c, t->buf.getNumChannels() - 1), (int) (t->inOffset + pos), n2);
                                applyClipFades (clipTmp, pos, t->len, t->fadeIn, t->fadeOut, n2);
                                for (int c = 0; c < fxBuf.getNumChannels(); ++c)
                                    fxBuf.addFrom (c, 0, clipTmp, c, 0, n2);
                            }
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

                    {   // PDC
                        const int want = rt->pdcDelay.load();
                        if (want != rt->pdcActive) { rt->pdcBuf.clear(); rt->pdcWrite = 0; rt->pdcActive = want; }
                        applyDelayLine (fxBuf, numSamples, rt->pdcBuf, rt->pdcWrite, rt->pdcActive);
                    }
                    // post-FX 페이더 + 팬(L/R 결합 램프) + peak
                    const float* rtL = fxBuf.getReadPointer (0);
                    const float* rtR = fxBuf.getReadPointer (jmin (1, fxBuf.getNumChannels() - 1));
                    if (numOut >= 2)
                    {
                        addRamped (outputs[0], rtL, numSamples, rt->curGainL, tgtL);
                        addRamped (outputs[1], rtR, numSamples, rt->curGainR, tgtR);
                    }
                    else
                        addRamped (outputs[0], rtL, numSamples, rt->curGainL, tgtL);
                    updatePeak (rt->pkL, blockPeak (rtL, numSamples, rt->curGainL, tgtL));
                    updatePeak (rt->pkR, blockPeak (rtR, numSamples, rt->curGainR, tgtR));
                    rt->curGainL = tgtL; rt->curGainR = tgtR;
                }
            }
        }

        // 메트로놈 클릭 — 다운비트(phase) + 정밀 박 간격(interval) 균일 그리드.
        // 재생 중일 때만, 박 경계에서만 클릭(음원 밖·다운비트 이전 포함).
        if (metroOn.load() && numOut > 0)
        {
            const int clickLen = (int) (deviceSampleRate * 0.06);
            double interval = metroInterval.load();
            if (interval <= 1.0) interval = 60.0 / metroBpm.load() * deviceSampleRate;   // 폴백
            const double phase = (double) metroPhase.load();
            const bool playing_ = playing.load();
            for (int i = 0; i < numSamples; ++i)
            {
                if (playing_)
                {
                    const int64 beatIdx = (int64) std::floor (((double) (phStart + i) - phase) / interval + 1e-6);
                    if (lastBeatIdx == std::numeric_limits<int64>::min()) lastBeatIdx = beatIdx;   // 시작 지점: 클릭 없이 기준만
                    else if (beatIdx != lastBeatIdx) { lastBeatIdx = beatIdx; clickPos = 0; }       // 경계 넘을 때만
                }
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

            // ── 디클릭 ──
            // 시크/재생·정지 직후 첫 블록은 파형이 뚝 끊겨 '틱' 이 난다.
            // out[i] += (직전 마지막 샘플 - 이번 첫 샘플) * w(i)  →  i=0 에서 연속, w 가 0 이 되면 원본 그대로.
            if (declickPending.exchange (false))
            {
                declickLen = jmax (16, (int) (deviceSampleRate * 0.006));   // 6 ms
                declickPos = 0;
                for (int c = 0; c < 2; ++c)
                {
                    const int sc = jmin (c, numOut - 1);
                    declickDelta[c] = declickPrev[c] - outputs[sc][0];
                }
            }
            if (declickPos < declickLen)
            {
                const int n2 = jmin (numSamples, declickLen - declickPos);
                for (int c = 0; c < numOut; ++c)
                {
                    float* d = outputs[c];
                    const float delta = declickDelta[jmin (c, 1)];
                    if (delta == 0.0f) continue;
                    for (int i = 0; i < n2; ++i)
                        d[i] += delta * (1.0f - (float) (declickPos + i) / (float) declickLen);
                }
                declickPos += n2;
            }

            for (int c = 0; c < numOut; ++c)
            {
                FloatVectorOperations::max (outputs[c], outputs[c], -1.0f, numSamples);
                FloatVectorOperations::min (outputs[c], outputs[c],  1.0f, numSamples);
            }
            for (int c = 0; c < 2; ++c)   // 다음 블록 디클릭 기준값
                declickPrev[c] = outputs[jmin (c, numOut - 1)][numSamples - 1];

            // 마스터 peak — 최종 출력 기준(마스터 게인·클리퍼 이후)
            updatePeak (mstPkL, blockPeak (outputs[0], numSamples, 1.0f, 1.0f));
            updatePeak (mstPkR, blockPeak (outputs[jmin (1, numOut - 1)], numSamples, 1.0f, 1.0f));
        }
        lastMasterGain = master;

        // 녹음
        if (recordArmed.load())
        {
            if (recordedStart.load() < 0 && playing.load())
                recordedStart = phStart;   // 이 블록 입력에 대응하는 위치(증분 전 phStart). playhead 는 이미 +numSamples 됨

            // writer 가 기대하는 채널 수보다 입력이 적으면 범위 밖을 읽어 잡음이 섞인다 → 방어
            if (recordedStart.load() >= 0 && numIn >= writerChans)
                if (auto* w = activeWriter.load())
                    if (! w->write (inputs, numSamples))
                        ++recDropBlocks;   // FIFO 가 밀림 = 녹음에 끊김이 생긴 지점
        }
    }

private:
    void finishRecording()
    {
        if (! recordArmed.exchange (false) && threadedWriter == nullptr) return;
        activeWriter.store (nullptr);
        threadedWriter.reset();   // flush + close
        {
            const int dropped = recDropBlocks.exchange (0);
            if (dropped > 0)
                std::cerr << "[engine] WARN 녹음 중 " << dropped
                          << " 블록 쓰기 실패 — 파일에 끊김이 있을 수 있음" << std::endl;
        }
        const int64 start = recordedStart.exchange (-1);
        if (start >= 0)
        {
            const int64 comp = inLatSamp + outLatSamp;                 // 왕복 지연 = PDC
            const int64 timelineStart = jmax<int64> (0, start - comp); // 테이크를 앞당겨 정렬

            // 녹음 파일을 재생 버퍼로 등록 (녹음은 이미 디바이스 SR → 리샘플 없음)
            {
                auto tp = std::make_unique<TakePlay>();
                tp->len = loadClipBuffer (outFile, tp->buf);
                if (tp->len > 0)
                {
                    const int64 takeId = nextTakeId++;
                    tp->id = takeId;
                    tp->start = timelineStart;
                    tp->trackId = armedTrack.load();
                    lastTakeId = takeId;
                    const ScopedLock sl (takesLock);
                    takesPlay.push_back (std::move (tp));
                }
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
    AudioBuffer<float> stemFxBuf;// 스템 FX 처리용 스크래치
    AudioBuffer<float> clipTmp;// 페이드 적용용 클립 스크래치

    std::atomic<bool>  playing { false };
    std::atomic<int64> playhead { 0 };
    std::atomic<float> monitorGain { 1.0f };
    std::atomic<float> masterGain { 1.0f };
    float lastMasterGain = 1.0f;   // 마스터 게인 램프용 (오디오 스레드 전용)
    // ── 디클릭 — 시크·재생/정지 시 파형 불연속 제거 ──
    // 다음 블록 첫 샘플이 직전 출력 마지막 샘플과 이어지도록 오프셋을 넣고 서서히 없앤다.
    std::atomic<bool> pdcEnabled { true };   // 녹음 중 모니터 지연이 싫으면 끌 수 있음
    int pdcCapacity = 0;                     // 링버퍼 용량(샘플) — aboutToStart 에서 할당
    int pdcMaxReported = -1;                 // 마지막으로 통지한 최대 지연
    std::atomic<bool> declickPending { false };
    float declickPrev[2]  = { 0.0f, 0.0f };   // 직전 블록의 마지막 출력 샘플
    float declickDelta[2] = { 0.0f, 0.0f };   // 이어붙일 오프셋
    int   declickPos = 0, declickLen = 0;     // 진행 위치 / 전체 길이(샘플)
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
    std::atomic<float> mstPkL { 0.0f }, mstPkR { 0.0f };   // master post-sum peak
    std::vector<float> pitchRing = std::vector<float> (4096, 0.0f);
    int pitchW = 0;
    SpinLock pitchLock;
    std::atomic<bool> metroOn { false };
    std::atomic<double> metroBpm { 120.0 };
    std::atomic<int64> metroPhase { 0 };        // 다운비트 위상(샘플, 타임라인)
    std::atomic<double> metroInterval { 0.0 };  // 정밀 박 간격(샘플). <=1 이면 bpm 기반
    int64 lastBeatIdx = std::numeric_limits<int64>::min();
    int clickPos = -1;

    TimeSliceThread writerThread;
    std::unique_ptr<AudioFormatWriter::ThreadedWriter> threadedWriter;
    std::atomic<AudioFormatWriter::ThreadedWriter*> activeWriter { nullptr };
    std::atomic<bool>  recordArmed { false };
    int writerChans = 1;                  // 녹음 writer 채널 수 (입력과 불일치 시 write 스킵)
    std::atomic<int> recDropBlocks { 0 }; // 쓰기 실패(FIFO 오버런) 블록 수
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
        // 트랙 미터 — 재생 중 or 모니터링 중 + 2틱=10Hz. JSON 스팸이 pos 이벤트 정체시켜 영상 싱크 반복 스냅 방지
        if ((engine.isPlaying() || engine.isMonitorOn()) && (tick % 2 == 0))
        {
            Array<var> list;
            const bool anyLevel = engine.collectMeters (list);
            if (anyLevel && ! list.isEmpty())
            {
                auto* o = ev ("trackMeter");
                o->setProperty ("list", var (list));
                emit (var (o));
            }
        }
        // 플러그인 지연 변화 추적 (1초 주기) — 오버샘플링 토글 등으로 런타임에 바뀔 수 있음
        if (tick % 20 == 0) engine.recomputePdc();
        // 튜너 피치 (2틱=10Hz. rAF 보간과 함께 부드럽게)
        if (++tick % 2 == 0)
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
    else if (cmd == "takeTrim")    engine.trimTake ((int64) (double) c["id"], (int64) (double) c["start"], (int64) (double) c["inOffset"], (int64) (double) c["len"]);
    else if (cmd == "takeSplit")   engine.splitTake ((int64) (double) c["id"], (int64) (double) c["at"], (int64) (double) c["newId"]);
    else if (cmd == "takeFade")    engine.setFade ((int64) (double) c["id"], (int64) (double) c["fadeIn"], (int64) (double) c["fadeOut"]);
    else if (cmd == "stemOffset")  engine.setStemOffset ((int64) (double) c["samples"]);
    else if (cmd == "recTrackAdd") engine.addRecTrack ((int) c["type"]);
    else if (cmd == "recTrackRemove") engine.removeRecTrack ((int) c["id"]);
    else if (cmd == "recArm")      engine.armRec ((int) c["id"]);
    else if (cmd == "recTrack")    engine.setRecTrack ((int) c["id"], c["gain"], c["mute"], c["solo"], c["pan"]);
    else if (cmd == "recTracks")   engine.emitRecTracks();
    else if (cmd == "recTracksReset") engine.setRecTracks (c["tracks"], (int) c["gen"]);
    else if (cmd == "track")       engine.setTrack ((int) c["index"], c["gain"], c["mute"], c["solo"], c["pan"]);
    else if (cmd == "automation")  engine.setAutomation ((int) c["track"], c["points"], c["on"]);
    else if (cmd == "pdc")         engine.setPdcEnabled ((bool) c["on"]);
    else if (cmd == "master")      engine.setMaster ((float) (double) c["gain"]);
    else if (cmd == "monitor")     engine.setMonitor ((float) (double) c["gain"]);
    else if (cmd == "inputMonitor") engine.setInputMonitor ((bool) c["on"]);
    else if (cmd == "metro")       engine.setMetro ((bool) c["on"], (double) c["bpm"], (int64) (double) c["phase"], (double) c["interval"]);
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
    else if (cmd == "export")      engine.exportMix (c["file"].toString(), c["format"].toString(), (int) c["bitDepth"], (bool) c["mineOnly"], (double) c["startSec"], (double) c["endSec"]);
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
