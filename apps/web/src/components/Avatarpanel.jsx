import { useEffect, useMemo, useRef, useState } from "react";
import { useAudioLevel } from "../hooks/useAudioLevel";
import { makeSpring } from "../utils/spring";
// ⬇️ opcional: si tienes el hook useWS con bus de eventos
import { useWS } from "../hooks/useWS";

export default function AvatarPanel({ name = "Avatar", avatarUrl }) {
  const containerRef = useRef(null);

  // 1) Fallback mic (cuando no hay TTS activo)
  const micLevel = useAudioLevel({ smoothing: 0.18, fallbackMic: true });

  // 2) (Opcional) acceso al bus del WS si existe
  let ws;
  try {
    ws = useWS?.(); // si no existe, queda undefined
  } catch { /* no-op */ }

  // ===== Estado para reproducir niveles TTS =====
  const ttsTimerRef = useRef(null);
  const [extLevel, setExtLevel] = useState(0);   // nivel “externo” (TTS o señales)
  const [hasTtsDrive, setHasTtsDrive] = useState(false); // hay una cola de TTS en marcha

  // Consumidor genérico de una envolvente (levels, winMs)
  const playEnvelope = (levels = [], winMs = 40) => {
    // corta cualquier reproducción anterior
    if (ttsTimerRef.current) {
      clearInterval(ttsTimerRef.current);
      ttsTimerRef.current = null;
    }
    if (!levels.length) {
      setHasTtsDrive(false);
      setExtLevel(0);
      return;
    }
    setHasTtsDrive(true);
    let i = 0;
    const safeMs = Math.max(16, +winMs || 40);
    ttsTimerRef.current = setInterval(() => {
      if (i < levels.length) {
        const lv = Math.max(0, Math.min(1, levels[i++] ?? 0));
        setExtLevel(lv);
      } else {
        clearInterval(ttsTimerRef.current);
        ttsTimerRef.current = null;
        setHasTtsDrive(false);
        setExtLevel(0);
      }
    }, safeMs);
  };

  // 2a) Escucha mensajes del WS (si tu useWS expone on(type, fn))
  useEffect(() => {
    if (!ws?.on) return;
    const offTts = ws.on("tts_levels", ({ levels, winMs }) => {
      playEnvelope(levels, winMs);
    });
    const offSpeak = ws.on("speaking_level", ({ level }) => {
      // señales simples (ej. STT on/off) — sólo si no hay TTS activo
      if (!hasTtsDrive) {
        setExtLevel(Math.max(0, Math.min(1, +level || 0)));
      }
    });
    return () => {
      offTts?.();
      offSpeak?.();
    };
  }, [ws, hasTtsDrive]);

  // 2b) Alternativa: eventos globales (si reemites desde tu handler WS)
  useEffect(() => {
    const onTtsEvt = (e) => {
      const { levels = [], winMs = 40 } = e?.detail || {};
      playEnvelope(levels, winMs);
    };
    const onSpeakEvt = (e) => {
      const level = Math.max(0, Math.min(1, +e?.detail?.level || 0));
      if (!hasTtsDrive) setExtLevel(level);
    };
    window.addEventListener("tts_levels", onTtsEvt);
    window.addEventListener("app:speaking", onSpeakEvt);
    return () => {
      window.removeEventListener("tts_levels", onTtsEvt);
      window.removeEventListener("app:speaking", onSpeakEvt);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTtsDrive]);

  // 3) Muelle para la intensidad del blob
  const stepSpring = useMemo(() => makeSpring({ stiffness: 140, damping: 20, initial: 0 }), []);
  const [intensity, setIntensity] = useState(0); // 0..1 suavizado

  // 4) Animación RAF
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let raf = 0;
    let t = 0;
    function loop() {
      t += 1 / 60;
      setTick(t);
      // Prioridad: TTS/env → señales → mic
      const drive = hasTtsDrive ? extLevel : extLevel > 0 ? extLevel : micLevel;
      const target = Math.min(1, Math.max(0, drive));
      setIntensity(stepSpring(target));
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [hasTtsDrive, extLevel, micLevel, stepSpring]);

  // 5) Parámetros del blob
  const disp = 8 + intensity * 22;
  const freq = 0.006 + intensity * 0.025;
  const scaleX = 1 + intensity * 0.12;
  const scaleY = 1 - intensity * 0.10;
  const rotDeg = 0; // si quieres rotación, pon (tick * 12) % 360

  // Tamaño SVG
  const [w, h] = [512, 512];
  const id = useMemo(() => Math.random().toString(36).slice(2), []);

  useEffect(() => {
    // cleanup de intervalos al desmontar
    return () => {
      if (ttsTimerRef.current) clearInterval(ttsTimerRef.current);
    };
  }, []);

  return (
    <div ref={containerRef} className="w-full h-full">
      <div className={`relative w-full h-full rounded-2xl overflow-hidden flex items-center justify-center bg-black/5`}>
        <svg className="w-full h-full" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={name}>
          <defs>
            <pattern id={`img-${id}`} patternUnits="objectBoundingBox" width="1" height="1">
              <image href={avatarUrl} preserveAspectRatio="xMidYMid slice" width={w} height={h} />
            </pattern>

            <filter id={`blob-${id}`}>
              <feTurbulence type="fractalNoise" baseFrequency={freq} numOctaves="2" seed="7" result="noise" />
              <feDisplacementMap in="SourceGraphic" in2="noise" scale={disp} xChannelSelector="R" yChannelSelector="G" />
            </filter>

            <clipPath id={`clip-${id}`}>
              <circle cx={w / 2} cy={h / 2} r={h * 0.42} />
            </clipPath>
          </defs>

          <g opacity="0.08">
            <circle cx={w / 2} cy={h / 2} r={h * 0.44} fill="black" />
          </g>

          <g transform={`rotate(${rotDeg}, ${w / 2}, ${h / 2})`}>
            <g transform={`translate(${w / 2}, ${h / 2}) scale(${scaleX} ${scaleY}) translate(${-w / 2}, ${-h / 2})`}>
              <g filter={`url(#blob-${id})`} clipPath={`url(#clip-${id})`}>
                <rect x="0" y="0" width={w} height={h} fill={`url(#img-${id})`} />
              </g>
            </g>
          </g>

          <g opacity={0.25 * intensity}>
            
          </g>
        </svg>
      </div>
    </div>
  );
}
