// src/hooks/usePsdLayers.js
import { useEffect, useState } from "react";
import { readPsd } from "ag-psd";

export function usePsdLayers(psdUrl) {
  const [doc, setDoc] = useState(null);       // { width, height }
  const [layers, setLayers] = useState([]);   // { name,parent,x,y,w,h,opacity,visible,dataUrl }[]
  const [error, setError] = useState(null);

  useEffect(() => {
    let canceled = false;

    (async () => {
      try {
        const res = await fetch(psdUrl, { cache: "no-cache" });
        if (!res.ok) throw new Error(`HTTP ${res.status} loading PSD`);
        const buf = await res.arrayBuffer();

        // readPsd parses and builds HTMLCanvasElement for each pixel layer (in the browser)
        const psd = readPsd(buf, { throwForMissingFeatures: false });

        const out = [];
        const walk = (nodes = [], parentName = "") => {
          nodes.forEach((n) => {
            const isGroup = Array.isArray(n.children);
            const name = n.name || "";
            const parent = parentName || "";
            if (isGroup) {
              walk(n.children, name || parentName);
            } else {
              const left = n.left ?? 0, top = n.top ?? 0;
              const right = n.right ?? left, bottom = n.bottom ?? top;
              const w = Math.max(0, right - left);
              const h = Math.max(0, bottom - top);
              const visible = n.visible !== false;
              const opacity = typeof n.opacity === "number" ? n.opacity : 1; // 0..1
              const canvas = n.canvas; // HTMLCanvasElement if the layer has pixels

              if (canvas && w > 0 && h > 0) {
                const dataUrl = canvas.toDataURL("image/png");
                out.push({ name, parent, x: left, y: top, w, h, opacity, visible, dataUrl });
              }
            }
          });
        };

        walk(psd.children || []);
        if (!canceled) {
          setDoc({ width: psd.width, height: psd.height });
          setLayers(out);
        }
      } catch (e) {
        if (!canceled) setError(e?.message || String(e));
      }
    })();

    return () => { canceled = true; };
  }, [psdUrl]);

  return { doc, layers, error };
}
