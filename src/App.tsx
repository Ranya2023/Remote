import { HashRouter, Routes, Route } from 'react-router-dom';
import Present from './Present';
import MobileRemote from './MobileRemote';
import AudienceJoin from './AudienceJoin';
import FileUpload from './FileUpload';

export default function App() {
  return (
    <HashRouter>
      <div className="min-h-screen bg-black">
        <Routes>
          {/* 1. First screen the user sees */}
          <Route path="/" element={<FileUpload />} />

          {/* 2. The presentation screen it automatically navigates to */}
          <Route path="/present/:fileId" element={<Present />} />

          {/* 3. The screen the phone opens when scanning the *control* QR code */}
          <Route path="/remote" element={<MobileRemote />} />

          {/* 4. The screen the phone opens when scanning the *audience* QR code
                 (polls, quizzes, Q&A, live feedback - no slide control access) */}
          <Route path="/audience" element={<AudienceJoin />} />
        </Routes>
      </div>
    </HashRouter>
  );
}