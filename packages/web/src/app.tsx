import { LeftRail } from './layout/LeftRail';
import { MainPage } from './pages/Main';

export function App() {
  return (
    <div className="flex h-full">
      <LeftRail />
      <main className="flex-1 overflow-auto">
        <MainPage />
      </main>
    </div>
  );
}
