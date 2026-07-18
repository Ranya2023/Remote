import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

// true if the build is missing one or both env vars — main.tsx uses this
// to show a visible on-screen banner instead of a blank screen.
export const supabaseConfigError = !url || !key;

if (supabaseConfigError) {
  console.error('🚨 CRITICAL ERROR: Supabase env vars missing!');
  console.error('VITE_SUPABASE_URL:', url ? '✅ found' : '❌ missing');
  console.error('VITE_SUPABASE_ANON_KEY:', key ? '✅ found' : '❌ missing');
  console.error('Check your local .env file, or your CI/CD build secrets if this is a deployed build.');
}

// createClient() throws synchronously on an empty string ("supabaseUrl is
// required."), and since this file runs at import time, that throw kills
// the whole React tree before it can even mount — no error boundary can
// catch it. Keep a syntactically valid placeholder so the client always
// constructs; supabaseConfigError is what actually signals the problem.
export const supabase = createClient(
  url || 'https://placeholder.supabase.co',
  key || 'placeholder-key'
);