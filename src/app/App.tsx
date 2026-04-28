import { HashRouter, Routes, Route, useLocation } from "react-router";
import { Popup } from "./components/Popup";
import { Options } from "./components/Options";
import { Preview } from "./components/Preview";
import { Report } from "./components/Report";
import { Recommendations } from "./components/Recommendations";
import { History } from "./components/History";
import { ManageBookmarks } from "./components/ManageBookmarks";

type AppProps = {
  defaultView?: "popup" | "options";
};

function AppRoutes({ defaultView = "popup" }: AppProps) {
  const location = useLocation();
  const isPopupHome = defaultView === "popup" && location.pathname === "/";
  const isPopupWindow = defaultView === "popup";

  return (
    <div
      className={
        isPopupWindow
          ? `bookmark-popup-window bg-gray-50${isPopupHome ? " bookmark-popup-window--home" : ""}`
          : "w-full min-w-[360px] min-h-screen bg-gray-50"
      }
    >
      <Routes>
        <Route path="/" element={defaultView === "options" ? <Options /> : <Popup />} />
        <Route path="/options" element={<Options />} />
        <Route path="/preview" element={<Preview />} />
        <Route path="/report" element={<Report />} />
        <Route path="/recommendations" element={<Recommendations />} />
        <Route path="/history" element={<History />} />
        <Route path="/manage" element={<ManageBookmarks />} />
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
