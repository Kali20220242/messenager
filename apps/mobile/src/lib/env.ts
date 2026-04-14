import { z } from "zod";

const envSchema = z.object({
  EXPO_PUBLIC_API_URL: z.string().url(),
  EXPO_PUBLIC_SUPABASE_URL: z
    .string()
    .url()
    .default("https://adfitwokuhqqiguizfxq.supabase.co"),
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().default("sb_publishable_QkRaUki_hTIXzrkBtEP6PA_P3uM1ujV"),
});

export const env = envSchema.parse({
  EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
  EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
});
