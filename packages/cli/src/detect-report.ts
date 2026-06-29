// Pre-browser provider report ("Found: Claude ready …"), so the user sees their pool before the
// UI opens (SPEC §13).
import { DAEMON_HOST, type DetectedProvider } from '@thaloslab/shared';

export async function fetchProviders(port: number): Promise<DetectedProvider[]> {
  try {
    const res = await fetch(`http://${DAEMON_HOST}:${port}/api/providers`);
    if (!res.ok) return [];
    return (await res.json()) as DetectedProvider[];
  } catch {
    return [];
  }
}

export function formatProviders(providers: DetectedProvider[]): string {
  if (providers.length === 0) return 'none detected';
  return providers
    .map((p) => {
      const state = !p.installed ? 'not found' : p.authenticated ? 'ready' : 'needs login';
      return `${p.displayName} (${state}${p.version ? ` ${p.version}` : ''})`;
    })
    .join(', ');
}
