import assert from "node:assert/strict";
import test from "node:test";
import { validateCreatorApplication, validateProfileImage } from "../app/services/creator-application.ts";

const valid = { legalName: "Ada Lovelace", displayName: "Ada Creates", country: "Sweden", city: "Stockholm", bio: "A sufficiently long creator biography.", portfolioUrl: "https://example.org/portfolio", socialLinks: ["https://example.org/social"], termsAccepted: true };

test("valid creator application is normalized", () => { const value = validateCreatorApplication(valid); assert.equal(value.displayName, "Ada Creates"); assert.equal(value.socialLinks.length, 1); assert.ok(value.termsAcceptedAt instanceof Date); });
test("creator terms are required", () => assert.throws(() => validateCreatorApplication({ ...valid, termsAccepted: false }), /accept the creator terms/i));
test("invalid creator application input is rejected", () => assert.throws(() => validateCreatorApplication({ ...valid, legalName: "A" }), /Legal name/));
test("non-HTTPS portfolio is rejected", () => assert.throws(() => validateCreatorApplication({ ...valid, portfolioUrl: "http://example.org" }), /HTTPS/));
test("valid PNG signature is accepted", () => assert.doesNotThrow(() => validateProfileImage(Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), "image/png", 8)));
test("invalid profile image signature is rejected", () => assert.throws(() => validateProfileImage(Uint8Array.from([1,2,3]), "image/png", 3), /valid JPG/));
test("oversized profile image is rejected", () => assert.throws(() => validateProfileImage(Uint8Array.from([0xff,0xd8,0xff]), "image/jpeg", 5 * 1024 * 1024 + 1), /5 MB/));
