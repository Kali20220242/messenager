import { createClient } from "@supabase/supabase-js";

import { env } from "./lib/env";
import { secureStorage } from "./lib/storage";

export const supabase = createClient(
  env.EXPO_PUBLIC_SUPABASE_URL,
  env.EXPO_PUBLIC_SUPABASE_KEY,
  {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: false,
      persistSession: true,
      storageKey: "messenger.auth.token",
      storage: secureStorage,
    },
  },
);
