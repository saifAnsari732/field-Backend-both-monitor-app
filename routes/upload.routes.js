const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const ImageKit = require('imagekit');
const multer = require('multer');

const getImageKitInstance = () => {
  return new ImageKit({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY || 'public_key_placeholder',
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY || 'private_key_placeholder',
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || 'https://ik.imagekit.io/crmtracker',
  });
};

// Get ImageKit auth params (for client-side direct upload)
router.get('/auth', protect, (req, res) => {
  try {
    const imagekit = getImageKitInstance();
    const result = imagekit.getAuthenticationParameters();
    res.json({ 
      success: true, 
      publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
      urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
      ...result 
    });
  } catch (err) { 
    console.error('ImageKit auth params error:', err);
    res.status(500).json({ success: false, message: err.message }); 
  }
});

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 } // 15 MB limit
});

// Server-side upload to ImageKit (Supports multipart FormData and JSON base64)
router.post('/image', protect, upload.single('image'), async (req, res) => {
  try {
    let fileToUpload = null;
    let fileName = `upload_${Date.now()}.jpg`;
    const folder = req.body.folder || req.query.folder || '/crm-tracker';

    if (req.file) {
      fileToUpload = req.file.buffer;
      fileName = req.file.originalname || fileName;
    } else if (req.body.image || req.body.file || req.body.base64) {
      fileToUpload = req.body.image || req.body.file || req.body.base64;
      if (req.body.fileName) fileName = req.body.fileName;
    }

    if (!fileToUpload) {
      return res.status(400).json({ success: false, message: 'No file or image data provided' });
    }

    const imagekit = getImageKitInstance();
    const response = await imagekit.upload({
      file: fileToUpload,
      fileName: fileName,
      folder: folder,
      useUniqueFileName: true
    });

    return res.json({ 
      success: true, 
      url: response.url, 
      imageUrl: response.url, 
      fileId: response.fileId, 
      thumbnailUrl: response.thumbnailUrl || response.url,
      name: response.name,
      filePath: response.filePath
    });
  } catch (err) { 
    console.error('ImageKit Upload error:', err);
    return res.status(500).json({ success: false, message: err.message || 'ImageKit upload failed' }); 
  }
});

module.exports = router;
