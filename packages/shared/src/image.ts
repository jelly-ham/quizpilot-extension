import { z } from 'zod';

/** Largest accepted data URL, in characters (~6 MB of base64). */
export const MAX_IMAGE_DATA_URL_LENGTH = 8_000_000;

export const ImageDataUrl = z
  .string()
  .max(MAX_IMAGE_DATA_URL_LENGTH)
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/, 'png/jpeg/webp base64 data URL');
export type ImageDataUrl = z.infer<typeof ImageDataUrl>;

export const QuestionImage = z.object({
  id: z.string().min(1).max(64),
  dataUrl: ImageDataUrl,
  alt: z.string().max(1000).optional(),
});
export type QuestionImage = z.infer<typeof QuestionImage>;
