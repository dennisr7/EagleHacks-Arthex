import { useState } from 'react';
import TopBar from './TopBar';
import AnatomySidebar from './AnatomySidebar';
import ProcedurePanel from '../procedure/ProcedurePanel';
import JointScene from '../scene/JointScene';
import InfoCard from '../procedure/InfoCard';
import GestureOverlay from '../ui/GestureOverlay';
import AIAssistant from '../ui/AIAssistant';
import { useAppStore } from '../../store/appStore';
import { useBrowserHandTracking } from '../../hooks/useBrowserHandTracking';
import { scenes } from '../../data/scenes';

export default function Layout() {
  const viewMode = useAppStore((s) => s.viewMode);
  const activeSceneId = useAppStore((s) => s.activeSceneId);
  const config = scenes[activeSceneId];
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Runs MediaPipe's HandLandmarker as WASM directly in the browser against
  // the visitor's own webcam — no Python sidecar or WebSocket server needed.
  // Started explicitly by the user via the button in GestureOverlay.
  const handTracking = useBrowserHandTracking();

  return (
    <div className="h-screen bg-slate-900 text-white flex flex-col overflow-hidden">
      <TopBar onMenuToggle={() => setSidebarOpen((o) => !o)} />

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar — collapsible, 240px wide */}
        <div
          className="flex-shrink-0 overflow-hidden bg-slate-800 border-r border-slate-700 transition-[width] duration-300 ease-in-out"
          style={{ width: sidebarOpen ? '240px' : '0px' }}
        >
          <div className="w-60 h-full overflow-y-auto overflow-x-hidden">
            <AnatomySidebar />
          </div>
        </div>

        {/* Center viewport — R3F Canvas fills this area */}
        <main
          id="viewport-container"
          className="flex-1 relative bg-slate-950 overflow-hidden"
        >
          <JointScene config={config} />
          <InfoCard />
          <GestureOverlay tracking={handTracking} />
          <AIAssistant />
        </main>

        {/* Right panel — 320px, slides in when procedure mode is active */}
        <div
          className="flex-shrink-0 overflow-hidden bg-slate-800 border-l border-slate-700 transition-[width] duration-300 ease-in-out"
          style={{ width: viewMode === 'procedure' ? '320px' : '0px' }}
        >
          <div className="w-80 h-full overflow-y-auto overflow-x-hidden">
            <ProcedurePanel />
          </div>
        </div>
      </div>
    </div>
  );
}
