import { useEffect, useRef, useState, useCallback } from "react";

async function decodeEventData(evData) {
  try {
    if (typeof evData === "string") return JSON.parse(evData);
    if (evData instanceof ArrayBuffer) {
      const text = new TextDecoder().decode(evData);
      return JSON.parse(text);
    }
    if (evData instanceof Blob) {
      const text = await evData.text();
      return JSON.parse(text);
    }
    // algunos navegadores envían ya un objeto
    return typeof evData === "object" ? evData : null;
  } catch {
    return null;
  }
}

export function useWS(path = "/api/chat/ws") {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const manualCloseRef = useRef(false);
  const attemptsRef = useRef(0);
  const mountedRef = useRef(false); // para Strict Mode en dev

  const buildUrl = () => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}${path}`;
  };

  const clearReconnect = () => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  const scheduleReconnect = () => {
    if (manualCloseRef.current) return;
    const attempt = Math.min(attemptsRef.current + 1, 6);
    attemptsRef.current = attempt;
    const delay = Math.min(1000 * 2 ** (attempt - 1), 8000); // 1s,2s,4s,8s…
    clearReconnect();
    reconnectTimerRef.current = setTimeout(() => {
      connect();
    }, delay);
  };

  const connect = useCallback(() => {
    // Evita crear múltiples sockets si ya hay uno vivo
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    manualCloseRef.current = false;
    const wsUrl = buildUrl();
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer"; // soporta ArrayBuffer además de string/Blob
    wsRef.current = ws;

    ws.onopen = () => {
      attemptsRef.current = 0;
      setConnected(true);
    };

    // onmessage base: decodifica + reemite eventos globales útiles para el avatar
    ws.onmessage = async (e) => {
      const msg = await decodeEventData(e.data);
      if (!msg || !msg.type) return;

      const { type, data } = msg;

      // —— Eventos globales para el blob/avatar ——
      if (type === "tts_levels" && data?.levels?.length) {
        const { levels, winMs } = data;
        // Reemite tal cual; el AvatarPanel los escucha
        window.dispatchEvent(
          new CustomEvent("tts_levels", { detail: { levels, winMs } })
        );
      } else if (type === "speaking_level") {
        const level = Math.max(0, Math.min(1, +data?.level || 0));
        window.dispatchEvent(
          new CustomEvent("app:speaking", { detail: { level } })
        );
      }

      // —— Reenvío para cualquier listener externo registrado con onMessage() ——
      // OJO: onMessage añade sus propios handlers, que también recibirán e.data.
      // Para mantener compatibilidad, disparamos manualmente un CustomEvent
      // interno si quieres engancharte globalmente:
      // window.dispatchEvent(new CustomEvent("ws_message", { detail: msg }));
      // Pero no es necesario; onMessage() sigue funcionando (ver abajo).
    };

    ws.onerror = () => {
      // algunos navegadores disparan onerror y luego onclose
    };

    ws.onclose = () => {
      setConnected(false);
      // si no fue cierre manual y el hook sigue montado, reintenta
      if (!manualCloseRef.current && mountedRef.current) {
        scheduleReconnect();
      }
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      // cleanup para Strict Mode: marcar cierre manual y cerrar el socket actual
      mountedRef.current = false;
      manualCloseRef.current = true;
      clearReconnect();
      if (
        wsRef.current &&
        (wsRef.current.readyState === WebSocket.OPEN ||
          wsRef.current.readyState === WebSocket.CONNECTING)
      ) {
        try {
          wsRef.current.close();
        } catch {}
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect, path]);

  const sendJson = useCallback((obj) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }, []);

  // Mantiene tu API: onMessage(cb) — ahora decodifica string/Blob/ArrayBuffer y pasa JSON
  const onMessage = useCallback((cb) => {
    const ws = wsRef.current;
    if (!ws) return () => {};

    let closed = false;

    const handler = async (e) => {
      if (closed) return;
      const msg = await decodeEventData(e.data);
      if (msg) {
        try {
          cb(msg); // siempre objeto JS parseado
        } catch {
          /* consumidor lanzó error: lo ignoramos */
        }
      }
    };

    ws.addEventListener("message", handler);
    return () => {
      closed = true;
      ws.removeEventListener("message", handler);
    };
  }, []);

  return { connected, sendJson, onMessage, wsRef };
}

export default useWS;
