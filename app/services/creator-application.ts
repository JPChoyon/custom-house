import { DomainError, normalizeHttpsUrl } from "./domain.ts";

export interface CreatorApplicationInput { legalName: string; displayName: string; country: string; city: string; bio: string; portfolioUrl?: string; socialLinks?: string[]; profileImageUrl?: string; message?: string; termsAccepted: boolean }

function cleanText(value: string, name: string, min: number, max: number): string {
  const normalized = Array.from(value, (character) => { const code = character.charCodeAt(0); return code < 32 || code === 127 ? " " : character; }).join("").replace(/\s+/g, " ").trim();
  if (normalized.length < min || normalized.length > max) throw new DomainError("INVALID_INPUT", `${name} must be ${min}-${max} characters.`);
  return normalized;
}

export function validateCreatorApplication(input: CreatorApplicationInput) {
  if (!input.termsAccepted) throw new DomainError("TERMS_REQUIRED", "You must accept the creator terms.");
  const profileImageUrl = input.profileImageUrl ? (input.profileImageUrl.startsWith("gid://shopify/MediaImage/") ? input.profileImageUrl : normalizeHttpsUrl(input.profileImageUrl)) : undefined;
  return { legalName: cleanText(input.legalName, "Legal name", 2, 120), displayName: cleanText(input.displayName, "Display name", 2, 80), country: cleanText(input.country, "Country", 2, 80), city: cleanText(input.city, "City", 1, 100), bio: cleanText(input.bio, "Biography", 10, 1000), portfolioUrl: input.portfolioUrl ? normalizeHttpsUrl(input.portfolioUrl) : undefined, socialLinks: (input.socialLinks || []).filter(Boolean).slice(0, 5).map((url) => normalizeHttpsUrl(url)), profileImageUrl, message: input.message?.trim() ? cleanText(input.message, "Message", 1, 1000) : undefined, termsAcceptedAt: new Date() };
}

export function validateProfileImage(bytes: Uint8Array, mimeType: string, size: number): void {
  if (size <= 0 || size > 5 * 1024 * 1024) throw new DomainError("INVALID_PROFILE_IMAGE", "Profile image must be 5 MB or smaller.");
  const jpg = mimeType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const png = mimeType === "image/png" && pngSignature.every((value, index) => bytes[index] === value);
  const webp = mimeType === "image/webp" && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  if (!jpg && !png && !webp) throw new DomainError("INVALID_PROFILE_IMAGE", "Profile image must be a valid JPG, PNG, or WebP file.");
}
