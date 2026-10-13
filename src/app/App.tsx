import { useEffect } from "react";
import { HashRouter, Routes, Route, useLocation } from "react-router";
import { SidebarHome } from "./components/SidebarHome";
import { Options } from "./components/Options";
import { Preview } from "./components/Preview";
import { Report } from "./components/Report";
import { Recommendations } from "./components/Recommendations";
import { History } from "./components/History";
import { ManageBookmarks } from "./components/ManageBookmarks";
import { HabitPresets } from "./components/HabitPresets";
import { Backups } from "./components/Backups";
import { ImportBookmarks } from "./components/ImportBookmarks";
import { Onboarding } from "./components/Onboarding";
import { MoreTools } from "./components/MoreTools";
import { useAppStore } from "./store/useAppStore";

type AppProps = {
  defaultView?: "popup" | "options" | "sidebar";
};

function AppRoutes({ defaultView = "popup" }: AppProps) {
  const location = useLocation();
  const { settings, loadSettings } = useAppStore();
  const isPopupHome = defaultView === "popup" && ["/", "/home"].includes(location.pathname);
  const isPopupWindow = defaultView === "popup";
  const isSidebarWindow = defaultView === "sidebar";

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);

  const home = settings.onboardingCompleted
    ? defaultView === "options"
      ? <Options />
      : defaultView === "sidebar"
        ? <SidebarHome />
        : <SidebarHome compact />
    : <Onboarding defaultView={defaultView} />;

  return (
    <div
      className={
        isPopupWindow
          ? `remarks-app bookmark-popup-window bg-gray-50${isPopupHome ? " bookmark-popup-window--home" : ""}`
          : isSidebarWindow
            ? "remarks-app sidebar-shell bg-gray-50"
            : "remarks-app w-full min-h-screen bg-gray-50"
      }
    >
      <Routes>
        <Route
          path="/"
          element={home}
        />
        <Route path="/options" element={<Options />} />
        <Route path="/home" element={<SidebarHome compact={isPopupWindow} />} />
        <Route path="/preview" element={<Preview />} />
        <Route path="/report" element={<Report />} />
        <Route path="/recommendations" element={<Recommendations />} />
        <Route path="/history" element={<History />} />
        <Route path="/manage" element={<ManageBookmarks />} />
        <Route path="/habits" element={<HabitPresets />} />
        <Route path="/backups" element={<Backups />} />
        <Route path="/import" element={<ImportBookmarks />} />
        <Route path="/more" element={<MoreTools />} />
        <Route path="/tasks" element={<SidebarHome showAllTasks />} />
      </Routes>
    </div>
  );
}

export default function App(props: AppProps) {
  return (
    <HashRouter>
      <AppRoutes {...props} />
    </HashRouter>
  );
}
