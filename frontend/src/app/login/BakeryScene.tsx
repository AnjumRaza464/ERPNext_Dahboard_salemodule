"use client";

import { useEffect, useRef, useState } from "react";
import { buildCells, DAYS, GROUPS, MODES, type Cell, type SceneMode } from "./sceneData";

const MAX_H = 5.2; // scene units for the tallest bar
const GAP = 1.15;

/**
 * WebGL "data city": one bar per item group x day, reshaped by `mode`. Hover a bar for its figure;
 * the city follows the pointer and turns slowly. three.js is loaded on demand so the form is
 * usable before the scene arrives; without WebGL the page keeps its CSS backdrop.
 */
export default function BakeryScene({ mode, className = "relative" }: { mode: SceneMode; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const modeRef = useRef(mode);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    let cancelled = false;
    let stop = () => {};

    import("three")
      .then((THREE) => {
        if (cancelled || !host.current) return;
        const el = host.current;
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

        let renderer: InstanceType<typeof THREE.WebGLRenderer>;
        try {
          renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
        } catch {
          return; // no WebGL: the CSS backdrop stays
        }
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.NoToneMapping; // keep the mode colours saturated
        renderer.domElement.style.cssText = "display:block;width:100%;height:100%";
        el.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        scene.fog = new THREE.Fog(0x05060a, 26, 52);
        const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 120);
        const lookAt = new THREE.Vector3(0, 0.9, 0);

        scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x0a0b10, 0.75));
        const key = new THREE.DirectionalLight(0xffffff, 1.25);
        key.position.set(8, 16, 7);
        scene.add(key);
        const rim = new THREE.DirectionalLight(0x8fb8ff, 0.7);
        rim.position.set(-12, 6, -9);
        scene.add(rim);

        // ---- the city
        const ROWS = GROUPS.length;
        const N = ROWS * DAYS;
        const ox = (-(DAYS - 1) * GAP) / 2;
        const oz = (-(ROWS - 1) * GAP) / 2;
        const city = new THREE.Group();
        scene.add(city);

        const barGeo = new THREE.BoxGeometry(0.84, 1, 0.84);
        barGeo.translate(0, 0.5, 0);
        const barMat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.05 });
        const bars = new THREE.InstancedMesh(barGeo, barMat, N);
        const capGeo = new THREE.BoxGeometry(0.86, 0.06, 0.86);
        const capMat = new THREE.MeshBasicMaterial({ toneMapped: false });
        const caps = new THREE.InstancedMesh(capGeo, capMat, N);
        city.add(bars, caps);

        const plinthGeo = new THREE.BoxGeometry(DAYS * GAP + 1.2, 0.24, ROWS * GAP + 1.2);
        const plinthMat = new THREE.MeshStandardMaterial({ color: 0x0b0e15, roughness: 0.9, metalness: 0 });
        const plinth = new THREE.Mesh(plinthGeo, plinthMat);
        plinth.position.y = -0.12;
        city.add(plinth);

        const grid = new THREE.GridHelper(80, 80, 0x2b3a5c, 0x141b29);
        const gridMat = grid.material as InstanceType<typeof THREE.Material>;
        gridMat.transparent = true;
        gridMat.opacity = 0.55;
        grid.position.y = -0.25;
        scene.add(grid);

        // soft coloured glow under the city, tinted by the mode
        const glowCanvas = document.createElement("canvas");
        glowCanvas.width = glowCanvas.height = 256;
        const g = glowCanvas.getContext("2d")!;
        const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
        grad.addColorStop(0, "rgba(255,255,255,0.9)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = grad;
        g.fillRect(0, 0, 256, 256);
        const glowTex = new THREE.CanvasTexture(glowCanvas);
        const glowMat = new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false });
        const glowGeo = new THREE.PlaneGeometry(30, 30);
        const glow = new THREE.Mesh(glowGeo, glowMat);
        glow.rotation.x = -Math.PI / 2;
        glow.position.y = -0.24;
        scene.add(glow);

        // flour dust drifting up
        const DUST = 360;
        const dustPos = new Float32Array(DUST * 3);
        for (let i = 0; i < DUST; i++) {
          dustPos[i * 3] = (Math.random() - 0.5) * 34;
          dustPos[i * 3 + 1] = Math.random() * 12;
          dustPos[i * 3 + 2] = (Math.random() - 0.5) * 22;
        }
        const dustGeo = new THREE.BufferGeometry();
        dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
        const dustMat = new THREE.PointsMaterial({ size: 0.07, color: 0xffe9cf, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
        const dust = new THREE.Points(dustGeo, dustMat);
        scene.add(dust);

        // ---- state
        let cells: Cell[] = buildCells(modeRef.current);
        let shownMode = modeRef.current;
        const heights = new Float32Array(N); // starts flat: the city rises in
        const colors = Array.from({ length: N }, () => new THREE.Color(0x1a2233));
        const target = new THREE.Color();
        const glowColor = new THREE.Color(MODES.find((m) => m.id === shownMode)!.color);
        const glowTarget = new THREE.Color();
        const white = new THREE.Color(0xffffff);
        const body = new THREE.Color();
        const dummy = new THREE.Object3D();
        const ray = new THREE.Raycaster();
        const ndc = new THREE.Vector2(9, 9);
        const pointer = { x: 0, y: 0, px: 0, py: 0, inside: false };
        const look = { x: 0, y: 0 };
        let hovered = -1;
        let raf = 0;
        let visible = true;
        const t0 = performance.now();

        const resize = () => {
          const w = el.clientWidth || 1;
          const h = el.clientHeight || 1;
          renderer.setSize(w, h, false);
          camera.aspect = w / h;
          // narrow screens: step back so the whole city fits
          const far = camera.aspect < 1 ? 1.4 : camera.aspect < 1.4 ? 1.08 : 0.86;
          camera.position.set(17 * far, 14.5 * far, 19 * far);
          camera.lookAt(lookAt);
          camera.updateProjectionMatrix();
        };
        const ro = new ResizeObserver(resize);
        ro.observe(el);
        resize();

        const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
        io.observe(el);

        const onMove = (e: PointerEvent) => {
          const r = el.getBoundingClientRect();
          pointer.px = e.clientX - r.left;
          pointer.py = e.clientY - r.top;
          pointer.x = (pointer.px / r.width) * 2 - 1;
          pointer.y = -(pointer.py / r.height) * 2 + 1;
          pointer.inside = true;
          ndc.set(pointer.x, pointer.y);
        };
        const onLeave = () => {
          pointer.inside = false;
          ndc.set(9, 9);
        };
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerdown", onMove);
        el.addEventListener("pointerleave", onLeave);

        const showTip = (i: number) => {
          const t = tip.current;
          if (!t) return;
          if (i < 0) {
            t.style.opacity = "0";
            return;
          }
          const cell = cells[i];
          t.firstElementChild!.textContent = cell.title;
          t.lastElementChild!.textContent = cell.label;
          const flip = pointer.px > el.clientWidth * 0.62;
          t.style.transform = `translate(${pointer.px + (flip ? -14 : 14)}px, ${pointer.py - 14}px) translate(${flip ? "-100%" : "0"}, -100%)`;
          t.style.opacity = "1";
        };

        const frame = (now: number) => {
          raf = requestAnimationFrame(frame);
          if (!visible || document.hidden) return;
          const time = (now - t0) / 1000;

          if (modeRef.current !== shownMode) {
            shownMode = modeRef.current;
            cells = buildCells(shownMode);
          }
          glowTarget.set(MODES.find((m) => m.id === shownMode)!.color);
          glowColor.lerp(glowTarget, reduced ? 1 : 0.06);
          glowMat.color.copy(glowColor);

          // pointer parallax + slow sway
          look.x += ((pointer.inside ? pointer.x : 0) - look.x) * 0.05;
          look.y += ((pointer.inside ? pointer.y : 0) - look.y) * 0.05;
          city.rotation.y = (reduced ? 0 : Math.sin(time * 0.15) * 0.32) + look.x * 0.35;
          city.rotation.x = -look.y * 0.06;
          glow.rotation.z = city.rotation.y;

          // hover
          ray.setFromCamera(ndc, camera);
          const hit = pointer.inside ? ray.intersectObject(bars, false)[0] : undefined;
          const now_h = hit?.instanceId ?? -1;
          if (now_h !== hovered || now_h >= 0) {
            hovered = now_h;
            showTip(hovered);
            el.style.cursor = hovered >= 0 ? "pointer" : "default";
          }

          const k = reduced ? 1 : 0.085;
          for (let i = 0; i < N; i++) {
            const r = Math.floor(i / DAYS);
            const c = i % DAYS;
            let h = cells[i].height * MAX_H;
            if (shownMode === "voice") {
              const wave = Math.abs(Math.sin(time * 2.4 + c * 0.55 + r * 0.8)) * (0.55 + 0.45 * Math.sin(time * 1.3 + r * 1.7));
              h = MAX_H * (0.12 + 0.62 * Math.max(0, wave));
            }
            heights[i] += (h - heights[i]) * k;
            const hi = Math.max(heights[i], 0.03);

            dummy.position.set(ox + c * GAP, 0, oz + r * GAP);
            dummy.scale.set(1, hi, 1);
            dummy.updateMatrix();
            bars.setMatrixAt(i, dummy.matrix);
            dummy.position.y = hi;
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            caps.setMatrixAt(i, dummy.matrix);

            colors[i].lerp(target.set(cells[i].color), reduced ? 1 : 0.08);
            body.copy(colors[i]).multiplyScalar(i === hovered ? 1.15 : 0.78);
            bars.setColorAt(i, body);
            caps.setColorAt(i, i === hovered ? white : body.copy(colors[i]).lerp(white, 0.22));
          }
          bars.instanceMatrix.needsUpdate = true;
          caps.instanceMatrix.needsUpdate = true;
          if (bars.instanceColor) bars.instanceColor.needsUpdate = true;
          if (caps.instanceColor) caps.instanceColor.needsUpdate = true;

          if (!reduced) {
            const p = dustGeo.attributes.position.array as Float32Array;
            for (let i = 0; i < DUST; i++) {
              p[i * 3 + 1] += 0.004 + (i % 7) * 0.0012;
              p[i * 3] += Math.sin(time * 0.4 + i) * 0.002;
              if (p[i * 3 + 1] > 12) p[i * 3 + 1] = 0;
            }
            dustGeo.attributes.position.needsUpdate = true;
          }

          renderer.render(scene, camera);
        };
        raf = requestAnimationFrame(frame);
        setReady(true);

        stop = () => {
          cancelAnimationFrame(raf);
          ro.disconnect();
          io.disconnect();
          el.removeEventListener("pointermove", onMove);
          el.removeEventListener("pointerdown", onMove);
          el.removeEventListener("pointerleave", onLeave);
          [barGeo, capGeo, plinthGeo, glowGeo, dustGeo].forEach((x) => x.dispose());
          [barMat, capMat, plinthMat, gridMat, glowMat, dustMat].forEach((x) => x.dispose());
          glowTex.dispose();
          grid.geometry.dispose();
          bars.dispose();
          caps.dispose();
          renderer.dispose();
          renderer.domElement.remove();
        };
      })
      .catch(() => {
        /* three.js failed to load: keep the CSS backdrop */
      });

    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  return (
    <div className={className}>
      <div ref={host} className={`absolute inset-0 transition-opacity duration-1000 ${ready ? "opacity-100" : "opacity-0"}`} aria-hidden />
      <div
        ref={tip}
        className="pointer-events-none absolute left-0 top-0 z-10 rounded-lg border border-white/10 bg-[#0e1118]/95 px-2.5 py-1.5 text-[11px] opacity-0 shadow-xl backdrop-blur transition-opacity"
        role="presentation"
      >
        <div className="font-semibold text-white" />
        <div className="tnum mt-0.5 text-white/65" />
      </div>
    </div>
  );
}
