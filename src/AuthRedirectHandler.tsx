import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from './supabaseClient';

// Supabase's email-confirmation, "Continue with Google", and forgot-password
// links all redirect back to the app's plain origin URL with a one-time
// `?code=...` query param (PKCE flow - see supabaseClient.ts). supabase-js
// exchanges that for a real session automatically on load; this component
// just waits for that to land, then hops to /account and wipes the query
// param so a page refresh can't try to reuse an already-spent code.
export default function AuthRedirectHandler() {
  const navigate = useNavigate();

  useEffect(() => {
    const hadCode = new URLSearchParams(window.location.search).has('code');
    if (!hadCode) return;

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'PASSWORD_RECOVERY') {
        window.history.replaceState(null, '', window.location.pathname + window.location.hash);
        navigate('/account', { replace: true });
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [navigate]);

  return null;
}
