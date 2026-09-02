import { z } from 'zod';

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;

export type EmailAttachment = {
  filename: string;
  contentType: string;
  content: string;
};

export type AttachmentMeta = {
  filename: string;
  contentType: string;
};

function decodedSize(base64: string) {
  return Buffer.from(base64, 'base64').byteLength;
}

export const attachmentsSchema = z
  .array(
    z.object({
      filename: z.string().min(1).max(255),
      contentType: z.string().min(1).max(200),
      content: z.string().min(1),
    }),
  )
  .max(MAX_ATTACHMENTS)
  .default([])
  .superRefine((files, ctx) => {
    let total = 0;
    for (const [index, file] of files.entries()) {
      const size = decodedSize(file.content);
      total += size;
      if (size > MAX_ATTACHMENT_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${file.filename} is larger than 8 MB`,
          path: [index],
        });
      }
    }
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Attachments together must be under 20 MB',
      });
    }
  });

export function publicAttachments(attachments: EmailAttachment[] | null | undefined): AttachmentMeta[] {
  return (attachments ?? []).map(({ filename, contentType }) => ({ filename, contentType }));
}

export function mailAttachments(attachments: EmailAttachment[] | null | undefined) {
  return (attachments ?? []).map((file) => ({
    filename: file.filename.replace(/[/\\]/g, '_'),
    contentType: file.contentType,
    content: Buffer.from(file.content, 'base64'),
  }));
}
