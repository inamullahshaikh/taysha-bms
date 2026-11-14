/**
 * Phone photos (receipts, proof of delivery) are 3-8 MB straight from the camera. Shrink them before upload:
 * a 2000px JPEG is still sharp enough to read a receipt, and typically 10x smaller to store and to download again.
 * Only JPEG/WebP photos over 500 KB are touched; PNG (logos, transparency), PDF and small images go as they are.
 */
const MAX_SIDE = 2000
const MIN_BYTES = 500 * 1024

export async function shrinkPhoto(file: File): Promise<File> {
  if (!['image/jpeg', 'image/webp'].includes(file.type) || file.size < MIN_BYTES) return file
  try {
    const img = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.width * scale)
    canvas.height = Math.round(img.height * scale)
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
    img.close()
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', 0.82))
    if (!blob || blob.size >= file.size) return file
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: file.lastModified })
  } catch {
    return file // an image the browser can't decode is uploaded unchanged
  }
}

/** Shrink every photo in a multipart body (all uploads go through the API client). */
export async function shrinkPhotos(form: FormData): Promise<FormData> {
  const out = new FormData()
  for (const [k, v] of form.entries()) out.append(k, v instanceof File ? await shrinkPhoto(v) : v)
  return out
}
