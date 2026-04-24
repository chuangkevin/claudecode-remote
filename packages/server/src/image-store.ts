import { randomUUID } from "node:crypto";

export interface StoredImage {
  base64: string;
  mediaType: string;
  thumbnail: string; // small data URL for history display
}

const images = new Map<string, StoredImage>();

export function storeImage(base64: string, mediaType: string, thumbnail: string): string {
  const id = randomUUID();
  images.set(id, { base64, mediaType, thumbnail });
  return id;
}

export function getImage(id: string): StoredImage | undefined {
  return images.get(id);
}
