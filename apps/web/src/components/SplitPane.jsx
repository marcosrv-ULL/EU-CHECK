import { useEffect, useRef, useState } from "react";

function Chevron({ direction = "left", className = "w-4 h-4" }) {
  const rotation = { left: "rotate-180", right: "rotate-0" }[direction];
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={`${className} ${rotation}`}>
      <path fillRule="evenodd" d="M8.22 3.22a.75.75 0 0 1 1.06 0l7.5 7.5a.75.75 0 0 1 0 1.06l-7.5 7.5a.75.75 0 1 1-1.06-1.06L14.94 12 8.22 4.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
    </svg>
  );
}

export default function SplitPane({
  initialWidth = 360,
  minWidth = 260,
  maxWidth = 560,
  collapsedWidth = 0,
  childrenLeft,
  childrenRight,
}) {
  const containerRef = useRef(null);
  const [sidebarWidth, setSidebarWidth] = useState(initialWidth);
  const [isDragging, setIsDragging] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const lastExpandedWidth = useRef(initialWidth);

  // movimiento del separador (gutter)
  useEffect(() => {
    function onMove(e) {
      if (!isDragging || collapsed) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      let next = clientX - rect.left; //
      next = Math.max(minWidth, Math.min(next, maxWidth));
      setSidebarWidth(next);
      lastExpandedWidth.current = next;
      if (e.cancelable) e.preventDefault(); //
    }
    function onUp() { setIsDragging(false); }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
  }, [isDragging, collapsed, minWidth, maxWidth]);

  const effectiveWidth = collapsed ? collapsedWidth : sidebarWidth;

  return (
    <div ref={containerRef} className="relative w-full h-[calc(100vh-7.5rem)] md:h-[calc(100vh-8.5rem)] overflow-hidden select-none">
      {/* Disposición en 3 columnas: izquierda | gutter fijo | derecha */}
      <div className="h-full flex">
        {/* Izquierda (Chat) */}
        <div style={{ width: effectiveWidth }} className="relative h-full flex-shrink-0 transition-[width] duration-200 ease-out">
          <div className="h-full bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
            <div
              className={`h-full overflow-y-auto p-3 ${collapsed ? "pointer-events-none" : ""}`}
              aria-hidden={collapsed ? "true" : "false"}
            >
              {childrenLeft}
            </div>
          </div>
        </div>

        {/* Gutter con botón + zona de arrastre */}
        <div
          className="relative w-7 h-full flex-shrink-0"
          onMouseDown={() => !collapsed && setIsDragging(true)}
          onTouchStart={() => !collapsed && setIsDragging(true)}
          title={collapsed ? "Expandir" : "Arrastra para cambiar el ancho"}
        >
          {/* línea separadora visual */}
          <div className={`absolute inset-y-0 left-1/2 -translate-x-1/2 w-px ${isDragging ? "bg-gray-300" : "bg-gray-200"}`} />

          {/* botón de colapso/expansión centrado en el gutter */}
          <button
            type="button"
            onClick={() => {
              if (collapsed) {
                setCollapsed(false);
                setSidebarWidth(lastExpandedWidth.current || initialWidth);
              } else {
                lastExpandedWidth.current = sidebarWidth;
                setCollapsed(true);
              }
            }}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 bg-white border border-gray-300 shadow rounded-md p-1.5 hover:bg-gray-50 active:bg-gray-100"
            aria-label={collapsed ? "Expandir chat" : "Plegar chat"}
          >
            <Chevron direction={collapsed ? "left" : "right"} className="w-5 h-5" />
          </button>

          {/* zona de arrastre a lo alto del gutter (cuando no está colapsado) */}
          {!collapsed && (
            <div className="absolute inset-0 cursor-col-resize" aria-hidden="true" />
          )}
        </div>

        {/* Derecha (Avatares) */}
        <div className="flex-1 h-full">
          <div className="h-full bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
            <div className="h-full p-4">{childrenRight}</div>
          </div>
        </div>
      </div>
    </div>
  );
}