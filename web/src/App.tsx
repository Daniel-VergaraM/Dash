import { useEffect } from 'react';
import { useAuth } from './context/AuthContext';
import Gate from './components/Gate';
import Shell from './components/Shell';

export default function App() {
  const { me, loading, refresh } = useAuth();

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading) return null;
  return me ? <Shell /> : <Gate />;
}
