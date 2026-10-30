import { useEffect } from 'react';
import { useAuth } from './context/AuthContext';
import Gate from './components/Gate';
import Shell from './components/Shell';
import AcceptInvite from './components/AcceptInvite';

const inviteMatch = window.location.pathname.match(/^\/invite\/([^/]+)$/);

export default function App() {
  const { me, loading, refresh } = useAuth();

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (inviteMatch) return <AcceptInvite token={inviteMatch[1]} />;
  if (loading) return null;
  return me ? <Shell /> : <Gate />;
}
