// src/components/AvatarFromPSD.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { useAudioLevel } from "../hooks/useAudioLevel";
import { makeSpring } from "../utils/spring";
import { useWS } from "../hooks/useWS";
import { usePsdLayers } from "../hooks/usePsdLayer";

export default function AvatarPanel({ name = "Avatar", psdUrl }) {
  const containerRef = useRef(null);
  const { doc, layers, error } = usePsdLayers(psdUrl);

  // ===== audio / TTS (your code) =====
  const micLevel = useAudioLevel({ smoothing: 0.18, fallbackMic: true });
  let ws; try { ws = useWS?.(); } catch {}

  const ttsTimerRef = useRef(null);
  const [extLevel, setExtLevel] = useState(0);
  const [hasTtsDrive, setHasTtsDrive] = useState(false);

  const playEnvelope = (levels = [], winMs = 40) => {
    if (ttsTimerRef.current) { clearInterval(ttsTimerRef.current); ttsTimerRef.current = null; }
    if (!levels.length) { setHasTtsDrive(false); setExtLevel(0); return; }
    setHasTtsDrive(true);
    let i = 0;
    const safeMs = Math.max(16, +winMs || 40);
    ttsTimerRef.current = setInterval(() => {
      if (i < levels.length) setExtLevel(Math.max(0, Math.min(1, levels[i++] ?? 0)));
      else { clearInterval(ttsTimerRef.current); ttsTimerRef.current = null; setHasTtsDrive(false); setExtLevel(0); }
    }, safeMs);
  };

  useEffect(() => {
    if (!ws?.on) return;
    const offTts = ws.on("tts_levels", ({ levels, winMs }) => playEnvelope(levels, winMs));
    const offSpeak = ws.on("speaking_level", ({ level }) => {
      if (!hasTtsDrive) setExtLevel(Math.max(0, Math.min(1, +level || 0)));
    });
    return () => { offTts?.(); offSpeak?.(); };
  }, [ws, hasTtsDrive]);

  useEffect(() => {
    const onTtsEvt = (e) => { const { levels = [], winMs = 40 } = e?.detail || {}; playEnvelope(levels, winMs); };
    const onSpeakEvt = (e) => { const level = Math.max(0, Math.min(1, +e?.detail?.level || 0)); if (!hasTtsDrive) setExtLevel(level); };
    window.addEventListener("tts_levels", onTtsEvt);
    window.addEventListener("app:speaking", onSpeakEvt);
    return () => {
      window.removeEventListener("tts_levels", onTtsEvt);
      window.removeEventListener("app:speaking", onSpeakEvt);
    };
  }, [hasTtsDrive]);

  const stepSpring   = useMemo(() => makeSpring({ stiffness: 140, damping: 20, initial: 0 }), []);
  const eyeSpringX   = useMemo(() => makeSpring({ stiffness: 120, damping: 18, initial: 0 }), []);
  const eyeSpringY   = useMemo(() => makeSpring({ stiffness: 120, damping: 18, initial: 0 }), []);
  const [intensity, setIntensity] = useState(0);

  // ===== RAF loop: audio intensity + eye springs =====
  const [eyeX, setEyeX] = useState(0);
  const [eyeY, setEyeY] = useState(0);
  const [eyeTX, setEyeTX] = useState(0);
  const [eyeTY, setEyeTY] = useState(0);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const drive = hasTtsDrive ? extLevel : (extLevel > 0 ? extLevel : micLevel);
      const target = Math.min(1, Math.max(0, drive));
      setIntensity(stepSpring(target));
      setEyeX(eyeSpringX(eyeTX));
      setEyeY(eyeSpringY(eyeTY));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [hasTtsDrive, extLevel, micLevel, stepSpring, eyeSpringX, eyeSpringY, eyeTX, eyeTY]);

  useEffect(() => () => { if (ttsTimerRef.current) clearInterval(ttsTimerRef.current); }, []);

  // ===== deformation params =====
  const disp   = 8 + intensity * 22;
  const freq   = 0.006 + intensity * 0.025;
  const scaleX = 1 + intensity * 0.12;
  const scaleY = 1 - intensity * 0.10;

  // mouth by intensity
  const mouthVariant = intensity < 0.33 ? "boca1" : intensity < 0.66 ? "boca2" : "boca3";

  // doc size
  const W = (doc && doc.width)  || 512;
  const H = (doc && doc.height) || 512;
  const id = useMemo(() => Math.random().toString(36).slice(2), []);

  // ===== helpers & layer picks =====
  const norm = (s) => (s || "").normalize?.("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const pickGroup = (g) => layers.filter(l => l.visible && (norm(l.parent) === norm(g) || norm(l.name) === norm(g)));

  const fondo        = pickGroup("fondo");
  const esqueletoAll = pickGroup("esqueleto");
  const ojosAll      = pickGroup("ojos");
  const bocasAll     = pickGroup("bocas");

  const borde = esqueletoAll.find(l => norm(l.name) === "borde") || null;
  const esqueleto = esqueletoAll.filter(l => norm(l.name) !== "borde");

  const ojoAbierto = ojosAll.find(l => norm(l.name) === "ojo2") || ojosAll[0];
  const ojoCerrado = ojosAll.find(l => norm(l.name) === "ojo1") || ojosAll[1] || ojosAll[0];

  // ===== blink =====
  const [blink, setBlink] = useState(false);
  const blinkTimers = useRef([]);
  useEffect(() => {
    const clearAll = () => { blinkTimers.current.forEach(t => clearTimeout(t)); blinkTimers.current = []; };
    const scheduleBlink = () => {
      const delay = 2200 + Math.random() * 3800; // 2.2–6s
      blinkTimers.current.push(setTimeout(() => {
        setBlink(true);
        blinkTimers.current.push(setTimeout(() => {
          setBlink(false);
          if (Math.random() < 0.25) {           // chance of double-blink
            blinkTimers.current.push(setTimeout(() => {
              setBlink(true);
              blinkTimers.current.push(setTimeout(() => {
                setBlink(false);
                scheduleBlink();
              }, 100));
            }, 120));
          } else scheduleBlink();
        }, 120));
      }, delay));
    };
    clearAll(); scheduleBlink();
    return clearAll;
  }, []);

  // ===== saccades (eye targets) =====
  const saccTimers = useRef([]);
  useEffect(() => {
    const clearAll = () => { saccTimers.current.forEach(t => clearTimeout(t)); saccTimers.current = []; };
    const schedule = () => {
      const delay = 1200 + Math.random() * 1800; // every 1.2–3s
      saccTimers.current.push(setTimeout(() => {
        // new target in [-1,1], clamp vertical a bit to look natural
        setEyeTX((Math.random() * 2 - 1));
        setEyeTY((Math.random() * 2 - 1) * 0.6);
        schedule();
      }, delay));
    };
    clearAll(); schedule();
    return clearAll;
  }, []);

  // Optional: follow mouse gently (comment out if you don’t want it)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onMove = (e) => {
      const rect = el.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width  - 0.5) * 2; // -1..1
      const ny = ((e.clientY - rect.top)  / rect.height - 0.5) * 2;
      // small mix with current saccade target
      setEyeTX(prev => prev * 0.6 + nx * 0.4);
      setEyeTY(prev => prev * 0.6 + ny * 0.4);
    };
    el.addEventListener("mousemove", onMove);
    return () => el.removeEventListener("mousemove", onMove);
  }, []);

  // ===== eye clip geometry (auto from open-eye bbox; tweak if needed) =====
  // If ojoAbierto missing, these fall back near face center.
  const eyesBox = ojoAbierto
    ? { x: ojoAbierto.x, y: ojoAbierto.y, w: ojoAbierto.w, h: ojoAbierto.h }
    : { x: W * 0.25, y: H * 0.38, w: W * 0.5, h: H * 0.18 };

  const cxL = eyesBox.x + eyesBox.w * 0.33;
  const cxR = eyesBox.x + eyesBox.w * 0.67;
  const cy  = eyesBox.y + eyesBox.h * 0.52;
  const rx  = eyesBox.w * 0.18;   // horizontal eye radius
  const ry  = eyesBox.h * 0.46;   // vertical eye radius

  // Max pixel shift inside each eye (kept small to avoid clipping artifacts)
  const MAX_X = eyesBox.w * 0.06; // ~6% of eye box width
  const MAX_Y = eyesBox.h * 0.06; // ~18% of eye box height
  const offX  = Math.max(-1, Math.min(1, eyeX)) * MAX_X;
  const offY  = Math.max(-1, Math.min(1, eyeY)) * MAX_Y;

  // mouth selection
  const bocaSelected = bocasAll.find(l => norm(l.name) === norm(mouthVariant)) || bocasAll[0];

  if (error) {
    return <div className="p-3 text-sm text-red-600 rounded bg-red-50">PSD error: {error}</div>;
  }

  return (
    <div ref={containerRef} className="w-full h-full">
      <div className="relative w-full h-full rounded-2xl overflow-hidden flex items-center justify-center bg-black/5">
        <svg className="w-full h-full" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={name}>
          <defs>
            <filter id={`blob-${id}`}>
              <feTurbulence type="fractalNoise" baseFrequency={freq} numOctaves="2" seed="7" result="noise" />
              <feDisplacementMap in="SourceGraphic" in2="noise" scale={disp} xChannelSelector="R" yChannelSelector="G" />
            </filter>
            {/* circular crop for content; the PSD border is drawn on top without clipping */}
            <clipPath id={`clip-${id}`}>
              <circle cx={W / 2} cy={H / 2} r={H * 0.48} />
            </clipPath>

            {/* per-eye clipping (ellipses) */}
            <clipPath id={`eyeL-${id}`}>
              <ellipse cx={cxL} cy={cy} rx={rx} ry={ry} />
            </clipPath>
            <clipPath id={`eyeR-${id}`}>
              <ellipse cx={cxR} cy={cy} rx={rx} ry={ry} />
            </clipPath>
          </defs>

          {/* Fondo (no deformation) */}
          {fondo.map((l, i) => (
            <image key={`f-${i}`} href={l.dataUrl} x={l.x} y={l.y} width={l.w} height={l.h}
                   opacity={l.opacity} preserveAspectRatio="none" clipPath={`url(#clip-${id})`} />
          ))}

          {/* Esqueleto (deformed, EXCEPT 'borde') */}
          <g clipPath={`url(#clip-${id})`} transform={`translate(${W/2}, ${H/2}) scale(${scaleX} ${scaleY}) translate(${-W/2}, ${-H/2})`}>
            <g filter={`url(#blob-${id})`}>
              {esqueleto.map((l, i) => (
                <image key={`e-${i}`} href={l.dataUrl} x={l.x} y={l.y} width={l.w} height={l.h}
                       opacity={l.opacity} preserveAspectRatio="none" />
              ))}
            </g>
          </g>

          {/* Eyes */}
          {blink
            ? (
              // Closed eyes (no movement)
              ojoCerrado && (
                <image href={ojoCerrado.dataUrl} x={ojoCerrado.x} y={ojoCerrado.y}
                       width={ojoCerrado.w} height={ojoCerrado.h} opacity={ojoCerrado.opacity}
                       preserveAspectRatio="none" clipPath={`url(#clip-${id})`} />
              )
            ) : (
              // Open eyes with movement: render ojoAbierto twice, one per eye with its own clip
              ojoAbierto && (
                <>
                  <g clipPath={`url(#eyeL-${id})`}>
                    <g transform={`translate(${offX}, ${offY})`}>
                      <image href={ojoAbierto.dataUrl} x={ojoAbierto.x} y={ojoAbierto.y}
                             width={ojoAbierto.w} height={ojoAbierto.h} opacity={ojoAbierto.opacity}
                             preserveAspectRatio="none" />
                    </g>
                  </g>
                  <g clipPath={`url(#eyeR-${id})`}>
                    <g transform={`translate(${offX}, ${offY})`}>
                      <image href={ojoAbierto.dataUrl} x={ojoAbierto.x} y={ojoAbierto.y}
                             width={ojoAbierto.w} height={ojoAbierto.h} opacity={ojoAbierto.opacity}
                             preserveAspectRatio="none" />
                    </g>
                  </g>
                </>
              )
            )
          }

          {/* Mouth (sharp) */}
          {bocaSelected && (
            <image href={bocaSelected.dataUrl} x={bocaSelected.x} y={bocaSelected.y}
                   width={bocaSelected.w} height={bocaSelected.h} opacity={bocaSelected.opacity}
                   preserveAspectRatio="none" clipPath={`url(#clip-${id})`} />
          )}

          {/* PSD Border (sharp, on top, NO clip & NO deformation) */}
          {borde && (
            <image href={borde.dataUrl} x={borde.x} y={borde.y}
                   width={borde.w} height={borde.h} opacity={borde.opacity}
                   preserveAspectRatio="none" />
          )}
        </svg>
      </div>
    </div>
  );
}
