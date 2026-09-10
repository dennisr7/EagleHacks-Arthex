import { useGestureStore } from '../../store/gestureStore';
import type { useBrowserHandTracking } from '../../hooks/useBrowserHandTracking';

const GESTURE_LABEL: Record<string, string> = {
  index_zoom:   '⟷  Zoom (two index fingers)',
  palm_rotate:  '↕  Rotate (open palm drag)',
  fist_holding: '✊  Hold 1 s to reset…',
  reset:        '↺  Reset',
};

type HandTracking = ReturnType<typeof useBrowserHandTracking>;

export default function GestureOverlay({ tracking }: { tracking: HandTracking }) {
  const connected = useGestureStore((s) => s.connected);
  const gesture   = useGestureStore((s) => s.gesture);
  const hands     = useGestureStore((s) => s.hands);
  const { status, error, start, stop } = tracking;

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 select-none z-10">
      {connected ? (
        <button
          onClick={stop}
          className="pointer-events-auto flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-950/70 text-emerald-300 text-xs border border-emerald-800/50 hover:bg-emerald-950 transition-colors"
          title="Turn off camera hand-tracking"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          Hand tracking · {hands} hand{hands !== 1 ? 's' : ''}
        </button>
      ) : (
        <button
          onClick={start}
          disabled={status === 'loading'}
          className="pointer-events-auto px-6 py-3 rounded-xl bg-slate-600 text-white text-base font-semibold border border-slate-400/60 shadow-lg shadow-black/30 hover:bg-slate-500 active:bg-slate-700 transition-colors disabled:opacity-60"
        >
          {status === 'loading' ? 'Starting camera…' : '🖐  Enable Camera'}
        </button>
      )}

      {status === 'error' && error && (
        <div className="pointer-events-none px-3 py-1 rounded-full bg-red-950/70 text-red-300 text-[11px] border border-red-800/50 max-w-xs text-center">
          {error.toLowerCase().includes('permission') || error.toLowerCase().includes('denied')
            ? 'Camera permission denied — allow camera access to use hand tracking.'
            : `Couldn't start hand tracking: ${error}`}
        </div>
      )}

      {connected && gesture && GESTURE_LABEL[gesture] && (
        <div className="pointer-events-none px-3 py-1 rounded-full bg-black/60 text-white text-xs border border-white/10">
          {GESTURE_LABEL[gesture]}
        </div>
      )}
    </div>
  );
}
