import { useCallback, useEffect, useRef, useState } from 'react';
import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { useGestureStore } from '../store/gestureStore';

/**
 * In-browser replacement for the Python + MediaPipe WebSocket sidecar
 * (see hand_tracker/hand_tracker.py). Runs MediaPipe's HandLandmarker as
 * WASM directly in the tab against the user's webcam, and ports the same
 * gesture logic (finger-extension tests, palm-drag rotate, two-index zoom,
 * closed-fist reset, debouncing, EMA smoothing, dead zones, rate clamping)
 * from Python to TypeScript so the interaction feels identical.
 *
 * No server, no install — this is what lets a deployed static site offer
 * real hand-tracking instead of only working when a local Python process
 * is running.
 */

// ── MediaPipe landmark indices (identical layout to the Python solutions API) ─
const WRIST = 0;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const MIDDLE_TIP = 12;
const MIDDLE_PIP = 10;
const RING_TIP = 16;
const RING_PIP = 14;
const PINKY_MCP = 17;
const PINKY_TIP = 20;
const PINKY_PIP = 18;

const FINGER_TIPS = [INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP];
const FINGER_PIPS = [INDEX_PIP, MIDDLE_PIP, RING_PIP, PINKY_PIP];

// ── Tunables — ported 1:1 from hand_tracker.py ────────────────────────────────
const INDEX_ZOOM_SCALE = 4.0;
const ROTATE_RATE_SCALE = 3.5;
const ZOOM_DEAD = 0.003;
const ROTATE_DEAD = 0.004;
const RATE_EMA_ALPHA = 0.4;
const MAX_RATE = 5.0;
const FIST_HOLD_SECS = 1.0;
const GESTURE_ENTER_FRAMES = 3;
const GESTURE_EXIT_FRAMES = 5;
const INDEX_ZOOM_ENTER = 2;
const INDEX_ZOOM_EXIT = 4;

// Clamp dt so a dropped/slow frame can't produce a rate spike
const MIN_DT = 1 / 120;
const MAX_DT = 1 / 5;

type Landmark = { x: number; y: number };

// ── Geometry helpers (mirrored: MediaPipe's x is un-mirrored camera space;
//    we flip it so the interaction matches a natural selfie-view, same as
//    the Python side's cv2.flip(frame, 1) before processing) ─────────────────
const mx = (lm: Landmark) => 1 - lm.x;

function dist2d(a: Landmark, b: Landmark): number {
  const ax = mx(a);
  const bx = mx(b);
  return Math.hypot(ax - bx, a.y - b.y);
}

function fingerExtended(lm: Landmark[], tipIdx: number, pipIdx: number): boolean {
  return dist2d(lm[WRIST], lm[tipIdx]) > dist2d(lm[WRIST], lm[pipIdx]) * 1.1;
}

function indexExtended(lm: Landmark[]): boolean {
  return fingerExtended(lm, INDEX_TIP, INDEX_PIP);
}

function isClosedFist(lm: Landmark[]): boolean {
  return FINGER_TIPS.every((tip, i) => !fingerExtended(lm, tip, FINGER_PIPS[i]));
}

function isOpenPalm(lm: Landmark[]): boolean {
  const extended = FINGER_TIPS.reduce(
    (n, tip, i) => n + (fingerExtended(lm, tip, FINGER_PIPS[i]) ? 1 : 0),
    0,
  );
  return extended >= 3;
}

function palmCenter(lm: Landmark[]): [number, number] {
  return [
    (mx(lm[WRIST]) + mx(lm[INDEX_MCP]) + mx(lm[PINKY_MCP])) / 3,
    (lm[WRIST].y + lm[INDEX_MCP].y + lm[PINKY_MCP].y) / 3,
  ];
}

// ── Hysteresis filter — identical semantics to Python's GestureDebouncer ──────
class GestureDebouncer {
  private active = false;
  private count = 0;
  private enter: number;
  private exit: number;

  constructor(enter = GESTURE_ENTER_FRAMES, exit = GESTURE_EXIT_FRAMES) {
    this.enter = enter;
    this.exit = exit;
  }

  update(raw: boolean): boolean {
    if (this.active) {
      this.count = raw ? this.exit : Math.max(this.count - 1, 0);
      if (this.count === 0) this.active = false;
    } else {
      this.count = raw ? Math.min(this.count + 1, this.enter) : Math.max(this.count - 1, 0);
      if (this.count >= this.enter) this.active = true;
    }
    return this.active;
  }

  reset() {
    this.active = false;
    this.count = 0;
  }
}

interface GestureUpdate {
  gesture: string | null;
  hands: number;
  zoomRate: number;
  spinYRate: number;
  rotateXRate: number;
  rotateYRate: number;
  reset: boolean;
}

function emptyUpdate(hands = 0): GestureUpdate {
  return { gesture: null, hands, zoomRate: 0, spinYRate: 0, rotateXRate: 0, rotateYRate: 0, reset: false };
}

export function useBrowserHandTracking() {
  const { update, setConnected } = useGestureStore();

  const [status, setStatus] = useState<'idle' | 'loading' | 'running' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const rafRef = useRef<number | null>(null);
  const activeRef = useRef(false);

  // Per-hand temporal state (mirrors HandState in hand_tracker.py)
  const palmDbcRef = useRef(new GestureDebouncer());
  const fistDbcRef = useRef(new GestureDebouncer());
  const indexZoomDbcRef = useRef(new GestureDebouncer(INDEX_ZOOM_ENTER, INDEX_ZOOM_EXIT));
  const prevPalmRef = useRef<{ x: number; y: number } | null>(null);
  const fistStartRef = useRef<number | null>(null);
  const prevIndexDistRef = useRef<number | null>(null);
  const smoothRef = useRef({ zoomRate: 0, rotateXRate: 0, rotateYRate: 0 });
  const prevGestureRef = useRef<string | null>(null);
  const lastTsRef = useRef<number | null>(null);

  const clampRates = (u: GestureUpdate) => {
    u.zoomRate = Math.max(-MAX_RATE, Math.min(MAX_RATE, u.zoomRate));
    u.rotateXRate = Math.max(-MAX_RATE, Math.min(MAX_RATE, u.rotateXRate));
    u.rotateYRate = Math.max(-MAX_RATE, Math.min(MAX_RATE, u.rotateYRate));
  };

  const applySmooth = (u: GestureUpdate) => {
    if (u.gesture !== prevGestureRef.current) {
      smoothRef.current = { zoomRate: 0, rotateXRate: 0, rotateYRate: 0 };
    }
    prevGestureRef.current = u.gesture;
    const s = smoothRef.current;
    s.zoomRate = RATE_EMA_ALPHA * u.zoomRate + (1 - RATE_EMA_ALPHA) * s.zoomRate;
    s.rotateXRate = RATE_EMA_ALPHA * u.rotateXRate + (1 - RATE_EMA_ALPHA) * s.rotateXRate;
    s.rotateYRate = RATE_EMA_ALPHA * u.rotateYRate + (1 - RATE_EMA_ALPHA) * s.rotateYRate;
    u.zoomRate = s.zoomRate;
    u.rotateXRate = s.rotateXRate;
    u.rotateYRate = s.rotateYRate;
  };

  const resetTemporalState = useCallback(() => {
    prevIndexDistRef.current = null;
    prevPalmRef.current = null;
    fistStartRef.current = null;
    palmDbcRef.current.reset();
    fistDbcRef.current.reset();
    indexZoomDbcRef.current.reset();
    smoothRef.current = { zoomRate: 0, rotateXRate: 0, rotateYRate: 0 };
  }, []);

  // Ported from process_frame() in hand_tracker.py
  const processHands = useCallback(
    (hands: Landmark[][], dt: number) => {
      const u = emptyUpdate(hands.length);

      if (hands.length === 0) {
        resetTemporalState();
        update(u);
        return;
      }

      // Two-index zoom — takes priority when both hands are present
      if (hands.length >= 2) {
        const lm0 = hands[0];
        const lm1 = hands[1];
        const bothPointing = indexExtended(lm0) && indexExtended(lm1);
        const zoomActive = indexZoomDbcRef.current.update(bothPointing);

        if (zoomActive && bothPointing) {
          const d = dist2d(lm0[INDEX_TIP], lm1[INDEX_TIP]);
          if (prevIndexDistRef.current !== null) {
            const delta = d - prevIndexDistRef.current;
            if (Math.abs(delta) > ZOOM_DEAD) {
              u.gesture = 'index_zoom';
              u.zoomRate = (delta * INDEX_ZOOM_SCALE) / dt;
            }
          }
          prevIndexDistRef.current = d;
          clampRates(u);
          applySmooth(u);
          update(u);
          return;
        } else if (!bothPointing) {
          prevIndexDistRef.current = null;
        }
      } else {
        indexZoomDbcRef.current.update(false);
        prevIndexDistRef.current = null;
      }

      // Single-hand gestures (first detected hand)
      const lm = hands[0];

      // Open palm + drag → rotate
      if (palmDbcRef.current.update(isOpenPalm(lm))) {
        const [px, py] = palmCenter(lm);
        if (prevPalmRef.current) {
          const dx = px - prevPalmRef.current.x;
          const dy = py - prevPalmRef.current.y;
          if (Math.abs(dx) > ROTATE_DEAD || Math.abs(dy) > ROTATE_DEAD) {
            u.gesture = 'palm_rotate';
            u.rotateYRate = (dx * ROTATE_RATE_SCALE) / dt;
            u.rotateXRate = (dy * ROTATE_RATE_SCALE) / dt;
          }
        }
        prevPalmRef.current = { x: px, y: py };
        fistStartRef.current = null;
        clampRates(u);
        applySmooth(u);
        update(u);
        return;
      }
      prevPalmRef.current = null;

      // Closed fist held 1s → reset
      if (fistDbcRef.current.update(isClosedFist(lm))) {
        const now = performance.now() / 1000;
        if (fistStartRef.current === null) {
          fistStartRef.current = now;
        } else if (now - fistStartRef.current >= FIST_HOLD_SECS) {
          u.gesture = 'reset';
          u.reset = true;
          fistStartRef.current = now + 9999; // block repeat until fist released
        } else {
          u.gesture = 'fist_holding';
        }
      } else {
        fistStartRef.current = null;
      }

      clampRates(u);
      applySmooth(u);
      update(u);
    },
    [resetTemporalState, update],
  );

  const loop = useCallback(() => {
    if (!activeRef.current) return;
    const video = videoRef.current;
    const landmarker = landmarkerRef.current;

    if (video && landmarker && video.readyState >= 2) {
      const now = performance.now();
      const result = landmarker.detectForVideo(video, now);
      const dtRaw = lastTsRef.current === null ? 1 / 30 : (now - lastTsRef.current) / 1000;
      const dt = Math.min(Math.max(dtRaw, MIN_DT), MAX_DT);
      lastTsRef.current = now;
      processHands((result.landmarks ?? []) as Landmark[][], dt);
    }

    rafRef.current = requestAnimationFrame(loop);
  }, [processHands]);

  const stop = useCallback(() => {
    activeRef.current = false;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    landmarkerRef.current?.close();
    landmarkerRef.current = null;
    lastTsRef.current = null;
    resetTemporalState();
    setConnected(false);
    setStatus('idle');
  }, [resetTemporalState, setConnected]);

  const start = useCallback(async () => {
    if (activeRef.current) return;
    setStatus('loading');
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, frameRate: 30 },
        audio: false,
      });
      streamRef.current = stream;

      const video = document.createElement('video');
      video.playsInline = true;
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      videoRef.current = video;

      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm',
      );
      const landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.7,
        minTrackingConfidence: 0.6,
      });
      landmarkerRef.current = landmarker;

      activeRef.current = true;
      setConnected(true);
      setStatus('running');
      loop();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not start hand tracking';
      setError(message);
      setStatus('error');
      stop();
    }
  }, [loop, setConnected, stop]);

  // Clean up camera + WASM runtime on unmount
  useEffect(() => () => stop(), [stop]);

  return { status, error, start, stop };
}
