import { parsePhoneNumberFromString } from "libphonenumber-js";

export function normalizePhoneE164(input: string): string {
  const phone = parsePhoneNumberFromString(input.trim());

  if (!phone || !phone.isValid()) {
    throw new Error("Enter a valid phone number in international format.");
  }

  return phone.number;
}

export function phoneDigits(input: string): string {
  return input.replace(/\D/g, "");
}
