import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';

export interface Profile {
  id: string;
  display_name: string | null;
  created_at?: string;
}

export interface UsageSummary {
  presentationCount: number;
  presentationLimit: number;
  storageBytes: number;
  storageLimitBytes: number;
}

// Kept in sync with the limits enforced server-side in supabase_migration_auth.sql
// (the DB trigger is the real authority - these are just so the UI can warn
// *before* an upload, instead of only after a rejected insert).
export const PRESENTATION_LIMIT = 5;
export const STORAGE_LIMIT_BYTES = 100 * 1024 * 1024; // 100 MB

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  usage: UsageSummary | null;
  refreshUsage: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const userId = session?.user?.id;

  const refreshProfile = useCallback(async () => {
    if (!userId) { setProfile(null); return; }
    try {
      const { data, error } = await supabase.from('nextslide_profiles').select('*').eq('id', userId).maybeSingle();
      if (error) throw error;
      setProfile(data || null);
    } catch (err) {
      console.warn('⚠️ Could not load profile (has supabase_migration_auth.sql been run yet?):', err);
    }
  }, [userId]);

  const refreshUsage = useCallback(async () => {
    if (!userId) { setUsage(null); return; }
    try {
      const { data, error } = await supabase
        .from('saved_items')
        .select('size_bytes')
        .eq('user_id', userId)
        .eq('kind', 'lesson');
      if (error) throw error;
      const rows = data || [];
      setUsage({
        presentationCount: rows.length,
        presentationLimit: PRESENTATION_LIMIT,
        storageBytes: rows.reduce((sum, r: any) => sum + (r.size_bytes || 0), 0),
        storageLimitBytes: STORAGE_LIMIT_BYTES,
      });
    } catch (err) {
      console.warn('⚠️ Could not load usage summary:', err);
    }
  }, [userId]);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    refreshProfile();
    refreshUsage();
  }, [refreshProfile, refreshUsage]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  return (
    <AuthContext.Provider
      value={{ session, user: session?.user || null, profile, loading, usage, refreshUsage, refreshProfile, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth() must be used inside <AuthProvider>');
  return ctx;
}
