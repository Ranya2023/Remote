import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { supabaseConfigError } from './supabaseClient'

// ==========================================
// THE MOBILE WI-FI BYPASS
// Chrome disables 'crypto' on local IP addresses, which instantly crashes Supabase.
// When Supabase crashes, it stops Vite from loading your CSS and buttons!
// This creates a local fallback so your phone portal can connect perfectly.
// ==========================================
if (typeof window !== 'undefined' && !window.crypto) {
  Object.defineProperty(window, 'crypto', {
    value: {
      getRandomValues: (arr: any) => {
        for (let i = 0; i < arr.length; i++) {
          arr[i] = Math.floor(Math.random() * 256);
        }
        return arr;
      }
    }
  });
}

// ==========================================
// SUPABASE AUTH ERROR REDIRECT vs. HASHROUTER
// When Google sign-in (or an email link) fails server-side, Supabase sends
// the browser back to our own URL with the error appended directly onto the
// fragment, e.g. "#error=server_error&error_code=unexpected_failure&
// error_description=Database+error+saving+new+user". Since this app uses
// HashRouter, that fragment IS the router's URL - React Router tries to
// match "/error=server_error&..." as a page, finds nothing ("No routes
// matched"), and the screen just goes blank with no explanation.
//
// This has to run and rewrite the URL BEFORE <App/> (and therefore
// HashRouter) mounts, or the router will have already logged its warning
// and rendered nothing by the time any component could react to it. It
// stashes the human-readable message for Account.tsx to pick up, then
// rewrites the hash to a normal route so the router never sees the broken
// one at all.
(function handleSupabaseAuthErrorRedirect() {
  if (typeof window === 'undefined') return;
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (!raw.includes('error_description=') && !raw.includes('error=')) return;
  const params = new URLSearchParams(raw);
  const description = params.get('error_description') || params.get('error') || 'Sign-in failed.';
  try {
    sessionStorage.setItem('authRedirectError', description);
  } catch {
    // sessionStorage can throw in locked-down/private-browsing contexts -
    // not fatal, the user just won't see the friendly message.
  }
  window.history.replaceState(null, '', window.location.pathname + window.location.search + '#/account');
})();

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('🚨 App crashed during render:', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ background: '#111', color: '#fff', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'sans-serif', textAlign: 'center' }}>
          <h1 style={{ color: '#ef4444', marginBottom: 12 }}>App failed to start</h1>
          <p style={{ color: '#9ca3af', maxWidth: 480 }}>{this.state.error.message}</p>
          <p style={{ color: '#6b7280', fontSize: 12, marginTop: 16 }}>Check the browser console for details.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      {supabaseConfigError && (
        <div style={{ background: '#7f1d1d', color: '#fff', padding: '8px 16px', textAlign: 'center', fontSize: 13, fontWeight: 700 }}>
          🚨 Supabase not configured — VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing at build time.
        </div>
      )}
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)