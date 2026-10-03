import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let client = null;

if (supabaseUrl && supabaseKey) {
  try {
    client = createClient(supabaseUrl, supabaseKey);
  } catch (err) {
    console.error('Failed to create Supabase client:', err);
  }
}

// Safe proxy chain to bypass build-time crashes if environment variables are not present
if (!client) {
  console.warn('Supabase URL or Key is missing. Running in mock/fallback mode.');

  const makeSafeMock = () => {
    const handler = {
      get(target, prop) {
        if (prop === 'then') {
          return (resolve) => resolve({ data: null, error: { message: 'Supabase is unconfigured.' } });
        }
        // Return a proxy-wrapped function so that it handles chain calls and property access seamlessly
        const mockFn = () => new Proxy(mockFn, handler);
        return new Proxy(mockFn, handler);
      }
    };
    return new Proxy({}, handler);
  };

  client = makeSafeMock();
}

export const supabase = client;
export { client as supabaseClient };
export const isSupabaseConfigured = !!supabaseUrl && !!supabaseKey;
