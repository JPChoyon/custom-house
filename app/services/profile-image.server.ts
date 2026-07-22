import { DomainError } from "./domain";
import { validateProfileImage } from "./creator-application";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";
import { throwUserErrors } from "./shopify-graphql.server";

type UserError = { message: string };

export async function uploadProfileImage(file: File, client: ShopifyGraphqlClient) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  validateProfileImage(bytes, file.type, file.size);
  const staged = await client.request<{ stagedUploadsCreate: { stagedTargets: Array<{ url: string; resourceUrl: string; parameters: Array<{ name: string; value: string }> }>; userErrors: UserError[] } }>(
    `#graphql mutation ProfileImageTarget($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { message } } }`,
    { input: [{ resource: "IMAGE", filename: file.name.slice(0, 120), mimeType: file.type, fileSize: String(file.size), httpMethod: "POST" }] },
  );
  throwUserErrors(staged.stagedUploadsCreate.userErrors, "Profile image upload preparation");
  const target = staged.stagedUploadsCreate.stagedTargets[0];
  if (!target) throw new DomainError("UPLOAD_FAILED", "Profile image upload could not be prepared.", 502);
  const form = new FormData();
  for (const parameter of target.parameters) form.append(parameter.name, parameter.value);
  form.append("file", new Blob([bytes], { type: file.type }), file.name);
  const upload = await fetch(target.url, { method: "POST", body: form });
  if (!upload.ok) throw new DomainError("UPLOAD_FAILED", "Profile image upload failed.", 502);
  const created = await client.request<{ fileCreate: { files: Array<{ id: string; fileStatus: string }>; userErrors: UserError[] } }>(
    `#graphql mutation ProfileImageCreate($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id fileStatus } userErrors { message } } }`,
    { files: [{ originalSource: target.resourceUrl, contentType: "IMAGE", alt: "Creator profile image" }] },
  );
  throwUserErrors(created.fileCreate.userErrors, "Profile image creation");
  const media = created.fileCreate.files[0];
  if (!media) throw new DomainError("UPLOAD_FAILED", "Shopify did not create the profile image.", 502);
  return { profileImageUrl: media.id, status: media.fileStatus };
}
