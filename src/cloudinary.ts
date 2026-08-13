import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Uploads a file buffer to Cloudinary.
 * @param buffer - The image file buffer from multer memory storage
 * @param folder  - Cloudinary folder to store the image in
 * @returns The secure URL of the uploaded image
 */
export function uploadToCloudinary(
  buffer: Buffer,
  folder = 'agrostore/products'
): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'image',
        // Automatically detect format and optimize quality
        fetch_format: 'auto',
        quality: 'auto',
      },
      (error, result) => {
        if (error || !result) {
          return reject(error ?? new Error('Cloudinary upload failed'));
        }
        resolve(result.secure_url);
      }
    );

    stream.end(buffer);
  });
}

export { cloudinary };
