import { createClient } from "@supabase/supabase-js";

import { env } from "./env";
import { secureStorage } from "./storage";

export const supabase = createClient(
  env.EXPO_PUBLIC_SUPABASE_URL,
  env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: false,
      persistSession: true,
      storage: secureStorage,
    },
  },
);

