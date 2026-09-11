import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { jf } from '../lib/api';
import type { Capability, Me } from '../types';

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  can: (cap: Capability) => boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const m = await jf<Me>('/api/me');
    setMe(m.auth ? m : null);
    setLoading(false);
  }, []);

  const logout = useCallback(async () => {
    await fetch('/api/logout', { method: 'POST' });
    setMe(null);
  }, []);

  const can = useCallback((cap: Capability) => !!me?.caps.includes(cap), [me]);

  return (
    <Ctx.Provider value={{ me, loading, can, refresh, logout }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
