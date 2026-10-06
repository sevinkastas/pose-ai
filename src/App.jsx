import React, { useRef, useEffect, useState, useCallback } from 'react';
import './App.css';

// İskelet bağlantı çizgileri (omurga burada yok, backend'in verdiği sırayla dinamik çizilir)
const SKELETON_CONNECTIONS = [
  ["Left Shoulder", "Right Shoulder"],
  ["Left Shoulder", "Left Hip"],
  ["Right Shoulder", "Right Hip"],
  ["Left Hip", "Right Hip"],
  ["Left Shoulder", "Left Elbow"],
  ["Left Elbow", "Left Wrist"],
  ["Right Shoulder", "Right Elbow"],
  ["Right Elbow", "Right Wrist"],
  ["Left Hip", "Left Knee"],
  ["Left Knee", "Left Ankle"],
  ["Right Hip", "Right Knee"],
  ["Right Knee", "Right Ankle"],
  ["Nose", "Left Eye"],
  ["Nose", "Right Eye"],
  ["Left Eye", "Left Ear"],
  ["Right Eye", "Right Ear"]
];

const KEY_SPINE = ["Spine_Top_C7", "Spine_Mid_Thoracic", "Spine_Low_Lumbar"];

const SEND_WIDTH = 320;      // backend'e giden kare genişliği (320 ideal hız/doğruluk dengesi)
const JPEG_QUALITY = 0.5;
const POLL_MS = 130;         // backend yoklama aralığı (~7-8 FPS, istekler üst üste binmez)
const UI_UPDATE_MS = 300;    // React panel güncelleme aralığı (her inference'ta setState yok)

function App() {
  const videoRef = useRef(null);
  const processingCanvasRef = useRef(null); // Backend'e görüntü göndermek için gizli canvas
  const displayCanvasRef = useRef(null);    // Ekranda iskelet çizmek için görünür canvas
  const prevKpRef = useRef({});             // Yumuşatma için önceki kare noktaları
  // Hızlandırma: render ile inference ayrı döngülerde çalışır.
  // latestRef = ekrana her frame çizilen son sonuç, uiRef = React paneline seyreltilmiş yazılan veri.
  const latestRef = useRef({ keypoints: {}, spine_order: [] });
  const uiRef = useRef({
    view: "BEKLENIYOR", keypoints: {}, spine_order: [],
    metrics: {}, asymmetry_percentage: 0, risk_text: "BELIRSIZ",
  });
  const inFlightRef = useRef(false);        // Üst üste istek engeli (tek-uçuş)
  const frameIdRef = useRef(0);

  const [analysisData, setAnalysisData] = useState({
    view: "BEKLENIYOR",
    keypoints: {},
    spine_order: [],
    metrics: {},
    asymmetry_percentage: 0,
    risk_text: "BELIRSIZ"
  });
  const [frameCount, setFrameCount] = useState(0);
  // 'pending' | 'active' | 'denied' | 'error'
  const [cameraStatus, setCameraStatus] = useState('pending');
  const [retryKey, setRetryKey] = useState(0);

  // Titremeyi azaltan üstel yumuşatma (kararlı analiz için, stabil referans)
  const smoothKeypoints = useCallback((kps) => {
    const prev = prevKpRef.current;
    const out = {};
    Object.entries(kps || {}).forEach(([name, pt]) => {
      const p = prev[name];
      out[name] = p
        ? { ...pt, x: p.x * 0.6 + pt.x * 0.4, y: p.y * 0.6 + pt.y * 0.4 }
        : pt;
    });
    prevKpRef.current = out;
    return out;
  }, []);

  // Hareket tahmini için önceki ham sonuç (stabil referans, effect içinde tazeliğini korur)
  const velPrevRef = useRef(null);

  // Ara kare tahmini: iki inference arası iskelet donmasın diye son hızla ilerletir.
  // Sadece çizimde kullanılır, analiz verisini değiştirmez.
  const predictKeypoints = useCallback((kps) => {
    const prev = velPrevRef.current || {};
    const out = {};
    Object.entries(kps || {}).forEach(([name, pt]) => {
      const p = prev[name];
      let vx = 0, vy = 0;
      if (p) {
        vx = (pt.x - p.x) * 0.5;
        vy = (pt.y - p.y) * 0.5;
        // Aşırı sıçramayı engelle (tek karede en fazla 12px)
        const m = Math.hypot(vx, vy);
        if (m > 12) { vx = (vx / m) * 12; vy = (vy / m) * 12; }
      }
      out[name] = { ...pt, x: pt.x + vx, y: pt.y + vy };
    });
    velPrevRef.current = kps;
    return out;
  }, []);

  // Canvas üzerine iskelet ve noktaları çizen fonksiyon
  const drawSkeleton = useCallback((keypoints, spineOrder = []) => {
    const canvas = displayCanvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const ctx = canvas.getContext('2d');

    // Canvas boyutlarını video gerçek boyutuna eşitle
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!keypoints || Object.keys(keypoints).length === 0) return;

    // 1. Normal iskelet bağlantı çizgileri (Turkuaz)
    ctx.strokeStyle = '#00ffcc';
    ctx.lineWidth = 2;
    SKELETON_CONNECTIONS.forEach(([p1, p2]) => {
      if (keypoints[p1] && keypoints[p2]) {
        ctx.beginPath();
        ctx.moveTo(keypoints[p1].x, keypoints[p1].y);
        ctx.lineTo(keypoints[p2].x, keypoints[p2].y);
        ctx.stroke();
      }
    });

    // 2. Omurga: backend'in verdiği sırayla tek bir yumuşak eğri
    const spinePts = spineOrder.map(n => keypoints[n]).filter(Boolean);
    if (spinePts.length > 1) {
      ctx.strokeStyle = '#ff9900';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(spinePts[0].x, spinePts[0].y);
      for (let i = 1; i < spinePts.length - 1; i++) {
        const mx = (spinePts[i].x + spinePts[i + 1].x) / 2;
        const my = (spinePts[i].y + spinePts[i + 1].y) / 2;
        ctx.quadraticCurveTo(spinePts[i].x, spinePts[i].y, mx, my);
      }
      const last = spinePts[spinePts.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }

    // 3. Noktalar (3 kritik omurga noktası daha büyük ve farklı renk)
    Object.entries(keypoints).forEach(([name, pt]) => {
      const isSpine = name.startsWith("Spine");
      const isKey = KEY_SPINE.includes(name);
      ctx.fillStyle = isKey ? '#ff3300' : isSpine ? '#ffcc00' : '#ff00ff';
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, isKey ? 7 : isSpine ? 4 : 3, 0, 2 * Math.PI);
      ctx.fill();
    });
  }, []);

  useEffect(() => {
    let stopped = false;
    let stream = null;
    let failCount = 0;

    const resetAnalysis = () => {
      prevKpRef.current = {};
      velPrevRef.current = null;
      latestRef.current = { keypoints: {}, spine_order: [] };
      uiRef.current = {
        view: "BEKLENIYOR", keypoints: {}, spine_order: [],
        metrics: {}, asymmetry_percentage: 0, risk_text: "BELIRSIZ",
      };
      inFlightRef.current = false;
      frameIdRef.current = 0;
      setAnalysisData({
        view: "BEKLENIYOR",
        keypoints: {},
        spine_order: [],
        metrics: {},
        asymmetry_percentage: 0,
        risk_text: "BELIRSIZ"
      });
      const c = displayCanvasRef.current;
      if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
    };

    // Kamera gerçekten canlı mı? (izin yok / reddedildi / sonradan kapatıldı ise false)
    const cameraIsLive = () => {
      const video = videoRef.current;
      const track = stream && stream.getVideoTracks()[0];
      return !!(
        video && track &&
        track.readyState === 'live' &&
        track.enabled &&
        !track.muted &&
        video.readyState >= 2 &&
        video.videoWidth > 0
      );
    };

    // Inference yoklaması + render durumu (sendFrame'ten önce tanımlı olmalı)
    let pollTimer = null;
    let rafId = null;
    let lastUiAt = 0;
    let lastDrawAt = 0;

    const sendFrame = async () => {
      // Tek-uçuş: önceki istek bitmeden yeni kare gönderme (kuyruk birikmez, lag birikmez).
      if (inFlightRef.current) return;
      const video = videoRef.current;
      const pCanvas = processingCanvasRef.current;
      if (!video || !pCanvas) return;

      // Kareyi küçült: yükleme boyutu ve inference süresi düşer
      const scale = SEND_WIDTH / video.videoWidth;
      pCanvas.width = SEND_WIDTH;
      pCanvas.height = Math.round(video.videoHeight * scale);
      pCanvas.getContext('2d').drawImage(video, 0, 0, pCanvas.width, pCanvas.height);

      const blob = await new Promise(res => pCanvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
      if (!blob || stopped) return;

      const formData = new FormData();
      formData.append("file", blob, "frame.jpg");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      inFlightRef.current = true;
      try {
        const response = await fetch("https://prevail-exponent-repair.ngrok-free.dev/process-frame", {
          method: "POST",
          body: formData,
          signal: controller.signal,
        });
        // Backend meşgulse (429): bu kareyi atla, bir sonrakini dene. Çizim son sonuçla devam eder.
        if (response.status === 429) { failCount = 0; return; }
        const result = await response.json();
        if (result.error || result.busy || stopped) return;
        failCount = 0;

        // Koordinatları orijinal video boyutuna geri ölçekle
        const inv = 1 / scale;
        const scaled = {};
        Object.entries(result.keypoints || {}).forEach(([name, pt]) => {
          scaled[name] = { ...pt, x: pt.x * inv, y: pt.y * inv };
        });

        const smoothed = smoothKeypoints(scaled);
        const spineOrder = result.spine_order || [];
        latestRef.current = { keypoints: smoothed, spine_order: spineOrder };
        // React paneli her inference'ta değil, seyreltilmiş aralıkla güncellenir (re-render maliyeti düşer).
        const now = performance.now();
        if (now - lastUiAt >= UI_UPDATE_MS) {
          lastUiAt = now;
          uiRef.current = {
            view: result.view,
            keypoints: smoothed,
            spine_order: spineOrder,
            metrics: result.metrics || {},
            asymmetry_percentage: result.asymmetry_percentage || 0,
            risk_text: result.risk_text || "BELIRSIZ",
          };
          setAnalysisData(uiRef.current);
          setFrameCount(prev => prev + 1);
        }
      } catch (e) {
        failCount++;
        if (e.name !== 'AbortError') console.error("API Bağlantı Hatası:", e);
      } finally {
        clearTimeout(timeout);
        inFlightRef.current = false;
      }
    };

    // Inference yoklaması: sabit aralık, üst üste binmez. Render bundan bağımsız akar.
    const startPolling = () => {
      if (pollTimer) return;
      pollTimer = setInterval(() => {
        if (stopped || document.hidden || !cameraIsLive()) return;
        // Backend'e ulaşılamıyorsa yoklamayı kademeli seyrelt (en fazla 3 sn)
        if (failCount > 0 && (frameIdRef.current % Math.min(2 ** failCount, 24)) !== 0) {
          frameIdRef.current++;
          return;
        }
        frameIdRef.current++;
        sendFrame();
      }, POLL_MS);
    };

    // Render döngüsü: son bilinen iskeleti her ekranda yeniden çizer.
    // Inference 7-8 FPS gelse bile iskelet canlı kalır, hareket tahmini (ekstrapolasyon) ile ara kareler doldurulur.
    const renderLoop = (t) => {
      if (stopped) return;
      // ~30 FPS çizim yeterli, CPU'yu yormaz
      if (t - lastDrawAt >= 33 && cameraIsLive()) {
        lastDrawAt = t;
        const { keypoints, spine_order } = latestRef.current;
        if (keypoints && Object.keys(keypoints).length > 0) {
          drawSkeleton(predictKeypoints(keypoints), spine_order);
        }
      }
      rafId = requestAnimationFrame(renderLoop);
    };

    const onVisibility = () => { if (document.hidden) prevKpRef.current = {}; };
    document.addEventListener('visibilitychange', onVisibility);

    setCameraStatus('pending');
    resetAnalysis();

    navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30, max: 30 }
      }
    })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach(t => t.stop());
          return;
        }
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
        setCameraStatus('active');

        // İzin sonradan geri alınırsa / kamera kapanırsa ölçümü durdur
        s.getVideoTracks()[0].addEventListener('ended', () => {
          setCameraStatus('denied');
          resetAnalysis();
        });

        startPolling();
        rafId = requestAnimationFrame(renderLoop);
      })
      .catch((err) => {
        console.error("Kamera hatası:", err);
        const denied = err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError' || err.name === 'SecurityError');
        setCameraStatus(denied ? 'denied' : 'error');
        resetAnalysis();
      });

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (pollTimer) clearInterval(pollTimer);
      if (rafId) cancelAnimationFrame(rafId);
      if (stream) stream.getTracks().forEach(t => t.stop());
    };
  }, [drawSkeleton, smoothKeypoints, predictKeypoints, retryKey]);

  const getViewColor = (view) => {
    if (view === "FRONT") return "#00ff00";
    if (view === "BACK") return "#ff9900";
    if (view === "SIDE") return "#00ccff";
    return "#888888";
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      background: '#0a0a0a',
      color: '#fff',
      fontFamily: 'system-ui, sans-serif',
      overflow: 'hidden'
    }}>

      {/* ÜST KISIM: Kamera ve Üzerindeki İskelet Çizim Katmanı (Canvas) */}
      <div style={{
        flex: '1',
        position: 'relative',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        background: '#000',
        maxHeight: '55vh',
        overflow: 'hidden'
      }}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
        {/* Video ile birebir üst üste binen şeffaf çizim katmanı */}
        <canvas
          ref={displayCanvasRef}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            objectFit: 'contain'
          }}
        />
        {/* Arka planda FastAPI'ye göndermek için gizli canvas */}
        <canvas ref={processingCanvasRef} style={{ display: 'none' }} />

        {/* Kamera izni yoksa / kamera açılamadıysa uyarı (bu durumda backend'e istek atılmaz) */}
        {cameraStatus !== 'active' && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            gap: '12px',
            padding: '20px',
            textAlign: 'center',
            background: 'rgba(0,0,0,0.85)',
            zIndex: 20,
            fontSize: '14px'
          }}>
            <div>
              {cameraStatus === 'pending' && 'Kamera izni bekleniyor...'}
              {cameraStatus === 'denied' && 'Kamera izni kapalı. Ölçüm durduruldu. Tarayıcı ayarlarından kamera iznini açıp tekrar dene.'}
              {cameraStatus === 'error' && 'Kamera açılamadı. Başka bir uygulama kamerayı kullanıyor olabilir.'}
            </div>
            {cameraStatus !== 'pending' && (
              <button
                onClick={() => setRetryKey(k => k + 1)}
                style={{
                  padding: '8px 18px',
                  borderRadius: '8px',
                  border: '1px solid #00ffcc',
                  background: 'transparent',
                  color: '#00ffcc',
                  fontSize: '14px',
                  cursor: 'pointer'
                }}
              >
                Tekrar dene
              </button>
            )}
          </div>
        )}

        {/* Kamera Üzeri Yüzen Özet Kartı */}
        <div style={{
          position: 'absolute',
          top: '10px',
          left: '10px',
          right: '10px',
          background: 'rgba(0, 0, 0, 0.75)',
          backdropFilter: 'blur(5px)',
          padding: '10px 15px',
          borderRadius: '10px',
          border: '1px solid rgba(255,255,255,0.1)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          zIndex: 10
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 'bold', color: getViewColor(analysisData.view) }}>
              Konum: {analysisData.view}
            </div>
            <div style={{ fontSize: '11px', color: '#aaa' }}>Risk: {analysisData.risk_text}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '13px', color: '#00ffff' }}>Asimetri: %{analysisData.asymmetry_percentage.toFixed(1)}</div>
            <div style={{ fontSize: '10px', color: '#777' }}>Kare: {frameCount}</div>
          </div>
        </div>
      </div>

      {/* ALT KISIM: Okunabilir Koordinat ve Metrik Paneli */}
      <div style={{
        height: '45vh',
        background: '#161616',
        borderTop: '2px solid #333',
        display: 'flex',
        flexDirection: 'column',
        padding: '12px'
      }}>
        <h3 style={{ fontSize: '13px', color: '#00ffff', margin: '0 0 8px 0', textTransform: 'uppercase', letterSpacing: '1px' }}>
          Anlık Eklem Koordinatları
        </h3>

        <div style={{
          flex: 1,
          overflowY: 'auto',
          background: '#111',
          borderRadius: '8px',
          padding: '8px',
          border: '1px solid #222'
        }}>
          {Object.keys(analysisData.keypoints).length === 0 ? (
            <div style={{ textAlign: 'center', color: '#666', marginTop: '20px', fontSize: '13px' }}>
              Kişi algılanıyor veya kamera FRAME bekleniyor...
            </div>
          ) : (
            Object.entries(analysisData.keypoints).map(([name, pt]) => {
              const isSpine = name.includes("Spine");
              return (
                <div key={name} style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '6px 10px',
                  borderBottom: '1px solid #1a1a1a',
                  fontSize: '12px',
                  background: isSpine ? 'rgba(0, 255, 204, 0.08)' : 'transparent'
                }}>
                  <span style={{ color: isSpine ? '#00ffcc' : '#ccc', fontWeight: isSpine ? 'bold' : 'normal' }}>
                    {isSpine ? `📍 ${name}` : name}
                  </span>
                  <span style={{ color: '#00ff00', fontWeight: 'bold' }}>
                    X: {Math.round(pt.x)} | Y: {Math.round(pt.y)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>

    </div>
  );
}

export default App;
