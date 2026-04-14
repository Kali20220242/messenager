import { z } from "zod";

const envSchema = z.object({
  EXPO_PUBLIC_SUPABASE_URL: z
    .string()
    .url()
    .default("https://your-project-ref.supabase.co"),
  EXPO_PUBLIC_SUPABASE_ANON_KEY: z.string().default("your-anon-key"),
});

export const env = envSchema.parse({
  EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
});

